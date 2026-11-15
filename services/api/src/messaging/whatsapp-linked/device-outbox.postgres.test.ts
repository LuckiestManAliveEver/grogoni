import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createPostgresCp2Store, type PostgresCp2Store } from "../../cp2/postgres-store.js";
import {
  claimLinkedDeviceSend,
  newLinkedDeviceSend,
  settleLinkedDeviceEntry
} from "./device-outbox.js";

// Migration 141 on the migrated test database: device-outbox rows written by another host (Edge)
// survive a save by a Node process that loaded before them, constraints refuse malformed rows
// and message text, and the rollback drops the table.
// CP2_POSTGRES_TEST_DATABASE_URL=postgresql://... npx vitest run <this file>
const url = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const run = randomUUID();
const business = `wa-device-outbox-${run}`;
const entry = (messageId: string) =>
  newLinkedDeviceSend(
    {
      businessId: business,
      ownerId: `owner-${run}`,
      channelId: `channel-${run}`,
      conversationId: `conversation-${run}`,
      chat: "254711000401@s.whatsapp.net",
      messageId,
      idempotencyKey: `reply-${messageId}`
    },
    new Date()
  );
const insert = (pool: Pool, record: Record<string, unknown>, id = String(record.id)) =>
  pool.query(
    "insert into cp2_whatsapp_linked_device_outbox (entity_id, business_id, record) values ($1, $2, $3)",
    [id, business, JSON.stringify(record)]
  );

