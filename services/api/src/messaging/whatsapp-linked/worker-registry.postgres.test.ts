import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresLinkedWorkerRegistry } from "./worker-registry.js";
import { describeLinkedWorkerRegistryContract } from "./worker-registry-conformance.test-support.js";

// Real SQL against the CP2 test database, in a private schema dropped afterwards.
const url = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const migrationUrl = new URL(
  "../../../../../infra/db/migrations/139_whatsapp_linked_workers.sql",
  import.meta.url
);
const rollbackUrl = new URL(
  "../../../../../infra/db/rollbacks/139_whatsapp_linked_workers.down.sql",
  import.meta.url
);
const schema = `wa_workers_${randomUUID().replaceAll("-", "")}`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(!url)("WhatsApp linked workers on PostgreSQL", () => {
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
    pool = new Pool({ connectionString: url, max: 4, options: `-c search_path=${schema}` });
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop schema if exists ${schema} cascade`);
    await admin?.end();
  });

  let sequence = 0;
  describeLinkedWorkerRegistryContract(
    "PostgreSQL",
    () => ({
      registry: new PostgresLinkedWorkerRegistry(pool),
      ttlMs: 300,
      expire: () => sleep(400),
      business: () => `business-${++sequence}-${randomUUID().slice(0, 8)}`
    }),
    15_000
  );

  it("stores no secret, enforces one active worker in the schema, and rolls back cleanly", async () => {
    const registry = new PostgresLinkedWorkerRegistry(pool);
    const { record, secret } = await registry.enroll({
      businessId: `schema-${randomUUID()}`,
      ownerId: "owner-1",
      label: "w",
      ttlMs: 60_000
    });
    const row = await pool.query("select * from whatsapp_linked_workers where id = $1", [
      record.id
    ]);
    expect(JSON.stringify(row.rows[0])).not.toContain(secret);
    await expect(
      pool.query(
        `insert into whatsapp_linked_workers (id, business_id, owner_id, label, secret_hash, expires_at)
         values ($1, $2, 'o', 'l', $3, now() + interval '1 day')`,
        [randomUUID(), record.businessId, "0".repeat(64)]
      )
    ).rejects.toMatchObject({ code: "23505" });
    const client = await admin.connect();
    const scratch = `${schema}_rb`;
    try {
      await client.query(`create schema ${scratch}`);
      await client.query(`set search_path to ${scratch}`);
      await client.query(await readFile(migrationUrl, "utf8"));
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
