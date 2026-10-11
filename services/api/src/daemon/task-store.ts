import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type DaemonPayload =
  | { kind: "agent"; message: string; modelId: string; agentAdapterId: "grogoni" | "pi" }
  | { kind: "maintenance"; job: string };

export type DaemonTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export const terminalDaemonTaskStatuses = ["completed", "failed", "cancelled"] as const;

/** Internal row shape. Lease tokens fence workers and must never leave the process. */
export interface DaemonTask {
  id: string;
  idempotency_key: string;
  payload: DaemonPayload;
  status: DaemonTaskStatus;
  run_at: Date;
  attempts: number;
  max_attempts: number;
  executions: number | string;
  lease_token: string | null;
  lease_until: Date | null;
  interval_ms: number | string | null;
  result: unknown;
  error_code: string | null;
  created_at: Date;
  updated_at: Date;
}

/** What operators see over HTTP: no lease token, numeric counters, camelCase names. */
export interface PublicDaemonTask {
  id: string;
  key: string;
  payload: DaemonPayload;
  status: DaemonTaskStatus;
  runAt: string;
  intervalMs: number | null;
  attempts: number;
  maxAttempts: number;
  executions: number;
  leaseUntil: string | null;
  result: unknown;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toPublicDaemonTask(task: DaemonTask): PublicDaemonTask {
  const iso = (value: Date | string) => new Date(value).toISOString();
  return {
    id: task.id,
    key: task.idempotency_key,
    payload: task.payload,
    status: task.status,
    runAt: iso(task.run_at),
    intervalMs: task.interval_ms === null ? null : Number(task.interval_ms),
    attempts: task.attempts,
    maxAttempts: task.max_attempts,
    executions: Number(task.executions),
    leaseUntil: task.lease_until === null ? null : iso(task.lease_until),
    result: task.result,
    errorCode: task.error_code,
    createdAt: iso(task.created_at),
    updatedAt: iso(task.updated_at)
  };
}

export interface DaemonQueueStats {
  counts: Record<DaemonTaskStatus, number>;
  /** Seconds the oldest due, unclaimed task has waited; 0 when the queue is keeping up. */
  oldestDueSeconds: number;
  /** Running tasks whose lease expired without renewal (crashed or stalled workers). */
  expiredLeases: number;
}

export interface DaemonTaskStore {
  enqueue(input: {
    key: string;
    payload: DaemonPayload;
    runAt: Date;
    intervalMs?: number;
    maxAttempts: number;
  }): Promise<DaemonTask>;
  get(id: string): Promise<DaemonTask | null>;
  list(): Promise<DaemonTask[]>;
  retry(id: string): Promise<boolean>;
  cancel(id: string): Promise<boolean>;
  /** Dead-letters expired claims that have no attempts left; returns their IDs. */
  expireExhausted(): Promise<string[]>;
  claim(leaseMs: number): Promise<DaemonTask | null>;
  renew(task: DaemonTask, leaseMs: number): Promise<boolean>;
  settle(
    task: DaemonTask,
    outcome: { result: unknown } | { errorCode: string; retryable: boolean }
  ): Promise<boolean>;
  /** Both return false when the claim was fenced (cancelled, expired or re-claimed elsewhere). */
  release(task: DaemonTask): Promise<boolean>;
  stats(): Promise<DaemonQueueStats>;
  /** Deletes up to `limit` terminal tasks last updated before the cutoff; returns the count. */
  purge(olderThanMs: number, limit: number): Promise<number>;
  health(): Promise<void>;
}

/** Every state transition is fenced by a unique claim token; stale workers cannot overwrite work. */
export function createPostgresDaemonTaskStore(pool: Pool): DaemonTaskStore {
  return {
    async enqueue(input) {
      const result = await pool.query<DaemonTask>(
        `insert into grogoni_daemon_tasks (id,idempotency_key,payload,run_at,interval_ms,max_attempts)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (idempotency_key) do update set idempotency_key=excluded.idempotency_key
         returning *`,
        [
          randomUUID(),
          input.key,
          JSON.stringify(input.payload),
          input.runAt,
          input.intervalMs ?? null,
          input.maxAttempts
        ]
      );
      return result.rows[0]!;
    },
    async get(id) {
      return (
        (await pool.query<DaemonTask>("select * from grogoni_daemon_tasks where id=$1", [id]))
          .rows[0] ?? null
      );
    },
    async cancel(id) {
      return (
        (
          await pool.query(
            // Clearing the token fences the running worker at once; lease_until is kept so retry
            // cannot hand the task to a second worker while the first may still be executing.
            `update grogoni_daemon_tasks set status='cancelled',lease_token=null,updated_at=now()
         where id=$1 and status in ('queued','running')`,
            [id]
          )
        ).rowCount === 1
      );
    },
    async list() {
      return (
        await pool.query<DaemonTask>(
          "select * from grogoni_daemon_tasks order by updated_at desc,id limit 50"
        )
      ).rows;
    },
    async retry(id) {
      return (
        (
          await pool.query(
            `update grogoni_daemon_tasks set status='queued',attempts=0,
        run_at=now(),error_code=null,lease_token=null,lease_until=null,updated_at=now()
        where id=$1 and status in ('failed','cancelled')
          and (lease_until is null or lease_until <= now())`,
            [id]
          )
        ).rowCount === 1
      );
    },
    async expireExhausted() {
      // A claim that expired on its final attempt (worker crashed, or settlement never landed)
      // becomes a visible dead letter: recovering it forever would let a task that kills its
      // worker repeat paid work without bound.
      return (
        await pool.query<{ id: string }>(
          `update grogoni_daemon_tasks set status='failed',error_code='LEASE_EXHAUSTED',
        lease_token=null,lease_until=null,updated_at=now()
        where status='running' and lease_until <= now() and attempts >= max_attempts
        returning id`
        )
      ).rows.map((row) => row.id);
    },
    async claim(leaseMs) {
      return (
        (
          await pool.query<DaemonTask>(
            `with candidate as (
           select id from grogoni_daemon_tasks
           where ((status='queued' and run_at <= now()) or (status='running' and lease_until <= now()))
             and attempts < max_attempts
           order by run_at,id for update skip locked limit 1
         ) update grogoni_daemon_tasks t set status='running',attempts=t.attempts+1,
           lease_token=$1,lease_until=now()+$2::bigint*interval '1 millisecond',updated_at=now()
         from candidate where t.id=candidate.id returning t.*`,
            [randomUUID(), leaseMs]
          )
        ).rows[0] ?? null
      );
    },
    async renew(task, leaseMs) {
      return (
        (
          await pool.query(
            `update grogoni_daemon_tasks set lease_until=now()+$3::bigint*interval '1 millisecond',updated_at=now()
         where id=$1 and lease_token=$2 and status='running' and lease_until > now()`,
            [task.id, task.lease_token, leaseMs]
          )
        ).rowCount === 1
      );
    },
    async settle(task, outcome) {
      const success = "result" in outcome;
      const recurring = success && task.interval_ms !== null;
      const retry = !success && outcome.retryable && task.attempts < task.max_attempts;
      const delay = recurring
        ? Number(task.interval_ms)
        : Math.min(60_000, 1000 * 2 ** task.attempts);
      const settled = await pool.query(
        `update grogoni_daemon_tasks set status=$3,result=$4,error_code=$5,
         attempts=case when $6 then 0 else attempts end,
         executions=executions+case when $7 then 1 else 0 end,
         run_at=case when $8 then now()+$9::bigint*interval '1 millisecond' else run_at end,
         lease_token=null,lease_until=null,updated_at=now()
         where id=$1 and lease_token=$2 and status='running' and lease_until > now()`,
        [
          task.id,
          task.lease_token,
          recurring || retry ? "queued" : success ? "completed" : "failed",
          success ? storableJson(outcome.result) : null,
          success ? null : outcome.errorCode,
          recurring,
          success,
          recurring || retry,
          delay
        ]
      );
      return settled.rowCount === 1;
    },
    async release(task) {
      const released = await pool.query(
        `update grogoni_daemon_tasks set status='queued',attempts=greatest(0,attempts-1),
        lease_token=null,lease_until=null,updated_at=now() where id=$1 and lease_token=$2 and status='running' and lease_until > now()`,
        [task.id, task.lease_token]
      );
      return released.rowCount === 1;
    },
    async stats() {
      const counts: Record<DaemonTaskStatus, number> = {
        queued: 0,
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 0
      };
      const grouped = await pool.query<{ status: DaemonTaskStatus; total: string }>(
        "select status,count(*) as total from grogoni_daemon_tasks group by status"
      );
      for (const row of grouped.rows) counts[row.status] = Number(row.total);
      const health = await pool.query<{ oldest_due_seconds: string | null; expired: string }>(
        `select extract(epoch from now()-min(run_at) filter (where status='queued' and run_at <= now()))
           as oldest_due_seconds,
         count(*) filter (where status='running' and lease_until <= now()) as expired
         from grogoni_daemon_tasks where status in ('queued','running')`
      );
      const row = health.rows[0];
      return {
        counts,
        oldestDueSeconds: Math.max(0, Math.floor(Number(row?.oldest_due_seconds ?? 0))),
        expiredLeases: Number(row?.expired ?? 0)
      };
    },
    async purge(olderThanMs, limit) {
      return (
        (
          await pool.query(
            // The CTE runs once and locks its batch, so the limit is exact and a concurrent retry
            // waits for the purge instead of being overwritten; rows already locked by a retry
            // are skipped. The outer filter re-checks state in case a row changed before locking.
            `with doomed as (
           select id from grogoni_daemon_tasks
           where status in ('completed','failed','cancelled')
             and updated_at < now()-$1::bigint*interval '1 millisecond'
           order by updated_at limit $2 for update skip locked)
         delete from grogoni_daemon_tasks t using doomed
         where t.id = doomed.id
           and t.status in ('completed','failed','cancelled')
           and t.updated_at < now()-$1::bigint*interval '1 millisecond'`,
            [olderThanMs, limit]
          )
        ).rowCount ?? 0
      );
    },
    async health() {
      await pool.query("select id from grogoni_daemon_tasks limit 0");
    }
  };
}

/** PostgreSQL jsonb rejects U+0000; model output can contain it, so store U+FFFD instead. */
function storableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "string" ? item.replaceAll("\u0000", "\uFFFD") : item
  );
}
