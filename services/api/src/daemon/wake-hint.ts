import type { DaemonQueryable } from "./task-store.js";

/**
 * The wake hint lets Supabase Cron decide, inside the Supabase project's own Postgres, whether a
 * server worker has anything to do, so an idle minute touches neither Neon nor the Edge function
 * (docs/deployment/daemon-lanes.md). It lives in `grogoni_internal.daemon_wake`, created by the
 * schedule SQL (edge-job-schedule.ts), one row with id 1.
 *
 * The hint is conservative by construction: it may say "wake" when nothing is due (one spurious
 * run), never "sleep" when something is. Two writers keep that true without comparing clocks:
 *  - lower(at): after a task is added or re-queued (and committed in Neon), move the hint earlier
 *    and bump `version`. Never moves it later.
 *  - set(at, version): a worker run read `version` before it computed the next due time from
 *    Neon; it writes that value only if no lower() landed since. Otherwise the earlier, lowered
 *    value stays and the next tick wakes a fresh run that recomputes it.
 * A write that fails (Supabase unreachable) leaves the hint stale; the hourly unconditional sweep
 * (the daemon_worker job's own schedule) recomputes it.
 */
export interface DaemonWakeHint {
  version(): Promise<number>;
  lower(at: Date): Promise<void>;
  set(at: Date | null, version: number): Promise<boolean>;
}

export const wakeHintTable = "grogoni_internal.daemon_wake";

export function createPostgresWakeHint(database: DaemonQueryable): DaemonWakeHint {
  return {
    async version() {
      const result = await database.query<{ version: string }>(
        `select version from ${wakeHintTable} where id = 1`
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error("The daemon wake hint row is missing.");
      return Number(row.version);
    },
    async lower(at) {
      await database.query(
        // least() ignores NULL, so an empty hint takes the new instant.
        `update ${wakeHintTable} set next_due_at = least(next_due_at, $1),
           version = version + 1, updated_at = now() where id = 1`,
        [at]
      );
    },
    async set(at, version) {
      const result = await database.query(
        `update ${wakeHintTable} set next_due_at = $1, updated_at = now()
         where id = 1 and version = $2`,
        [at, version]
      );
      return result.rowCount === 1;
    }
  };
}
