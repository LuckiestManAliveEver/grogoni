import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { Pool as PgPool } from "pg";
import { createCp2Store } from "../services/api/src/cp2/store";
import { createEdgeSnapshotScope } from "../services/api/src/cp2/edge-snapshot-scope";
import {
  loadTransactionalCp2Snapshot,
  saveTransactionalCp2Snapshot
} from "../services/api/src/cp2/postgres-store";

const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const requireApi = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Pool } = requireApi("pg") as { Pool: typeof PgPool };

describe.skipIf(!databaseUrl)("Edge tenant scoping on PostgreSQL", () => {
  it("preserves unrelated accounts and loads contact-shared statuses without the sender's tenant", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const store = createCp2Store();
      const baseline = store.snapshot();
      const viewer = store.continueWithChannelPin({
        channel: "email",
        destination: `viewer-${randomUUID()}@example.invalid`,
        pin: "1234"
      });
      const sender = store.continueWithChannelPin({
        channel: "email",
        destination: `sender-${randomUUID()}@example.invalid`,
        pin: "4321"
      });
      const shop = store.createBusiness({
        sessionId: sender.session.id,
        name: "Unrelated sender shop",
        language: "en",
        phoneNumber: "+442079460987",
        phoneCountry: "GB"
      });
      await saveTransactionalCp2Snapshot(client, store.snapshot(), baseline);
      const nodeId = randomUUID();
      const statusId = randomUUID();
      await client.query(
        "insert into cp2_network_nodes (entity_id, user_id, record) values ($1, $2, $3)",
        [
          nodeId,
          sender.user.id,
          JSON.stringify({ id: nodeId, ownerUserId: sender.user.id, grogoniUserId: viewer.user.id })
        ]
      );
      await client.query(
        "insert into status_broadcasts (entity_id, business_id, record) values ($1, $2, $3)",
        [
          statusId,
          shop.business.id,
          JSON.stringify({
            id: statusId,
            businessId: shop.business.id,
            recipients: [{ networkNodeId: nodeId }]
          })
        ]
      );
      const scope = await createEdgeSnapshotScope(
        client,
        new Request("https://grogoni.com/api/v1/shops", {
          headers: { cookie: `grogoni_session=${viewer.session.id}` }
        }),
        "/v1/shops"
      );
      const loaded = await loadTransactionalCp2Snapshot(client, scope);
      expect(loaded.accounts.map((account) => account.id)).toEqual([viewer.account.id]);
      expect(loaded.businesses).toHaveLength(0);
      expect(loaded.networkNodes.map((node) => node.id)).toContain(nodeId);
      expect(loaded.statusBroadcasts.map((status) => status.id)).toContain(statusId);
      const after = structuredClone(loaded);
      after.users[0]!.displayName = "Updated viewer";
      await saveTransactionalCp2Snapshot(client, after, loaded);
      expect(
        (await client.query("select id from accounts where id = $1", [sender.account.id])).rowCount
      ).toBe(1);
      expect(
        (await client.query("select id from businesses where id = $1", [shop.business.id])).rowCount
      ).toBe(1);
      expect(
        (await client.query("select display_name from users where id = $1", [viewer.user.id]))
          .rows[0].display_name
      ).toBe("Updated viewer");
    } finally {
      await client.query("rollback");
      client.release();
      await pool.end();
    }
  });
});
