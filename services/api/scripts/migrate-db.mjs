import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { Pool } from "pg";
import {
  databasePoolConfig,
  describeDatabaseTarget,
  isAcceptedMigrationChecksum,
  readSchemaChangeDatabaseUrl
} from "./database-connection.mjs";

const rootDir = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const migrationsDir = resolve(rootDir, "infra/db/migrations");
let databaseUrl;
try {
  databaseUrl = readSchemaChangeDatabaseUrl();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
if (databaseUrl === null) {
  console.error(
    "MIGRATION_DATABASE_URL, DIRECT_DATABASE_URL or DATABASE_URL is required to run database migrations."
  );
  process.exit(1);
}
console.log(`Migrating ${describeDatabaseTarget(databaseUrl)}`);

const pool = new Pool(
  databasePoolConfig(databaseUrl, {
    applicationName: "grogoni-migrate",
    max: 2,
    useQueryTimeouts: false
  })
);

try {
  await ensureMigrationTable();
  const migrations = await listMigrations();

  await withAdvisoryLock(async () => {
    for (const migration of migrations) {
      const alreadyApplied = await pool.query(
        "select checksum from grogoni_schema_migrations where filename = $1",
        [migration.filename]
      );

      if (alreadyApplied.rows.length > 0) {
        const appliedChecksum = alreadyApplied.rows[0]?.checksum;

        if (!isAcceptedMigrationChecksum(migration.filename, appliedChecksum, migration.checksum)) {
          throw new Error(
            `Migration checksum mismatch for ${migration.filename}. Refusing to continue.`
          );
        }

        continue;
      }

      const startedAt = Date.now();
      const client = await pool.connect();

      try {
        await client.query("begin");
        await client.query(migration.sql);
        await client.query(
          `
            insert into grogoni_schema_migrations (filename, checksum, applied_at, duration_ms)
            values ($1, $2, now(), $3)
          `,
          [migration.filename, migration.checksum, Date.now() - startedAt]
        );
        await client.query("commit");
        console.log(`Applied migration ${migration.filename}`);
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration ${migration.filename} failed: ${detail}`, { cause: error });
      } finally {
        client.release();
      }
    }
  });

  console.log("Database migrations are up to date.");
} finally {
  await pool.end();
}

async function ensureMigrationTable() {
  await pool.query(`
    create table if not exists grogoni_schema_migrations (
      filename text primary key,
      checksum text not null,
      applied_at timestamp with time zone not null,
      duration_ms integer not null
    )
  `);
}

async function withAdvisoryLock(callback) {
  const client = await pool.connect();

  try {
    await client.query("select pg_advisory_lock(hashtext('grogoni.schema_migrations'))");
    return await callback();
  } finally {
    await client
      .query("select pg_advisory_unlock(hashtext('grogoni.schema_migrations'))")
      .catch(() => undefined);
    client.release();
  }
}

async function listMigrations() {
  const entries = await readdir(migrationsDir);
  const filenames = entries.filter((entry) => entry.endsWith(".sql")).sort();

  return Promise.all(
    filenames.map(async (filename) => {
      const sql = await readFile(resolve(migrationsDir, filename), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");

      return {
        checksum,
        filename,
        sql
      };
    })
  );
}
