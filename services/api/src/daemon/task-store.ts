import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  DaemonLane,
  DaemonPayload,
  DaemonTaskStatus,
  PublicDaemonTask
} from "@grogoni/shared-types";

export type { DaemonLane, DaemonPayload, DaemonTaskStatus, PublicDaemonTask };

/** Anything that runs one statement at a time: a pg Pool, or an Edge connection wrapper. */
export type DaemonQueryable = Pick<Pool, "query">;
/** A queryable that can also hold one connection for a transaction (a pg Pool). */
export type DaemonPool = Pick<Pool, "query" | "connect">;

/** Every migration that shapes grogoni_daemon_tasks, in order (infra/db/migrations). */
export const daemonQueueMigrations = [
  "112_native_daemon.sql",
  "116_daemon_lanes.sql",
  "124_daemon_conversation_delivery.sql"
] as const;

/** How long a user's due task waits for their browser before a server worker takes it. */
export const defaultUserTakeoverMs = 10 * 60_000;

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
  /** Null for operator tasks; set for tasks a signed-in user owns. */
  owner_user_id: string | null;
  lane: DaemonLane | null;
  created_at: Date;
  updated_at: Date;
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
    lane: task.lane ?? null,
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
    /** Makes it a user task. Callers namespace `key` per owner: keys are globally unique. */
    ownerUserId?: string;
  }): Promise<DaemonTask>;
  pendingConversationDeliveries(limit: number): Promise<DaemonTask[]>;
  markConversationDelivered(task: DaemonTask): Promise<void>;
  retryOwned(
    ownerUserId: string,
    id: string,
    maxActive: number
  ): Promise<"queued" | "limited" | "conflict">;
  get(id: string): Promise<DaemonTask | null>;
  list(): Promise<DaemonTask[]>;
  retry(id: string): Promise<boolean>;
  cancel(id: string): Promise<boolean>;
  /** Dead-letters expired claims that have no attempts left; returns their IDs. */
  expireExhausted(): Promise<string[]>;
  /**
   * Server claim: operator tasks as soon as they are due, user tasks only once they have waited
   * past the takeover delay (their browser had first chance). Records lane 'server'.
   */
  claim(leaseMs: number): Promise<DaemonTask | null>;
  /** Browser claim: one due task of this owner, no takeover delay. Records lane 'browser'. */
  claimOwned(ownerUserId: string, leaseMs: number): Promise<DaemonTask | null>;
  getOwned(ownerUserId: string, id: string): Promise<DaemonTask | null>;
  listOwned(ownerUserId: string, limit: number): Promise<DaemonTask[]>;
  cancelOwned(ownerUserId: string, id: string): Promise<boolean>;
  /** Milliseconds until this owner's next task is claimable by their browser; null if none. */
  nextOwnedDueInMs(ownerUserId: string): Promise<number | null>;
  /**
   * The per-user cap's count: queued and running tasks, plus cancelled ones whose run may still
   * be in flight (their lease has not ended).
   */
  countActiveOwned(ownerUserId: string): Promise<number>;
  /**
   * Adds a user task, or returns the existing one for its key, atomically per owner: concurrent
   * calls can neither pass the cap together nor both report creating the same key.
   */
  enqueueOwned(
    input: Parameters<DaemonTaskStore["enqueue"]>[0] & { ownerUserId: string },
    maxActive: number
  ): Promise<{ task: DaemonTask; created: boolean } | { limited: true }>;
  /**
   * Swaps a live claim's lease token for a fresh one with a new lease length. Exactly one caller
   * holding the old token wins; it alone may run the task. Null when the claim is gone.
   */
  rotateLease(task: DaemonTask, leaseMs: number): Promise<DaemonTask | null>;
  /**
   * After a cancelled task's in-flight run has stopped: drops the lease that kept it counting
   * toward its owner's cap (cancel keeps it so that nothing re-runs the task meanwhile).
   */
  clearCancelledLease(task: DaemonTask): Promise<void>;
  /**
   * The earliest instant a server worker could have something to do (a due operator task, a user
   * task past its takeover delay, or a lease to recover), or null when the queue is empty.
   */
  nextServerDueAt(): Promise<Date | null>;
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
export function createPostgresDaemonTaskStore(
  pool: DaemonPool,
  options: { userTakeoverMs?: number } = {}
): DaemonTaskStore {
  const takeoverMs = options.userTakeoverMs ?? defaultUserTakeoverMs;
  if (!Number.isSafeInteger(takeoverMs) || takeoverMs < 0)
    throw new Error("userTakeoverMs must be a non-negative integer.");
  const claimWhere = async (where: string, values: unknown[], lane: DaemonLane, leaseMs: number) =>
    (
      await pool.query<DaemonTask>(
        `with candidate as (
           select id from grogoni_daemon_tasks
           where ${where} and attempts < max_attempts
           order by run_at,id for update skip locked limit 1
         ) update grogoni_daemon_tasks t set status='running',attempts=t.attempts+1,lane=$3,
           lease_token=$1,lease_until=now()+$2::bigint*interval '1 millisecond',updated_at=now()
         from candidate where t.id=candidate.id returning t.*`,
        [randomUUID(), leaseMs, lane, ...values]
      )
    ).rows[0] ?? null;
  return {
    async enqueue(input) {
      const result = await pool.query<DaemonTask>(
        `insert into grogoni_daemon_tasks
           (id,idempotency_key,payload,run_at,interval_ms,max_attempts,owner_user_id)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (idempotency_key) do update set idempotency_key=excluded.idempotency_key
         returning *`,
        [
          randomUUID(),
          input.key,
          JSON.stringify(input.payload),
          input.runAt,
          input.intervalMs ?? null,
          input.maxAttempts,
          input.ownerUserId ?? null
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
    async pendingConversationDeliveries(limit) {
      return (
        await pool.query<DaemonTask>(
          `select * from grogoni_daemon_tasks
        where owner_user_id is not null and payload->'conversation' is not null
          and status in ('completed','failed','cancelled')
          and (conversation_delivered_at is null or conversation_delivered_at < updated_at)
        order by updated_at,id limit $1`,
          [limit]
        )
      ).rows;
    },
    async markConversationDelivered(task) {
      await pool.query(
        `update grogoni_daemon_tasks set conversation_delivered_at=updated_at
        where id=$1 and date_trunc('milliseconds',updated_at)=$2 and status=$3 and attempts=$4 and executions=$5`,
        [task.id, task.updated_at, task.status, task.attempts, task.executions]
      );
    },
    async retryOwned(ownerUserId, id, maxActive) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `grogoni_daemon_owner:${ownerUserId}`
        ]);
        const row = (
          await client.query<DaemonTask>(
            "select * from grogoni_daemon_tasks where id=$1 and owner_user_id=$2 for update",
            [id, ownerUserId]
          )
        ).rows[0];
        // Replaying a retry while queued/running is idempotent and never resets its lease.
        if (row && (row.status === "queued" || row.status === "running")) {
          await client.query("commit");
          return "queued";
        }
        const active = await client.query<{ total: string }>(
          `select count(*) as total from grogoni_daemon_tasks where owner_user_id=$1 and (status in ('queued','running') or (status='cancelled' and lease_until > now()))`,
          [ownerUserId]
        );
        if (Number(active.rows[0]?.total ?? 0) >= maxActive) {
          await client.query("commit");
          return "limited";
        }
        const updated = await client.query(
          `update grogoni_daemon_tasks set status='queued',attempts=0,result=null,
          run_at=now(),error_code=null,lease_token=null,lease_until=null,conversation_delivered_at=null,updated_at=now()
          where id=$1 and owner_user_id=$2 and status in ('failed','cancelled') and (lease_until is null or lease_until <= now())`,
          [id, ownerUserId]
        );
        await client.query("commit");
        return updated.rowCount === 1 ? "queued" : "conflict";
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
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
      // $4: takeover delay. A user task's server due time is its due time plus that delay.
      return claimWhere(
        `((status='queued' and run_at <= now()-case when owner_user_id is null then interval '0'
             else $4::bigint*interval '1 millisecond' end)
          or (status='running' and lease_until <= now()-case when owner_user_id is null
             then interval '0' else $4::bigint*interval '1 millisecond' end))`,
        [takeoverMs],
        "server",
        leaseMs
      );
    },
    async claimOwned(ownerUserId, leaseMs) {
      return claimWhere(
        `owner_user_id=$4 and ((status='queued' and run_at <= now())
          or (status='running' and lease_until <= now()))`,
        [ownerUserId],
        "browser",
        leaseMs
      );
    },
    async getOwned(ownerUserId, id) {
      return (
        (
          await pool.query<DaemonTask>(
            "select * from grogoni_daemon_tasks where id=$1 and owner_user_id=$2",
            [id, ownerUserId]
          )
        ).rows[0] ?? null
      );
    },
    async listOwned(ownerUserId, limit) {
      return (
        await pool.query<DaemonTask>(
          `select * from grogoni_daemon_tasks where owner_user_id=$1
           order by updated_at desc,id limit $2`,
          [ownerUserId, limit]
        )
      ).rows;
    },
    async cancelOwned(ownerUserId, id) {
      return (
        (
          await pool.query(
            `update grogoni_daemon_tasks set status='cancelled',lease_token=null,updated_at=now()
             where id=$1 and owner_user_id=$2 and status in ('queued','running')`,
            [id, ownerUserId]
          )
        ).rowCount === 1
      );
    },
    async nextOwnedDueInMs(ownerUserId) {
      // The same predicate claimOwned uses, as a delay: queued at run_at, running at lease end.
      const result = await pool.query<{ due_in_ms: string | null }>(
        // greatest() ignores NULL, so "nothing queued" must stay NULL outside it, not become 0.
        `select case when due is null then null
           else greatest(0, ceil(extract(epoch from due - now()) * 1000)) end as due_in_ms
         from (select min(case when status='queued' then run_at else lease_until end) as due
         from grogoni_daemon_tasks
         where owner_user_id=$1 and status in ('queued','running') and attempts < max_attempts
         ) as owned`,
        [ownerUserId]
      );
      const value = result.rows[0]?.due_in_ms ?? null;
      return value === null ? null : Number(value);
    },
    async countActiveOwned(ownerUserId) {
      const result = await pool.query<{ total: string }>(
        `select count(*) as total from grogoni_daemon_tasks
         where owner_user_id=$1 and (status in ('queued','running')
           or (status='cancelled' and lease_until > now()))`,
        [ownerUserId]
      );
      return Number(result.rows[0]?.total ?? 0);
    },
    async nextServerDueAt() {
      // Exactly what claim and expireExhausted act on: a claimable task at its due time (plus
      // the takeover delay for a user's), and an exhausted claim when its lease ends (no delay).
      const result = await pool.query<{ next_due_at: Date | null }>(
        `select min(case
           when attempts >= max_attempts then
             case when status='running' then lease_until end
           else (case when status='queued' then run_at else lease_until end)
             + case when owner_user_id is null then interval '0'
               else $1::bigint*interval '1 millisecond' end
         end) as next_due_at
         from grogoni_daemon_tasks where status in ('queued','running')`,
        [takeoverMs]
      );
      const value = result.rows[0]?.next_due_at ?? null;
      return value === null ? null : new Date(value);
    },
    async enqueueOwned(input, maxActive) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `grogoni_daemon_owner:${input.ownerUserId}`
        ]);
        const existing = await client.query<DaemonTask>(
          "select * from grogoni_daemon_tasks where idempotency_key=$1",
          [input.key]
        );
        if (existing.rows[0]) {
          await client.query("commit");
          return { task: existing.rows[0], created: false };
        }
        const active = await client.query<{ total: string }>(
          `select count(*) as total from grogoni_daemon_tasks
           where owner_user_id=$1 and (status in ('queued','running')
             or (status='cancelled' and lease_until > now()))`,
          [input.ownerUserId]
        );
        if (Number(active.rows[0]?.total ?? 0) >= maxActive) {
          await client.query("commit");
          return { limited: true as const };
        }
        const inserted = await client.query<DaemonTask>(
          `insert into grogoni_daemon_tasks
             (id,idempotency_key,payload,run_at,interval_ms,max_attempts,owner_user_id)
           values ($1,$2,$3,$4,$5,$6,$7)
           on conflict (idempotency_key) do update set idempotency_key=excluded.idempotency_key
           returning *, (xmax = 0) as inserted`,
          [
            randomUUID(),
            input.key,
            JSON.stringify(input.payload),
            input.runAt,
            input.intervalMs ?? null,
            input.maxAttempts,
            input.ownerUserId
          ]
        );
        await client.query("commit");
        const { inserted: created, ...task } = inserted.rows[0]! as DaemonTask & {
          inserted: boolean;
        };
        return { task, created };
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async rotateLease(task, leaseMs) {
      return (
        (
          await pool.query<DaemonTask>(
            `update grogoni_daemon_tasks set lease_token=$3,
               lease_until=now()+$4::bigint*interval '1 millisecond',updated_at=now()
             where id=$1 and lease_token=$2 and status='running' and lease_until > now()
             returning *`,
            [task.id, task.lease_token, randomUUID(), leaseMs]
          )
        ).rows[0] ?? null
      );
    },
    async clearCancelledLease(task) {
      await pool.query(
        `update grogoni_daemon_tasks set lease_until=null,updated_at=now()
         where id=$1 and status='cancelled' and lease_token is null`,
        [task.id]
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
             and (payload->'conversation' is null or owner_user_id is null or conversation_delivered_at >= updated_at)
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
