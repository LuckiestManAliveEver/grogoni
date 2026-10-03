import { Pool } from "pg";
import { databasePoolConfig, readDatabaseUrl } from "./database-connection.mjs";

const databaseUrl = readDatabaseUrl();

if (databaseUrl === null) {
  console.error("DATABASE_URL or DIRECT_DATABASE_URL is required to check database health.");
  process.exit(1);
}

const pool = new Pool(
  databasePoolConfig(databaseUrl, {
    applicationName: "grogoni-db-health",
    poolMaxFallback: 2
  })
);
const startedAt = Date.now();

try {
  const result = await pool.query(`
    select
      now() as checked_at,
      current_database() as database_name,
      current_user as database_user,
      (
        select count(*)
        from grogoni_schema_migrations
      )::integer as applied_migration_count,
      (
        select filename
        from grogoni_schema_migrations
        order by filename desc
        limit 1
      ) as latest_migration
  `);
  const latencyMs = Date.now() - startedAt;
  const latestMigration = result.rows[0]?.latest_migration ?? null;

  await pool.query(
    `
      insert into database_health_checks (status, latency_ms, latest_migration, checked_at)
      values ('ok', $1, $2, now())
    `,
    [latencyMs, latestMigration]
  );

  console.log(
    JSON.stringify(
      {
        status: "ok",
        latencyMs,
        ...result.rows[0]
      },
      null,
      2
    )
  );
} catch (error) {
  const latencyMs = Date.now() - startedAt;
  const message = error instanceof Error ? error.message : String(error);

  await pool
    .query(
      `
        insert into database_health_checks (status, latency_ms, checked_at, error_message)
        values ('failed', $1, now(), $2)
      `,
      [latencyMs, message]
    )
    .catch(() => undefined);

  console.error(message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
