import type { DaemonTask, DaemonTaskStore } from "./task-store.js";

/**
 * Runs one task. It must stop promptly when `signal` aborts (the real executors pass it to
 * fetch): callers stop waiting at their deadline, and a run that ignored the abort could still be
 * going when the task is handed to another worker.
 */
export interface DaemonExecutor {
  (task: DaemonTask, signal: AbortSignal): Promise<unknown>;
}

/** Lifecycle log line. Carries identifiers and outcomes only, never prompts or credentials. */
export interface DaemonEvent {
  type: string;
  taskId?: string;
  attempt?: number;
  durationMs?: number;
  errorCode?: string;
  deleted?: number;
}

export class DaemonTaskError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean
  ) {
    super(code);
  }
}

/** One sequential worker per instance. Scale with replicas; PostgreSQL claims serialize ownership. */
export async function runDaemonWorker(input: {
  store: DaemonTaskStore;
  execute: DaemonExecutor;
  signal: AbortSignal;
  pollMs?: number;
  leaseMs?: number;
  taskTimeoutMs?: number;
  /** How long in-flight work may keep running after shutdown starts before it is aborted. */
  shutdownGraceMs?: number;
  /**
   * Bounded runs (an Edge job): a performance.now() instant after which no task may still be
   * running. A task is claimed only while a full taskTimeoutMs fits before it.
   */
  runUntil?: number;
  /** Return when the queue has nothing due instead of polling (an Edge job's run ends). */
  exitWhenIdle?: boolean;
  report?: (event: DaemonEvent) => void;
}): Promise<void> {
  const leaseMs = input.leaseMs ?? 30_000;
  const taskTimeoutMs = input.taskTimeoutMs ?? 130_000;
  while (!input.signal.aborted) {
    if (input.runUntil !== undefined && performance.now() + taskTimeoutMs > input.runUntil) return;
    let task: DaemonTask | null;
    // Taken before the claim runs: the database lease starts no earlier than this instant.
    // performance.now() is monotonic, so wall-clock adjustments cannot stretch the estimate.
    const claimSentAt = performance.now();
    try {
      for (const taskId of await input.store.expireExhausted())
        input.report?.({ type: "lease_exhausted", taskId, errorCode: "LEASE_EXHAUSTED" });
      task = await input.store.claim(leaseMs);
    } catch {
      input.report?.({ type: "queue_unavailable" });
      if (input.exitWhenIdle) return;
      await pause(input.pollMs ?? 1000, input.signal);
      continue;
    }
    if (!task) {
      if (input.exitWhenIdle) return;
      await pause(input.pollMs ?? 1000, input.signal);
      continue;
    }
    if (input.runUntil !== undefined && performance.now() + taskTimeoutMs > input.runUntil) {
      // The claim itself was slow: the task no longer fits, so hand it back unstarted.
      await input.store.release(task).catch(() => undefined);
      return;
    }
    if (input.signal.aborted) {
      // Shutdown arrived while claiming: hand the task straight back rather than start new work.
      await input.store.release(task).catch(() => undefined);
      break;
    }
    const controller = new AbortController();
    // Shutdown stops new claims at once but lets the current task finish within the grace period,
    // so nearly-complete (possibly paid) work settles instead of being repeated by another worker.
    let shutdownAbort = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const abortForShutdown = () => {
      shutdownAbort = true;
      controller.abort();
    };
    const shutdown = () => {
      const graceMs = input.shutdownGraceMs ?? 0;
      if (graceMs <= 0) abortForShutdown();
      else grace = setTimeout(abortForShutdown, graceMs);
    };
    input.signal.addEventListener("abort", shutdown, { once: true });
    if (input.signal.aborted) shutdown();
    let lostLease = false;
    // When the claim or last successful renewal was *sent*: the database set lease_until to at
    // least this plus leaseMs, so measuring from here can only underestimate how long it is held.
    let ownedAt = claimSentAt;
    let renewing = false;
    const heartbeat = setInterval(
      () => {
        // Renewals that error or hang are tolerated while the last success still covers the
        // lease. Past half the lease since the last accepted send, the claim is abandoned (by
        // 3/4 of the lease at worst) before another worker can take it.
        if (!lostLease && performance.now() - ownedAt >= leaseMs / 2) {
          lostLease = true;
          controller.abort();
          return;
        }
        if (renewing) return;
        renewing = true;
        const sentAt = performance.now();
        void input.store
          .renew(task!, leaseMs)
          .then((owned) => {
            if (owned) ownedAt = Math.max(ownedAt, sentAt);
            else {
              lostLease = true;
              controller.abort();
            }
          })
          .catch(() => {
            /* Transient; the staleness check above decides when the claim is lost. */
          })
          .finally(() => {
            renewing = false;
          });
      },
      // Checked every quarter lease, abandonment happens by 3/4 of the lease at the latest.
      Math.max(10, Math.floor(leaseMs / 4))
    );
    const deadline = setTimeout(
      () => controller.abort(new DaemonTaskError("TASK_TIMEOUT", true)),
      taskTimeoutMs
    );
    let abortListener: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", abortListener, { once: true });
      if (controller.signal.aborted) abortListener();
    });
    const started = Date.now();
    const taskId = task.id;
    const attempt = task.attempts;
    input.report?.({ type: "task_started", taskId, attempt });
    let outcome: { result: unknown } | { errorCode: string; retryable: boolean };
    let interrupted = false;
    try {
      outcome = {
        result: await Promise.race([
          Promise.resolve().then(() => {
            controller.signal.throwIfAborted();
            return input.execute(task!, controller.signal);
          }),
          aborted
        ])
      };
    } catch (error) {
      interrupted = shutdownAbort && !lostLease;
      outcome = {
        errorCode: lostLease
          ? "LEASE_LOST"
          : interrupted
            ? "SHUTDOWN"
            : error instanceof DaemonTaskError
              ? error.code
              : "TASK_EXECUTION_FAILED",
        retryable: error instanceof DaemonTaskError && error.retryable
      };
    }
    // A finished result is settled even if shutdown began meanwhile: releasing it would make the
    // next worker repeat a completed (possibly paid) call. Only a lost lease discards an outcome.
    try {
      // Decided before awaiting: a renewal racing a successful settle must not relabel it.
      const abandoned = lostLease;
      const owned = abandoned
        ? false
        : interrupted
          ? await input.store.release(task)
          : await settleStorably(input.store, task, outcome);
      input.report?.({
        type: abandoned
          ? "lease_lost"
          : !owned
            ? "task_settle_fenced"
            : interrupted
              ? "task_interrupted"
              : "result" in outcome
                ? "task_finished"
                : "task_failed",
        taskId,
        attempt,
        durationMs: Date.now() - started,
        ...("errorCode" in outcome ? { errorCode: outcome.errorCode } : {})
      });
    } catch {
      // The lease expires and another worker re-runs the task (at-least-once).
      input.report?.({ type: "task_settlement_failed", taskId, attempt });
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
      clearTimeout(grace);
      input.signal.removeEventListener("abort", shutdown);
      controller.signal.removeEventListener("abort", abortListener);
    }
  }
}

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

/**
 * A PostgreSQL data exception (SQLSTATE class 22) on settlement is permanent for that result:
 * retrying would repeat the paid work forever. Record a clear dead letter instead.
 */
export async function settleStorably(
  store: DaemonTaskStore,
  task: DaemonTask,
  outcome: { result: unknown } | { errorCode: string; retryable: boolean }
): Promise<boolean> {
  // A transient failure is retried a few times while the lease (still renewed by the heartbeat)
  // holds, so one database blip does not repeat completed paid work. Settlement is fenced, so a
  // retry after a lost reply cannot double-write; it simply reports the claim as already settled.
  for (let attempt = 1; ; attempt++) {
    try {
      return await store.settle(task, outcome);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code === "string" && code.startsWith("22"))
        return store.settle(task, { errorCode: "RESULT_NOT_STORABLE", retryable: false });
      if (attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}
