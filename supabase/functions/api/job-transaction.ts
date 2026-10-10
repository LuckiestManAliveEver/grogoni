interface JobClient {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  end: () => Promise<void>;
}

/**
 * A background job's transaction (services/api/src/edge-job-runner.ts). The per-job try-lock comes
 * first: an overlapping trigger sees it held and returns at once. Taking the store lock first
 * would queue the overlap behind the running job, and it would run again after the commit. Jobs
 * are token-guarded and never rate limited, so there is no rate-limit step.
 */
export function createJobTransaction<Client extends JobClient>(options: {
  connect: () => Promise<Client>;
  onFailure: (stage: string, error: unknown) => void;
}) {
  return async <T>(
    {
      lockKey,
      storeLock,
      idle
    }: {
      lockKey: string;
      storeLock: boolean;
      /** A cheap check, run before the store lock: true means there is nothing to do. */
      idle?: (client: Client) => Promise<boolean>;
    },
    action: (client: Client) => Promise<T>
  ): Promise<
    { acquired: true; result: T } | { acquired: true; idle: true } | { acquired: false }
  > => {
    let client: Client | undefined;
    let stage = "connect";
    try {
      client = await options.connect();
      stage = "begin";
      await client.query("begin");
      await client.query("set local lock_timeout = '10s'");
      stage = "job_lock";
      const lock = await client.query(
        "select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as acquired",
        [lockKey]
      );
      if (lock.rows[0]?.acquired !== true) {
        await client.query("commit");
        return { acquired: false };
      }
      if (idle !== undefined) {
        stage = "idle_check";
        if (await idle(client)) {
          await client.query("commit");
          return { acquired: true, idle: true };
        }
      }
      if (storeLock) {
        stage = "store_lock";
        await client.query(
          "select pg_advisory_xact_lock(hashtext('grogoni.cp2.normalized_store'))"
        );
      }
      stage = "action";
      const result = await action(client);
      stage = "commit";
      await client.query("commit");
      return { acquired: true, result };
    } catch (error) {
      options.onFailure(stage, error);
      await client?.query("rollback").catch(() => {});
      throw error;
    } finally {
      await client?.end();
    }
  };
}
