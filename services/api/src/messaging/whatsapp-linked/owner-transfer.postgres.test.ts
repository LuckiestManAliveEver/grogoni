import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createPostgresCp2Store, type PostgresCp2Store } from "../../cp2/postgres-store.js";
import { newLinkedOwnerStateRecord } from "./owner-transfer.js";

// Migration 140 on the migrated test database: owner-state rows round-trip, survive a save by a
// process that loaded before they existed, and record an owner change.
// CP2_POSTGRES_TEST_DATABASE_URL=postgresql://... npx vitest run <this file>
const url = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const run = randomUUID();
const business = `wa-owner-state-${run}`;

describe.skipIf(!url)("WhatsApp owner state on PostgreSQL", { timeout: 60_000 }, () => {
  const pool = url ? new Pool({ connectionString: url, max: 2 }) : undefined;
  const row = async () =>
    (
      await pool!.query<{ record: Record<string, unknown> }>(
        "select record from cp2_whatsapp_linked_owner_states where entity_id = $1",
        [business]
      )
    ).rows[0]?.record;
  afterAll(async () => {
    await pool?.query("delete from cp2_whatsapp_linked_owner_states where business_id = $1", [
      business
    ]);
    await pool?.query("delete from cp2_audit_events where record->>'aggregateId' = $1", [business]);
    await pool?.end();
  });

  it("keeps rows written by another process and records an owner change", async () => {
    let early: PostgresCp2Store | undefined;
    let late: PostgresCp2Store | undefined;
    try {
      // Loaded before the row exists, like a second API host.
      early = await createPostgresCp2Store({ databaseUrl: url! });
      const record = {
        ...newLinkedOwnerStateRecord(business, new Date()),
        ownerId: `former-owner-${run}`,
        state: "CONNECTED"
      };
      await pool!.query(
        "insert into cp2_whatsapp_linked_owner_states (entity_id, business_id, record) values ($1, $1, $2)",
        [business, JSON.stringify(record)]
      );
      // The early process saves a change of its own; the row it never loaded must survive.
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
      expect(await row()).toMatchObject({ ownerId: `former-owner-${run}` });
      await pool!.query(
        "delete from cp2_whatsapp_linked_delegation_results where business_id = $1",
        [business]
      );

      late = await createPostgresCp2Store({ databaseUrl: url! });
      expect(late.linkedWhatsAppOwnerStates(business)).toEqual([record]);
      // The recorded owner is not an owner of this business: that is an owner change.
      expect(late.reconcileLinkedWhatsAppOwnership(business)).toMatchObject({
        previousOwnerId: `former-owner-${run}`,
        channelsDetached: 0
      });
      await late.flush();
      expect(await row()).toMatchObject({
        ownerId: null,
        state: "REVOKED",
        ownerChange: { previousOwnerId: `former-owner-${run}` },
        acknowledgedAt: null
      });
    } finally {
      await early?.close();
      await late?.close();
    }
  });

  it("refuses rows whose id is not their business, and the rollback drops the table", async () => {
    const record = newLinkedOwnerStateRecord(`${business}-other`, new Date());
    await expect(
      pool!.query(
        "insert into cp2_whatsapp_linked_owner_states (entity_id, business_id, record) values ($1, $1, $2)",
        [business + "-mismatch", JSON.stringify(record)]
      )
    ).rejects.toThrow(/cp2_whatsapp_linked_owner_states_identity/);
    const client = await pool!.connect();
    try {
      await client.query("begin");
      await client.query(
        await readFile(
          new URL(
            "../../../../../infra/db/rollbacks/140_whatsapp_linked_owner_states.down.sql",
            import.meta.url
          ),
          "utf8"
        )
      );
      expect(
        (await client.query("select to_regclass('cp2_whatsapp_linked_owner_states') as t")).rows[0]
          .t
      ).toBeNull();
      // Re-applying the migration is idempotent.
      const migration = await readFile(
        new URL(
          "../../../../../infra/db/migrations/140_whatsapp_linked_owner_states.sql",
          import.meta.url
        ),
        "utf8"
      );
      await client.query(migration);
      await client.query(migration);
      expect(
        (await client.query("select to_regclass('cp2_whatsapp_linked_owner_states')::text as t"))
          .rows[0].t
      ).toBe("cp2_whatsapp_linked_owner_states");
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
