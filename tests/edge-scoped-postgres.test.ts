import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { Pool as PgPool } from "pg";
import { deleteLiveFixtureAccounts } from "../scripts/live-fixture-cleanup.mjs";
import { createCp2Store } from "../services/api/src/cp2/store";
import { createEdgeSnapshotScope } from "../services/api/src/cp2/edge-snapshot-scope";
import { coordinateStoreRequest } from "../supabase/functions/api/store-coordination";
import {
  loadTransactionalCp2Snapshot,
  saveTransactionalCp2Snapshot,
  saveCollectionRecords
} from "../services/api/src/cp2/postgres-store";

const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const requireApi = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Pool } = requireApi("pg") as { Pool: typeof PgPool };

describe.skipIf(!databaseUrl)("Edge tenant scoping on PostgreSQL", () => {
  it("restores conversation checkpoints and advances their version across scoped requests", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const store = createCp2Store();
      const baseline = store.snapshot();
      const actor = store.continueWithChannelPin({
        channel: "email",
        destination: `checkpoint-${randomUUID()}@example.invalid`,
        pin: "1234"
      });
      const other = store.continueWithChannelPin({
        channel: "email",
        destination: `other-${randomUUID()}@example.invalid`,
        pin: "4321"
      });
      const shop = store.createBusiness({
        sessionId: actor.session.id,
        name: "Checkpoint shop",
        language: "en",
        phoneNumber: "+442079460983",
        phoneCountry: "GB"
      }).business;
      const otherShop = store.createBusiness({
        sessionId: other.session.id,
        name: "Other checkpoint shop",
        language: "en",
        phoneNumber: "+442079460984",
        phoneCountry: "GB"
      }).business;
      const conversation = store.createConversation({
        sessionId: actor.session.id,
        activeShopId: shop.id,
        kind: "personal"
      }).conversation;
      const unrelated = store.createConversation({
        sessionId: other.session.id,
        activeShopId: otherShop.id,
        kind: "personal"
      }).conversation;
      store.activateGlobalDefaultModel({
        model: { ...store.snapshot().modelCatalog[0]!, available: true },
        executionTarget: "backend",
        checkedAt: new Date().toISOString(),
        updatedBy: "test"
      });
      // The migrated test database can already contain a global primary model.
      // Replace only its role inside this rollback-only fixture transaction.
      await client.query(
        "delete from cp2_native_runtime_binding_models where record->>'runtimeBindingId' = $1",
        [
          store
            .snapshot()
            .nativeRuntimeBindings!.find(
              (b) => b.isDefault && b.accountId === null && b.businessId === null
            )!.id
        ]
      );
      const first = store.resolveRuntimeHandoff(actor.session.id, conversation.id).activeHandoff;
      store.resolveRuntimeHandoff(other.session.id, unrelated.id);
      await saveTransactionalCp2Snapshot(client, store.snapshot(), baseline);
      const scope = await createEdgeSnapshotScope(
        client,
        new Request("https://grogoni.com/api/v1/messages", {
          headers: { cookie: `grogoni_session=${actor.session.id}` }
        }),
        "/v1/messages"
      );
      const loaded = await loadTransactionalCp2Snapshot(client, scope);
      expect(loaded.runtimeHandoffs?.map((h) => h.id)).toEqual([first.id]);
      expect(loaded.runtimeTaskHeads?.map((h) => h.taskId)).toEqual([conversation.id]);
      const restored = createCp2Store();
      restored.hydrateSnapshot(loaded);
      const next = restored.createRuntimeCheckpoint(actor.session.id, {
        taskId: conversation.id,
        expectedHandoffId: first.id,
        promote: true
      });
      expect(next.handoff.checkpointVersion).toBe(first.checkpointVersion! + 1);
      await saveTransactionalCp2Snapshot(client, restored.snapshot(), loaded);
      const reloaded = await loadTransactionalCp2Snapshot(client, scope);
      expect(reloaded.runtimeTaskHeads?.[0]?.nextCheckpointVersion).toBe(
        first.checkpointVersion! + 2
      );
      await client.query("select pg_advisory_xact_lock(hashtext('grogoni.cp2.normalized_store'))");
      let cleanupRoundTrips = 0;
      await deleteLiveFixtureAccounts(
        {
          query: (sql: string, params?: unknown[]) => {
            cleanupRoundTrips += 1;
            return client.query(sql, params);
          }
        },
        {
          accountIds: [actor.account.id],
          businessIds: [shop.id]
        }
      );
      expect(cleanupRoundTrips).toBeLessThanOrEqual(3);
      expect(
        (
          await client.query("select entity_id from cp2_runtime_handoffs where task_id = $1", [
            conversation.id
          ])
        ).rowCount
      ).toBe(0);
      expect(
        (
          await client.query("select entity_id from cp2_runtime_handoffs where task_id = $1", [
            unrelated.id
          ])
        ).rowCount
      ).toBe(1);
    } finally {
      await client.query("rollback");
      client.release();
      await pool.end();
    }
  });
  it("accepts identical concurrent snapshot seeds while rejecting different replacements", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "create temporary table cp2_receipt_seed_test (entity_id text primary key, business_id text, account_id text, user_id text, parent_id text, record jsonb, updated_at timestamptz) on commit drop"
      );
      const collection = { key: "modelCatalog" as const, tableName: "cp2_receipt_seed_test" };
      const desired = { id: "same-model", label: "Luna" };
      await saveCollectionRecords(client, collection, [desired], [], []);
      await expect(
        saveCollectionRecords(client, collection, [desired], [], [])
      ).resolves.toBeUndefined();
      await expect(
        saveCollectionRecords(client, collection, [{ ...desired, label: "different" }], [], [])
      ).rejects.toMatchObject({ code: "40001" });
      expect(
        (await client.query("select record from cp2_receipt_seed_test")).rows[0].record
      ).toEqual(desired);
    } finally {
      await client.query("rollback");
      client.release();
      await pool.end();
    }
  });
  it("allows concurrent requests but excludes full-snapshot jobs until they commit", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 3 });
    const clients = await Promise.all([pool.connect(), pool.connect(), pool.connect()]);
    const [first, second, job] = clients;
    try {
      for (const client of clients) await client.query("begin");
      await coordinateStoreRequest(first);
      await coordinateStoreRequest(second);
      const attempt = () =>
        job.query(
          "select pg_try_advisory_xact_lock(hashtext('grogoni.cp2.normalized_store')) as acquired"
        );
      expect((await attempt()).rows[0].acquired).toBe(false);
      await first.query("commit");
      expect((await attempt()).rows[0].acquired).toBe(false);
      await second.query("commit");
      expect((await attempt()).rows[0].acquired).toBe(true);
      expect(
        (
          await first.query(
            "select pg_try_advisory_xact_lock_shared(hashtext('grogoni.cp2.normalized_store')) as acquired"
          )
        ).rows[0].acquired
      ).toBe(false);
    } finally {
      for (const client of clients) {
        await client.query("rollback");
        client.release();
      }
      await pool.end();
    }
  });
  it("loads only the anonymous OAuth state requested by a callback and validates CSRF", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const store = createCp2Store();
      const baseline = store.snapshot();
      for (const state of ["requested", "unrelated"])
        store.beginOAuthSession({
          accountSessionId: null,
          authorizationUrl: "https://example.com",
          codeChallenge: "challenge",
          codeVerifier: "verifier",
          csrfToken: "csrf",
          provider: "google",
          redirectUri: "https://grogoni.com/oauth/callback",
          state
        });
      await saveTransactionalCp2Snapshot(client, store.snapshot(), baseline);
      for (const method of ["GET", "POST"]) {
        const path = method === "GET" ? "/auth/oauth/google/callback" : "/auth/oauth/callback";
        const request = new Request(`https://grogoni.com${path}?state=requested`, {
          method,
          headers: { "content-type": "application/json" }
        });
        const scope = await createEdgeSnapshotScope(
          client,
          request,
          path,
          method === "POST" ? Buffer.from(JSON.stringify({ state: "requested" })) : undefined
        );
        const snapshot = await loadTransactionalCp2Snapshot(client, scope);
        expect(snapshot.oauthSessions).toHaveLength(1);
        const restored = createCp2Store();
        restored.hydrateSnapshot(snapshot);
        expect(
          restored.getOAuthExchangeData({
            provider: "google",
            state: "requested",
            csrfToken: "csrf"
          }).codeVerifier
        ).toBe("verifier");
        expect(() =>
          restored.getOAuthExchangeData({
            provider: "google",
            state: "requested",
            csrfToken: "wrong"
          })
        ).toThrow();
      }
    } finally {
      await client.query("rollback");
      client.release();
      await pool.end();
    }
  });
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
