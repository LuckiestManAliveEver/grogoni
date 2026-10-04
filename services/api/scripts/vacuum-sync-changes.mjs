// One-off maintenance: reclaims the space account_sync_changes lost to write amplification
// (584M no-op upserts on ~22k rows, 379 MB heap for ~15 MB of data) after the is-distinct-from
// guard stopped new bloat. VACUUM FULL rewrites the table without changing its contents and holds
// an ACCESS EXCLUSIVE lock while it runs, so writes to the table wait until it finishes.
// Proof that nothing changed: row count and a content checksum are recorded before and after.
//
// Usage (from services/api): node --env-file=../../.env.local scripts/vacuum-sync-changes.mjs
// Progress and the before/after record: /tmp/vacuum-sync-changes/progress.log
import { appendFileSync, mkdirSync } from "node:fs";
import pg from "pg";

const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("DIRECT_DATABASE_URL or DATABASE_URL is required.");
  process.exit(1);
}
mkdirSync("/tmp/vacuum-sync-changes", { recursive: true });
const log = (entry) => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  console.log(line);
  appendFileSync("/tmp/vacuum-sync-changes/progress.log", `${line}\n`);
};

const client = new pg.Client({ connectionString: url });

async function stats(label) {
  const result = await client.query(
    `select count(*)::int as rows,
            md5(coalesce(string_agg(
              account_id::text || sequence::text || cursor::text || collection || entity_id ||
              operation || coalesce(shop_id::text, '') || coalesce(entity::text, '') ||
              changed_at::text || coalesce(tombstone_expires_at::text, ''),
              ',' order by account_id, sequence), '')) as checksum,
            pg_size_pretty(pg_total_relation_size('account_sync_changes')) as total,
            pg_total_relation_size('account_sync_changes')::bigint as total_bytes
       from account_sync_changes`
  );
  const row = {
    label,
    connection: url.includes("-pooler") ? "pooler" : "direct",
    ...result.rows[0]
  };
  log(row);
  return row;
}

try {
  await client.connect();
  await client.query("set statement_timeout = 0");
  await client.query("set lock_timeout = 30000");
  const before = await stats("before");
  const startedAt = Date.now();
  await client.query("vacuum (full, analyze) account_sync_changes");
  log({ label: "vacuum full", durationMs: Date.now() - startedAt });
  const after = await stats("after");
  const unchanged = before.rows === after.rows && before.checksum === after.checksum;
  log({
    label: "verdict",
    contentUnchanged: unchanged,
    bytesFreed: Number(before.total_bytes) - Number(after.total_bytes)
  });
  if (!unchanged) process.exitCode = 1;
} catch (error) {
  log({ label: "failed", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
