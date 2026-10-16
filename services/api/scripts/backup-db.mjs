import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath, URL } from "node:url";
import { Pool } from "pg";
import { databasePoolConfig, readDatabaseUrl } from "./database-connection.mjs";

const rootDir = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const backupDir = resolve(process.env.BACKUP_DIR ?? resolve(rootDir, "backups"));
const databaseUrl = readDatabaseUrl();
const uploadCommand = process.env.BACKUP_UPLOAD_COMMAND;
const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS ?? "14");

if (process.env.NODE_ENV === "production" && isBlank(uploadCommand)) {
  console.error(
    "BACKUP_UPLOAD_COMMAND is required in production so scheduled backups leave ephemeral runtime storage."
  );
  process.exit(1);
}

if (databaseUrl === null) {
  console.error("DATABASE_URL or DIRECT_DATABASE_URL is required to create a database backup.");
  process.exit(1);
}

if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
  console.error("BACKUP_RETENTION_DAYS must be a positive integer.");
  process.exit(1);
}

await mkdir(backupDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputPath = resolve(backupDir, `grogoni-${stamp}.dump`);
const runId = randomUUID();
const startedAt = new Date();
const pool = new Pool(
  databasePoolConfig(databaseUrl, {
    applicationName: "grogoni-backup",
    max: 1
  })
);

await recordBackupStarted();

const child = spawn(
  "pg_dump",
  ["--format=custom", "--no-owner", "--file", outputPath, databaseUrl],
  {
    stdio: "inherit"
  }
);

let finished = false;
child.on("error", async () => {
  if (finished) return;
  finished = true;
  console.error("pg_dump could not start; no successful backup was recorded.");
  await recordBackupFailed("pg_dump could not start.").catch(() => undefined);
  await pool.end();
  process.exitCode = 1;
});

child.on("exit", async (code) => {
  if (finished) return;
  finished = true;
  if (code !== 0) {
    await recordBackupFailed(`pg_dump failed with exit code ${code ?? 1}.`).catch(() => undefined);
    await pool.end();
    process.exit(code ?? 1);
  }

  console.log(`Database backup written to ${outputPath}`);

  try {
    if (!isBlank(uploadCommand)) {
      await runUploadCommand(uploadCommand, outputPath);
    }

    await pruneOldLocalBackups();
    await recordBackupSucceeded();
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error(error);
    await recordBackupFailed(error instanceof Error ? error.message : String(error)).catch(
      () => undefined
    );
    await pool.end();
    process.exit(1);
  }
});

async function runUploadCommand(commandTemplate, filePath) {
  const command = commandTemplate.replaceAll("{file}", filePath);
  const upload = spawn(command, {
    shell: true,
    stdio: "inherit"
  });

  await new Promise((resolvePromise, rejectPromise) => {
    upload.on("error", () => rejectPromise(new Error("Backup upload process could not start.")));
    upload.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(new Error(`BACKUP_UPLOAD_COMMAND failed with exit code ${code ?? 1}.`));
    });
  });
}

async function pruneOldLocalBackups() {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const entries = await readdir(backupDir);

  for (const entry of entries) {
    if (!entry.startsWith("grogoni-") || !entry.endsWith(".dump")) {
      continue;
    }

    const path = resolve(backupDir, entry);
    const info = await stat(path);

    if (info.mtimeMs < cutoff) {
      await rm(path);
      console.log(`Removed expired local backup ${path}`);
    }
  }
}

function isBlank(value) {
  return value === undefined || value.trim() === "";
}

async function recordBackupStarted() {
  await pool.query(
    `
      insert into database_backup_runs (
        id, status, backup_file, upload_configured, retention_days, started_at
      )
      values ($1, 'started', $2, $3, $4, $5)
    `,
    [runId, outputPath, !isBlank(uploadCommand), retentionDays, startedAt]
  );
}

async function recordBackupSucceeded() {
  const backupStat = await stat(outputPath);

  await pool.query(
    `
      update database_backup_runs
      set status = 'succeeded',
          size_bytes = $2,
          finished_at = now()
      where id = $1
    `,
    [runId, backupStat.size]
  );
}

async function recordBackupFailed(errorMessage) {
  await pool.query(
    `
      update database_backup_runs
      set status = 'failed',
          finished_at = now(),
          error_message = $2
      where id = $1
    `,
    [runId, errorMessage]
  );
}