describe.skipIf(!url)("WhatsApp device outbox on PostgreSQL", { timeout: 90_000 }, () => {
  const pool = url ? new Pool({ connectionString: url, max: 2 }) : undefined;
  const rows = async () =>
    (
      await pool!.query<{ record: Record<string, unknown> }>(
        "select record from cp2_whatsapp_linked_device_outbox where business_id = $1 order by entity_id",
        [business]
      )
    ).rows.map((row) => row.record);
  afterAll(async () => {
    await pool?.query("delete from cp2_whatsapp_linked_device_outbox where business_id = $1", [
      business
    ]);
    await pool?.query("delete from cp2_whatsapp_linked_delegation_results where business_id = $1", [
      business
    ]);
    await pool?.query("delete from cp2_audit_events where record->>'aggregateId' like $1", [
      `whatsapp-result:turn-${run}%`
    ]);
    await pool?.end();
  });

  it("keeps rows another host wrote, and round-trips the rows it loaded", async () => {
    let early: PostgresCp2Store | undefined;
    let late: PostgresCp2Store | undefined;
    try {
      // Loaded before the Edge row exists, like a long-running Node API host.
      early = await createPostgresCp2Store({ databaseUrl: url! });
      const edgeRow = entry(`m-edge-${run}`);
      await insert(pool!, edgeRow as unknown as Record<string, unknown>);
      // The early process saves a change of its own; a full save normally deletes rows it never
      // loaded. Baseline scoping must keep the Edge row.
      await early.deliverLinkedDelegationResult({
        businessId: business,
        turnId: `turn-${run}`,
        delegation: {
          channelId: "c",
          grantId: "g",
          ownerId: "o",
          sourceMessageId: "s",
          actorId: "254711111111@s.whatsapp.net"
        },
        toolName: "product.create",
        outcome: "rejected",
        resolvedBy: "o"
      });
      await early.flush();
      expect(await rows()).toEqual([edgeRow]);

      // A process that loads the row hydrates it, and its own settlement is saved.
      late = await createPostgresCp2Store({ databaseUrl: url! });
      expect(late.linkedDeviceOutboxEntries(business)).toEqual([edgeRow]);
      const settled = settleLinkedDeviceEntry(edgeRow, "sent", new Date(), {
        deliveredId: "3EB0PG0001"
      });
      const snapshot = late.snapshot();
      snapshot.whatsappLinkedDeviceOutbox = (snapshot.whatsappLinkedDeviceOutbox ?? []).map(
        (row) => (row.id === settled.id ? settled : row)
      );
      late.hydrateSnapshot(snapshot);
      await late.deliverLinkedDelegationResult({
        businessId: business,
        turnId: `turn-${run}-2`,
        delegation: {
          channelId: "c",
          grantId: "g",
          ownerId: "o",
          sourceMessageId: "s2",
          actorId: "254711111111@s.whatsapp.net"
        },
        toolName: "product.create",
        outcome: "rejected",
        resolvedBy: "o"
      });
      await late.flush();
      expect((await rows())[0]).toMatchObject({ status: "sent", deliveredId: "3EB0PG0001" });
    } finally {
      await early?.close();
      await late?.close();
    }
  });

  it("refuses a stale host claiming the same send after another host persisted its claim", async () => {
    const initial = entry(`m-claim-${run}`);
    await insert(pool!, initial as unknown as Record<string, unknown>);
    const first = await createPostgresCp2Store({ databaseUrl: url! });
    const stale = await createPostgresCp2Store({ databaseUrl: url! });
    const claim = (store: PostgresCp2Store) => {
      const decision = claimLinkedDeviceSend(initial, randomUUID(), randomUUID(), new Date());
      if (decision.action !== "offer") throw new Error("Expected a fresh claim");
      const snapshot = store.snapshot();
      snapshot.whatsappLinkedDeviceOutbox = (snapshot.whatsappLinkedDeviceOutbox ?? []).map(
        (row) => (row.id === initial.id ? decision.entry : row)
      );
      store.hydrateSnapshot(snapshot);
      // A real mutation queues the snapshot save, as a device pull does in production.
      store.recordLinkedWhatsAppState(business, `owner-${run}`, "DISCONNECTED");
      return decision.entry;
    };
    try {
      const winner = claim(first);
      await first.flush();
      claim(stale);
      await expect(stale.flush()).rejects.toMatchObject({ code: "40001" });
      const persisted = (await rows()).find((row) => row.id === initial.id);
      expect(persisted).toMatchObject({ status: "claimed", claimId: winner.claimId });
    } finally {
      await first.close();
      // Closing the stale host must not turn its rejected snapshot into a successful overwrite.
      await stale.close().catch(() => undefined);
    }
  });

  it("refuses malformed rows and message text; the rollback drops the table", async () => {
    const good = entry(`m-check-${run}`) as unknown as Record<string, unknown>;
    await expect(insert(pool!, good, `send:other-${run}`)).rejects.toThrow(
      /cp2_whatsapp_linked_device_outbox_identity/
    );
    await expect(
      insert(pool!, { ...good, id: `send:m-text-${run}`, messageId: `m-text-${run}`, text: "hi" })
    ).rejects.toThrow(/cp2_whatsapp_linked_device_outbox_no_text/);
    await expect(
      insert(pool!, {
        ...good,
        id: `send:m-status-${run}`,
        messageId: `m-status-${run}`,
        status: "x"
      })
    ).rejects.toThrow(/cp2_whatsapp_linked_device_outbox_status/);
    const client = await pool!.connect();
    try {
      await client.query("begin");
      await client.query(
        await readFile(
          new URL(
            "../../../../../infra/db/rollbacks/141_whatsapp_linked_device_outbox.down.sql",
            import.meta.url
          ),
          "utf8"
        )
      );
      expect(
        (await client.query("select to_regclass('cp2_whatsapp_linked_device_outbox') as t")).rows[0]
          .t
      ).toBeNull();
      const migration = await readFile(
        new URL(
          "../../../../../infra/db/migrations/141_whatsapp_linked_device_outbox.sql",
          import.meta.url
        ),
        "utf8"
      );
      await client.query(migration);
      await client.query(migration);
      expect(
        (await client.query("select to_regclass('cp2_whatsapp_linked_device_outbox')::text as t"))
          .rows[0].t
      ).toBe("cp2_whatsapp_linked_device_outbox");
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
