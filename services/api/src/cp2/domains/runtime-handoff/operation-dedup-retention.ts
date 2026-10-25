import type { RuntimeOperationDedupRecord } from "./store.js";

/**
 * How long an idempotency record (cp2_runtime_operation_dedup) answers a retry. A record only
 * has to outlive a client's retry of the same request: the web app retries within minutes, and an
 * offline sync retried after a lost response is safe without one (synced checkpoints are kept,
 * see checkpoint-retention.ts). Older records are not consulted and are deleted on the next write
 * that records an operation, at most `runtimeOperationDedupPruneBatch` per write, oldest first:
 * in memory here, and on Edge also from storage (postgres-store.ts), since an Edge request loads
 * only unexpired records of its own account (and of the task it names).
 */
export const runtimeOperationDedupRetentionDays = 7;
export const runtimeOperationDedupPruneBatch = 200;

export function runtimeOperationDedupCutoff(now: Date): string {
  return new Date(now.getTime() - runtimeOperationDedupRetentionDays * 86_400_000).toISOString();
}

export function runtimeOperationDedupExpired(record: RuntimeOperationDedupRecord, now: Date) {
  return record.createdAt < runtimeOperationDedupCutoff(now);
}

/** The same cutoff as SQL, an ISO string compared with the record's `createdAt`. */
export const runtimeOperationDedupCutoffSql = `to_char((now() - interval '${runtimeOperationDedupRetentionDays} days') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
