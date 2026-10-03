import type { PoolConfig } from "pg";
import { positiveIntegerFromEnv } from "@grogoni/resource-control";

/**
 * The one shared source of truth for every `pg.Pool` this process creates (`cp2_primary`,
 * `cp2_realtime`, `model_artifact_store`). Before this module existed, `postgres-store.ts` had
 * its own private `poolConfig()` and `index.ts` built the artifact pool with a bare
 * `{ connectionString, max: 2 }` - no `connectionTimeoutMillis`/`query_timeout`/
 * `statement_timeout` at all, meaning a hung artifact-store query could hold one of only two
 * connections indefinitely. See docs/architecture/resource-isolation-audit.md §1.
 *
 * Every pool still gets its own `max` (a shared *config shape*, not a shared *budget* - each
 * pool protects a different resource and is sized independently), but timeouts, SSL detection,
 * and `application_name` are never duplicated again.
 */
export function buildPgPoolConfig(
  databaseUrl: string,
  overrides: { max?: number } = {}
): PoolConfig {
  const connectionString = normalizeDatabaseSslMode(databaseUrl);
  const sslRequired =
    !/[?&]sslmode=/i.test(connectionString) &&
    (connectionString.includes(".neon.tech") || connectionString.includes(".neon.database"));

  return {
    application_name: process.env.DB_APPLICATION_NAME ?? "grogoni",
    connectionString,
    connectionTimeoutMillis: positiveIntegerFromEnv("DB_CONNECTION_TIMEOUT_MS", 5000),
    idleTimeoutMillis: positiveIntegerFromEnv("DB_IDLE_TIMEOUT_MS", 30000),
    max: overrides.max ?? positiveIntegerFromEnv("DB_POOL_MAX", 5),
    query_timeout: positiveIntegerFromEnv("DB_QUERY_TIMEOUT_MS", 15000),
    statement_timeout: positiveIntegerFromEnv("DB_STATEMENT_TIMEOUT_MS", 15000),
    ...(sslRequired ? { ssl: true } : {})
  };
}

function normalizeDatabaseSslMode(connectionString: string): string {
  return connectionString
    .trim()
    .replace(/([?&])sslmode=(?:prefer|require|verify-ca)(?=&|$)/gi, "$1sslmode=verify-full");
}
