import { readdir, mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { databasePoolConfig, readDatabaseUrl } from "./database-connection.mjs";
import { assertBackupRestoreTarget } from "../../../scripts/backup-restore-target.mjs";
import { classifyPrivateRestoreFailure } from "../../../scripts/private-restore-errors.mjs";
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
  const sourceExtensions = (
    await ledger.query("select extname,extversion from pg_extension order by extname")
  ).rows;
  const extensionPath = process.env.BACKUP_RESTORE_EXTENSION_PATH;
  if (extensionPath && extensionPath !== "/grogoni-restore-extensions/share")
    throw new Error("Restore extension path must use the isolated approved extension volume.");
  if (extensionPath)
    await restored.query(
      "set extension_control_path = '/grogoni-restore-extensions/share:$system'"
    );
  const availableExtensions = (
    await restored.query("select name,version from pg_available_extension_versions")
  ).rows;
  const extensionAudit = sourceExtensions.map((extension) => ({
    name: extension.extname,
    version: extension.extversion,
    available: availableExtensions.some(
      (available) =>
        available.name === extension.extname && available.version === extension.extversion
    )
  }));
  if (
    extensionAudit.some(
      (extension) =>
        !/^[a-z_][a-z0-9_]{0,62}$/.test(extension.name) || !/^[0-9.]{1,20}$/.test(extension.version)
    )
  )
    throw new Error("Source extension metadata requires operator review.");
  console.log(JSON.stringify({ restoreExtensionAudit: extensionAudit }));
  if (extensionAudit.some((extension) => !extension.available))
    throw new Error(
      "Isolated restore is missing an exact source extension version; no full restore is certified."
    );
  await createBackupStorage(readBackupStorageConfig()).download(objectKey, restoredFile);
  await new Promise((complete, reject) => {
    let stderr = "";
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
      {
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 600000,
        env: {
          ...process.env,
          ...(extensionPath
            ? { PGOPTIONS: "-c extension_control_path=/grogoni-restore-extensions/share:$system" }
            : {})
        }
      }
    );
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(0, 8192);
    });
    child.once("error", () => reject(new Error("pg_restore could not start.")));
    child.once("exit", (code) =>
      code === 0
        ? complete()
        : reject(
            new Error(
              `Isolated pg_restore failed (exit ${code}; ${classifyPrivateRestoreFailure(stderr)}).`
            )
          )
    );
  });
  const check = await restored.query(`select
    (select count(*)::int from grogoni_schema_migrations) as migrations,
    to_regclass('public.business_environment_tasks') is not null as tasks,
    to_regclass('public.business_purchase_drafts') is not null as procurement,
    to_regclass('public.grogoni_daemon_tasks') is not null as daemon`);
  const schema = check.rows[0];
  const restoredExtensions = (await restored.query("select extname,extversion from pg_extension"))
    .rows;
  if (
    sourceExtensions.some(
      (source) =>
        !restoredExtensions.some(
          (extension) =>
            extension.extname === source.extname && extension.extversion === source.extversion
        )
    )
  )
    throw new Error(
      "Restored extension versions do not match the source; no full restore is certified."
    );
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
