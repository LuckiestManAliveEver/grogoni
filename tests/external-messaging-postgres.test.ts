import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { Pool as PgPool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createCp2Store } from "../services/api/src/cp2/store";
import { createEdgeSnapshotScope } from "../services/api/src/cp2/edge-snapshot-scope";
import {
  loadTransactionalCp2Snapshot,
  saveTransactionalCp2Snapshot
} from "../services/api/src/cp2/postgres-store";
import { createChannelGatewayFromEnvironment } from "../services/api/src/messaging/channel-gateway";
import { createExternalChannelAdapters } from "../services/api/src/messaging/external-channel-adapters";
import { messagingEnvironment, signedMeta, whatsappUpdate } from "./fixtures/external-messaging";
const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const requireApi = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Pool } = requireApi("pg") as { Pool: typeof PgPool };

describe.skipIf(!databaseUrl)("external webhook Edge persistence", () => {
  it("loads only the verified provider's shop without a session and persists its customer link and inbound message", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("begin");
      const gateway = createChannelGatewayFromEnvironment({});
      const store = createCp2Store({ channelGateway: gateway });
      const baseline = store.snapshot();
      const actor = store.continueWithChannelPin({
        channel: "email",
        destination: `external-${randomUUID()}@example.invalid`,
        pin: "1234"
      });
      const shop = store.createBusiness({
        sessionId: actor.session.id,
        name: "Verified provider shop",
        language: "en",
        phoneNumber: "+442079460982",
        phoneCountry: "GB"
      }).business;
      const otherActor = store.continueWithChannelPin({
        channel: "email",
        destination: `unrelated-${randomUUID()}@example.invalid`,
        pin: "4321"
      });
      const other = store.createBusiness({
        sessionId: otherActor.session.id,
        name: "Unrelated shop",
        language: "en",
        phoneNumber: "+442079460983",
        phoneCountry: "GB"
      }).business;
      const configuration = messagingEnvironment(shop.id);
      for (const adapter of createExternalChannelAdapters(configuration, vi.fn()))
        gateway.registerAdapter(adapter);
      vi.stubEnv(
        "EXTERNAL_MESSAGING_CONNECTIONS_JSON",
        JSON.stringify({ [shop.id]: configuration })
      );
      const customer = store.createCustomer({
        sessionId: actor.session.id,
        businessId: shop.id,
        customer: { name: "Verified recipient", phone: null, email: null, notes: null }
      });
      const grant = store.createChannelIdentityLinkGrant({
        sessionId: actor.session.id,
        businessId: shop.id,
        customerId: customer.id,
        provider: "whatsapp"
      });
      await saveTransactionalCp2Snapshot(client, store.snapshot(), baseline);
      const rawBody = Buffer.from(JSON.stringify(whatsappUpdate(`link ${grant.token}`), null, 2));
      const headers = { "content-type": "application/json", ...signedMeta(rawBody.toString()) };
      const request = new Request("https://grogoni.com/api/v1/webhooks/channels/whatsapp", {
        method: "POST",
        headers,
        body: rawBody
      });
      const scope = await createEdgeSnapshotScope(
        client,
        request,
        "/v1/webhooks/channels/whatsapp",
        rawBody
      );
      const loaded = await loadTransactionalCp2Snapshot(client, scope);
      expect(loaded.businesses.map((b) => b.id)).toEqual([shop.id]);
      expect(loaded.businesses.some((b) => b.id === other.id)).toBe(false);
      expect(loaded.channelIdentityLinkGrants?.map((g) => g.id)).toContain(grant.grantId);
      const restored = createCp2Store({ channelGateway: gateway });
      restored.hydrateSnapshot(loaded);
      const events = restored.ingestChannelWebhookBatch({
        provider: "whatsapp",
        headers,
        payload: JSON.parse(rawBody.toString()),
        rawBody
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.message?.content).toMatchObject({
        type: "text",
        text: "[whatsapp identity linked]"
      });
      expect(JSON.stringify(restored.snapshot())).not.toContain(grant.token);
      await saveTransactionalCp2Snapshot(client, restored.snapshot(), loaded);
      const saved = await loadTransactionalCp2Snapshot(client, scope);
      expect(saved.platformIdentities?.find((i) => i.customerId === customer.id)).toMatchObject({
        optInStatus: "granted",
        businessId: shop.id
      });
      expect(saved.providerUpdateReceipts).toHaveLength(1);
      const bad = new Request(request.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=invalid" },
        body: rawBody
      });
      const badScope = await createEdgeSnapshotScope(
        client,
        bad,
        "/v1/webhooks/channels/whatsapp",
        rawBody
      );
      const anonymous = await loadTransactionalCp2Snapshot(client, badScope);
      expect(anonymous.businesses).toHaveLength(0);
      expect(anonymous.channelIdentityLinkGrants).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
      await client.query("rollback");
      client.release();
      await pool.end();
    }
  });
});
