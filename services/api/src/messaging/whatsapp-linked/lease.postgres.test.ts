import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LinkedLeaseKeeper, PostgresLinkedLeaseStore, type LinkedLeaseSql } from "./lease.js";
import { describeLinkedLeaseStoreContract } from "./lease-conformance.test-support.js";

// Real SQL against the CP2 test database. Each run applies migration 136 inside a private schema
// (pinned per connection with search_path) and drops it afterwards, so nothing leaks.
const url = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const migrationUrl = new URL(
  "../../../../../infra/db/migrations/136_whatsapp_linked_leases.sql",
  import.meta.url
);
const rollbackUrl = new URL(
  "../../../../../infra/db/rollbacks/136_whatsapp_linked_leases.down.sql",
  import.meta.url
);
const schema = `wa_lease_${randomUUID().replaceAll("-", "")}`;
const TTL = 400;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(!url)("WhatsApp linked leases on PostgreSQL", () => {
  let admin: Pool;
  let pool: Pool;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`create schema ${schema}`);
    const client = await admin.connect();
    try {
      await client.query(`set search_path to ${schema}`);
      await client.query(await readFile(migrationUrl, "utf8"));
      await client.query("reset search_path");
    } finally {
      client.release();
    }
    // Enough connections that concurrent acquirers really run in parallel transactions.
    pool = new Pool({ connectionString: url, max: 12, options: `-c search_path=${schema}` });
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop schema if exists ${schema} cascade`);
    await admin?.end();
  });

  let sequence = 0;
  describeLinkedLeaseStoreContract(
    "PostgreSQL",
    () => ({
      // pg.Pool satisfies the narrow SQL interface without adapters.
      store: new PostgresLinkedLeaseStore(pool satisfies LinkedLeaseSql),
      ttlMs: TTL,
      expire: () => sleep(TTL + 100),
      business: () => `business-${++sequence}-${randomUUID().slice(0, 8)}`
    }),
    { concurrency: 10, timeout: 15_000 }
  );

  it("two keepers racing on separate connections: exactly one wins, the loser takes over only after expiry", async () => {
    const store = new PostgresLinkedLeaseStore(pool);
    const settings = { ttlMs: 5_000, heartbeatMs: 1_000, skewMs: 1_000, retryMs: 1_000 };
    const a = new LinkedLeaseKeeper(store, { holderId: "worker-a", ...settings });
    const b = new LinkedLeaseKeeper(store, { holderId: "worker-b", ...settings });
    const business = `race-${randomUUID()}`;
    const [ga, gb] = await Promise.all([a.acquire(business), b.acquire(business)]);
    expect([ga, gb].filter(Boolean)).toEqual(["1"]);
    const [winner, loser] = ga ? [a, b] : [b, a];
    // The winner hands over on stop; the loser then takes the next generation immediately.
    await winner.stop();
    expect(await loser.acquire(business)).toBe("2");
    expect(await loser.verify(business, "2")).toBe(true);
    const row = await pool.query(
      "select holder_id, generation::text as generation, expires_at > heartbeat_at as ahead from whatsapp_linked_leases where business_id = $1",
      [business]
    );
    expect(row.rows[0]).toMatchObject({
      holder_id: loser.holderId,
      generation: "2",
      ahead: true
    });
    await loser.stop();
  });

  it("uses the database clock for expiry and the rollback removes the table", async () => {
    const store = new PostgresLinkedLeaseStore(pool);
    const business = `clock-${randomUUID()}`;
    expect(await store.acquire(business, "worker-a", 60_000)).toBe("1");
    const window = await pool.query(
      "select extract(epoch from (expires_at - heartbeat_at)) * 1000 as ms from whatsapp_linked_leases where business_id = $1",
      [business]
    );
    expect(Math.round(Number(window.rows[0].ms))).toBe(60_000);
    const client = await admin.connect();
    const scratch = `${schema}_rb`;
    try {
      await client.query(`create schema ${scratch}`);
      await client.query(`set search_path to ${scratch}`);
      await client.query(await readFile(migrationUrl, "utf8"));
      // Idempotent: a re-run of the migration is harmless.
      await client.query(await readFile(migrationUrl, "utf8"));
      await client.query(await readFile(rollbackUrl, "utf8"));
      const left = await client.query(
        "select count(*)::int as n from information_schema.tables where table_schema = $1",
        [scratch]
      );
      expect(left.rows[0].n).toBe(0);
    } finally {
      await client.query("reset search_path");
      await client.query(`drop schema if exists ${scratch} cascade`);
      client.release();
    }
  });
});
