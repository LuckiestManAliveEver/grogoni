import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createCp2Store } from "../services/api/src/cp2/store";
import {
  loadTransactionalCp2Snapshot,
  saveTransactionalCp2Snapshot
} from "../services/api/src/cp2/postgres-store";
import { createEdgeSnapshotScope } from "../services/api/src/cp2/edge-snapshot-scope";
const { Pool } = createRequire(new URL("../services/api/package.json", import.meta.url))("pg");
const url = process.env.CP2_POSTGRES_TEST_DATABASE_URL;

describe.skipIf(!url)("contact privacy PostgreSQL persistence", () => {
  it("restores private preferences and enforces reverse blocks through a scoped Edge reload", async () => {
    const pool = new Pool({ connectionString: url, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const store = createCp2Store(),
        baseline = store.snapshot();
      const a = store.continueWithChannelPin({
        channel: "email",
        destination: `privacy-a-${randomUUID()}@example.invalid`,
        pin: "1234"
      });
      const b = store.continueWithChannelPin({
        channel: "email",
        destination: `privacy-b-${randomUUID()}@example.invalid`,
        pin: "1234"
      });
      const graph = store.syncPhoneContacts({
        sessionId: a.session.id,
        contacts: [{ name: "B", email: b.account.primaryAuthDestination }]
      });
      store.blockNetworkContact({ sessionId: a.session.id, userId: b.user.id, blocked: true });
      store.updateNetworkPrivacy({ sessionId: a.session.id, discoverable: false });
      await saveTransactionalCp2Snapshot(client, store.snapshot(), baseline);
      const request = new Request("https://grogoni.com/api/v1/conversations", {
        method: "POST",
        headers: { cookie: `grogoni_session=${b.session.id}`, "content-type": "application/json" }
      });
      const scope = await createEdgeSnapshotScope(
        client,
        request,
        "/v1/conversations",
        Buffer.from(JSON.stringify({ recipient: a.account.primaryAuthDestination }))
      );
      const loaded = await loadTransactionalCp2Snapshot(client, scope);
      expect(loaded.users.find((user) => user.id === a.user.id)).toMatchObject({
        contactDiscoveryEnabled: false,
        blockedContactUserIds: [b.user.id]
      });
      expect(loaded.passwordCredentials).not.toContainEqual(
        expect.objectContaining({ accountId: a.account.id })
      );
      const restored = createCp2Store();
      restored.hydrateSnapshot(loaded);
      expect(() =>
        restored.createConversation({
          sessionId: b.session.id,
          kind: "personal",
          activeShopId: null,
          recipient: a.account.primaryAuthDestination
        })
      ).toThrow();
      const all = await loadTransactionalCp2Snapshot(client);
      const ownerStore = createCp2Store();
      ownerStore.hydrateSnapshot(all);
      expect(ownerStore.getNetworkPrivacy({ sessionId: a.session.id }).discoverable).toBe(false);
      const before = ownerStore.snapshot();
      ownerStore.deleteNetworkSource({
        sessionId: a.session.id,
        sourceId: graph.sources.find((source) => source.status === "active")!.id
      });
      await saveTransactionalCp2Snapshot(client, ownerStore.snapshot(), before);
      const after = await loadTransactionalCp2Snapshot(client);
      expect(after.contactHashes.filter((hash) => hash.ownerUserId === a.user.id)).toEqual([]);
    } finally {
      await client.query("rollback");
      client.release();
      await pool.end();
    }
  });
});
