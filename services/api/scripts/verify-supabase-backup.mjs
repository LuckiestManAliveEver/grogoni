import { readdir, mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { databasePoolConfig, readDatabaseUrl } from "./database-connection.mjs";
import { assertBackupRestoreTarget } from "../../../scripts/backup-restore-target.mjs";
import {
  createBackupStorage,
  readBackupStorageConfig
} from "../../../scripts/supabase-backup-storage.mjs";

const target = assertBackupRestoreTarget(process.env.BACKUP_RESTORE_TEST_DATABASE_URL);
const databaseUrl = readDatabaseUrl();
if (!databaseUrl)
  throw new Error("Source database configuration is required to record the restore drill.");
const rootDir = fileURLToPath(new URL("../../..", import.meta.url));
const backupDir = resolve(process.env.BACKUP_DIR ?? resolve(rootDir, "backups"));
const files = (await readdir(backupDir)).filter((name) => /^grogoni-[0-9TZ-]+\.dump$/.test(name));
if (files.length !== 1)
  throw new Error("The isolated backup run must contain exactly one source dump.");
const objectKey = `neon/${files[0]}.enc`;
await mkdir(backupDir, { recursive: true, mode: 0o700 });
const temporary = await mkdtemp(join(backupDir, ".restore-"));
const restoredFile = join(temporary, "restored.dump");
const ledger = new Pool(
  databasePoolConfig(databaseUrl, { applicationName: "grogoni-backup-restore-drill", max: 1 })
);
const restored = new Pool(
  databasePoolConfig(target, { applicationName: "grogoni-isolated-restore", max: 1 })
);
async function record(status) {
  await ledger.query(
    "insert into database_restore_drills (id, backup_file, status, checked_at) values ($1,$2,$3,now())",
    [randomUUID(), objectKey, status]
  );
}
try {
  await createBackupStorage(readBackupStorageConfig()).download(objectKey, restoredFile);
  await new Promise((complete, reject) => {
    const child = spawn(
      "pg_restore",
      [
        "--exit-on-error",
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-privileges",
        "--dbname",
        target,
        restoredFile
      ],
      { stdio: "ignore", timeout: 600000 }
    );
    child.once("error", () => reject(new Error("pg_restore could not start.")));
    child.once("exit", (code) =>
      code === 0 ? complete() : reject(new Error(`Isolated pg_restore failed (exit ${code}).`))
    );
  });
  const check = await restored.query(`select
    (select count(*)::int from grogoni_schema_migrations) as migrations,
    to_regclass('public.business_environment_tasks') is not null as tasks,
    to_regclass('public.business_purchase_drafts') is not null as procurement,
    to_regclass('public.grogoni_daemon_tasks') is not null as daemon`);
  const schema = check.rows[0];
  if (!schema || schema.migrations < 1 || !schema.tasks || !schema.procurement || !schema.daemon)
    throw new Error("Restored backup is missing the expected application schema.");
  await record("verified");
  console.log(JSON.stringify({ status: "verified", objectKey, fullDatabaseRestore: true, schema }));
} catch (error) {
  await record("failed").catch(() => undefined);
  throw error;
} finally {
  await restored.end();
  await ledger.end();
  await rm(temporary, { recursive: true, force: true });
}
