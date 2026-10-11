import type { DaemonTaskStore } from "./task-store.js";
import { pause, type DaemonEvent } from "./worker.js";

export const defaultDaemonRetentionDays = 30;
const maxRetentionDays = 3650;
const dayMs = 86_400_000;

/**
 * DAEMON_RETENTION_DAYS: how long completed, failed and cancelled tasks (with their prompts and
 * results) stay queryable. Unset means 30 days; 0 keeps them forever. Anything else is a startup
 * error rather than a silent default, because a typo here deletes operator data.
 */
export function daemonRetentionMsFromEnv(value: string | undefined): number | null {
  const raw = value?.trim() ?? "";
  if (raw === "") return defaultDaemonRetentionDays * dayMs;
  if (!/^\d+$/u.test(raw) || Number(raw) > maxRetentionDays)
    throw new Error(`DAEMON_RETENTION_DAYS must be an integer from 0 to ${maxRetentionDays}.`);
  const days = Number(raw);
  return days === 0 ? null : days * dayMs;
}

/**
 * Deletes expired terminal tasks in bounded batches, then sleeps. Queued, running and recurring
 * work is never touched. Safe with several daemons: concurrent deletes of the same rows are no-ops.
 */
export async function runDaemonRetention(input: {
  store: DaemonTaskStore;
  retentionMs: number;
  signal: AbortSignal;
  intervalMs?: number;
  batchSize?: number;
  report?: (event: DaemonEvent) => void;
}): Promise<void> {
  const batchSize = input.batchSize ?? 1000;
  while (!input.signal.aborted) {
    try {
      let deleted = 0;
      let batch: number;
      do {
        batch = await input.store.purge(input.retentionMs, batchSize);
        deleted += batch;
      } while (batch === batchSize && !input.signal.aborted);
      if (deleted > 0) input.report?.({ type: "retention_purged", deleted });
    } catch {
      input.report?.({ type: "retention_failed" });
    }
    await pause(input.intervalMs ?? 3_600_000, input.signal);
  }
}
