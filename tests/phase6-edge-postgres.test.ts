import { randomUUID, webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import type { Pool as PgPool } from "pg";
import { describe, expect, it } from "vitest";
import { createCp2Store } from "../services/api/src/cp2/store";
import {
  createEdgeSnapshotScope,
  prepareEdgeHydration
} from "../services/api/src/cp2/edge-snapshot-scope";
import {
  loadTransactionalCp2Snapshot,
  saveTransactionalCp2Snapshot
} from "../services/api/src/cp2/postgres-store";
const { Pool } = createRequire(new URL("../services/api/package.json", import.meta.url))("pg") as {
  Pool: typeof PgPool;
};
const url = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
describe.skipIf(!url)("Phase 6 Edge hydration on real PostgreSQL", () => {
  it("loads recipients, their public encryption keys and business threads without peer credentials or unrelated tenants", async () => {
    const pool = new Pool({ connectionString: url, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const store = createCp2Store(),
        baseline = store.snapshot();
      const a = store.continueWithChannelPin({
        channel: "email",
        destination: `phase6-a-${randomUUID()}@example.invalid`,
        pin: "1234"
      });
      const b = store.continueWithChannelPin({
        channel: "email",
        destination: `phase6-b-${randomUUID()}@example.invalid`,
        pin: "1234"
      });
      const outsider = store.continueWithChannelPin({
        channel: "email",
        destination: `phase6-x-${randomUUID()}@example.invalid`,
        pin: "1234"
      });
      const direct = store.createConversation({
        sessionId: a.session.id,
        kind: "personal",
        activeShopId: null,
        recipient: b.account.primaryAuthDestination
      });
      for (const actor of [a, b]) {
        const keys = await webcrypto.subtle.generateKey(
          { name: "ECDH", namedCurve: "P-256" },
          true,
          ["deriveBits"]
        );
        const jwk = await webcrypto.subtle.exportKey("jwk", keys.publicKey);
        store.registerE2eeDevice({
          sessionId: actor.session.id,
          deviceId: `device-${randomUUID()}`,
          label: "test",
          publicKey: { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y!, ext: true }
        });
      }
      const business = store.createBusiness({
        sessionId: b.session.id,
        name: "Phase6 fixture",
        language: "en",
        phoneNumber: "+442079460223",
        phoneCountry: "GB"
      }).business;
      const thread = store.createConversation({
        sessionId: a.session.id,
        kind: "storefront",
        activeShopId: business.id
      });
      const unrelated = store.createConversation({
        sessionId: outsider.session.id,
        kind: "personal",
        activeShopId: null
      });
      await saveTransactionalCp2Snapshot(client, store.snapshot(), baseline);
      for (const actor of [a, b]) {
        const request = new Request(
          `https://grogoni.com/v1/conversations/${direct.conversation.id}`,
          { headers: { cookie: `grogoni_session=${actor.session.id}` } }
        );
        const scope = await createEdgeSnapshotScope(client, request, new URL(request.url).pathname);
        const loaded = await loadTransactionalCp2Snapshot(client, scope);
        const restored = createCp2Store();
        restored.hydrateSnapshot(prepareEdgeHydration(loaded));
        expect(
          restored
            .getConversation({
              sessionId: actor.session.id,
              conversationId: direct.conversation.id
            })
            .participants.filter((p) => p.role === "account")
        ).toHaveLength(2);
        expect(
          restored.listConversationE2eeDevices({
            sessionId: actor.session.id,
            conversationId: direct.conversation.id
          })
        ).toHaveLength(2);
        expect(loaded.sessions.every((s) => s.accountId === actor.account.id)).toBe(true);
        expect(loaded.conversations.some((c) => c.id === unrelated.conversation.id)).toBe(false);
        expect(loaded.conversations.some((c) => c.id === thread.conversation.id)).toBe(true);
      }
      // A model registered by a different account is shared catalog data. It must be
      // in the baseline before selection, or scoped persistence attempts a duplicate INSERT.
      const modelId = `existing-model-${randomUUID()}`;
      const model = {
        id: modelId,
        name: "Existing model",
        provider: "fixture",
        providerModelId: "fixture",
        runtimeContractVersion: "1",
        capabilities: [],
        configuration: {},
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await client.query(
        "insert into cp2_native_runtime_models(entity_id,record) values($1,$2::jsonb)",
        [modelId, JSON.stringify(model)]
      );
      const modelPath = `/v1/conversations/${direct.conversation.id}/model`;
      const modelBody = Buffer.from(JSON.stringify({ modelId }));
      const modelScope = await createEdgeSnapshotScope(
        client,
        new Request(`https://grogoni.com${modelPath}`, {
          method: "PUT",
          headers: {
            cookie: `grogoni_session=${a.session.id}`,
            "content-type": "application/json"
          },
          body: modelBody
        }),
        modelPath,
        modelBody
      );
      expect(
        (await loadTransactionalCp2Snapshot(client, modelScope)).nativeRuntimeModels.some(
          (m) => m.id === modelId
        )
      ).toBe(true);
      expect(modelScope.modelSelectionLock).toBe(`edge:catalog-model:${modelId}`);
      const req = new Request("https://grogoni.com/v1/conversations", {
        method: "POST",
        headers: { cookie: `grogoni_session=${a.session.id}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: "storefront", activeShopId: business.id })
      });
      const scope = await createEdgeSnapshotScope(
        client,
        req,
        "/v1/conversations",
        Buffer.from(JSON.stringify({ kind: "storefront", activeShopId: business.id }))
      );
      expect(
        (await loadTransactionalCp2Snapshot(client, scope)).businesses.some(
          (v) => v.id === business.id
        )
      ).toBe(true);
    } finally {
      await client.query("rollback");
      client.release();
      await pool.end();
    }
  });
});
