import { createRequire } from "node:module";
import { URL } from "node:url";
import { Buffer } from "node:buffer";
import { deepStrictEqual } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackupStorage, readBackupStorageConfig } from "./supabase-backup-storage.mjs";

const { Client } = createRequire(new URL("../services/api/package.json", import.meta.url))("pg");
const url = new URL(process.env.BACKUP_TEST_DATABASE_URL ?? "");
const container = process.env.PG_DUMP_CONTAINER_ID ?? "";
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
  !/^\/grogoni_[a-z0-9_]*(?:test|certification)[a-z0-9_]*$/.test(url.pathname) ||
  url.search ||
  url.hash ||
  !/^[a-f0-9]{12,64}$/.test(container)
)
  throw new Error(
    "Backup certification requires a local test database and its explicit PostgreSQL container ID."
  );
const sourceName = "grogoni_backup_source";
const targetName = "grogoni_backup_restore";
const admin = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
const created = [];
const temporary = await mkdtemp(join(tmpdir(), "grogoni-private-backup-"));
const sourceUrl = new URL(url);
sourceUrl.pathname = `/${sourceName}`;
const targetUrl = new URL(url);
targetUrl.pathname = `/${targetName}`;
const source = new Client({
  connectionString: sourceUrl.toString(),
  connectionTimeoutMillis: 5000
});
const target = new Client({
  connectionString: targetUrl.toString(),
  connectionTimeoutMillis: 5000
});
function pg(command, databaseUrl, args, input) {
  const connection = new URL(databaseUrl);
  connection.hostname = "127.0.0.1";
  connection.port = "5432";
  const result = spawnSync(
    "docker",
    ["exec", "-i", container, command, "--dbname", connection.toString(), ...args],
    { input, maxBuffer: 4 * 1024 * 1024, timeout: 60000 }
  );
  if (result.error || result.status !== 0)
    throw new Error(`Backup certification ${command} failed.`);
  return result.stdout;
}
try {
  await admin.connect();
  for (const name of [sourceName, targetName]) {
    // CREATE refuses a pre-existing database; cleanup drops only databases created by this run.
    await admin.query(`create database ${name}`);
    created.push(name);
  }
  await source.connect();
  await target.connect();
  await source.query(`create table backup_parent (id integer primary key, label text not null);
    create table backup_child (id integer primary key, parent_id integer references backup_parent, record jsonb not null);
    insert into backup_parent values (1,'synthetic backup fixture');
    insert into backup_child values (1,1,'{"quantityMilli":1250,"totalMinor":600000}');`);
  const dump = pg("pg_dump", sourceUrl, ["--format=custom", "--no-owner"]);
  const file = join(temporary, "grogoni-2026-10-16T00-00-00-000Z.dump");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, dump, { mode: 0o600 });
  let stored;
  const config = readBackupStorageConfig({
    BACKUP_ENCRYPTION_KEY: "ab".repeat(32),
    SUPABASE_SERVICE_ROLE_KEY: "synthetic-private-key-".repeat(3)
  });
  const storage = createBackupStorage(config, async (endpoint, options) => {
    if (endpoint.includes("/bucket/"))
      return globalThis.Response.json({ id: config.bucket, public: false });
    if (options.method === "POST") {
      const chunks = [];
      for await (const chunk of options.body) chunks.push(chunk);
      stored = Buffer.concat(chunks);
      return globalThis.Response.json({ uploaded: true });
    }
    return new globalThis.Response(stored);
  });
  const uploaded = await storage.upload(file);
  const downloaded = join(temporary, "downloaded.dump");
  await storage.download(uploaded.objectKey, downloaded);
  pg(
    "pg_restore",
    targetUrl,
    ["--exit-on-error", "--no-owner", "--no-privileges"],
    await readFile(downloaded)
  );
  const result = await target.query(
    "select p.label,c.record from backup_parent p join backup_child c on c.parent_id=p.id"
  );
  deepStrictEqual(result.rows, [
    { label: "synthetic backup fixture", record: { totalMinor: 600000, quantityMilli: 1250 } }
  ]);
  await target.query("begin");
  try {
    await target.query("insert into backup_child values (2,999,'{}')");
    throw new Error("Restored backup lost its foreign-key constraint.");
  } catch (error) {
    if (error.code !== "23503") throw error;
  } finally {
    await target.query("rollback");
  }
  console.log(
    JSON.stringify({
      status: "passed",
      realPgDump: true,
      encryptedStorageRoundTrip: true,
      realPgRestore: true,
      constraintsRestored: true,
      productionDataUsed: false
    })
  );
} finally {
  await source.end();
  await target.end();
  for (const name of created.reverse()) await admin.query(`drop database ${name}`);
  await admin.end();
  await rm(temporary, { recursive: true, force: true });
}
