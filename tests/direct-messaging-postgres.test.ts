import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { Pool as PgPool, PoolClient } from "pg";
import { createCp2Store } from "../services/api/src/cp2/store";
import { saveTransactionalCp2Snapshot } from "../services/api/src/cp2/postgres-store";
import { createEdgeDomainRoutes } from "../services/api/src/edge-domain-routes";

/**
 * Conversation dedupe under concurrency (docs/audits/instant-messaging-remaining-2026-11-19.md):
 * two people tapping "message" on each other at the same moment, or one person's double tap, must
 * end in one direct conversation. The Edge request takes the edge:direct:<pair> advisory lock
 * before loading its snapshot; this drives real concurrent Edge requests against PostgreSQL.
 */

const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const requireApi = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Pool } = requireApi("pg") as { Pool: typeof PgPool };

function edgeHarness() {
  const pool = new Pool({ connectionString: databaseUrl, max: 8 });
  async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local lock_timeout = '10s'");
      await client.query(
        "select pg_advisory_xact_lock_shared(hashtext('grogoni.cp2.normalized_store'))"
      );
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
  const store = createCp2Store();
  const baseline = store.snapshot();
  const account = (name: string) =>
    store.continueWithChannelPin({
      channel: "email",
      destination: `${name}-${randomUUID()}@example.invalid`,
      pin: "3927"
    });
  return {
    pool,
    transaction,
    account,
    async start() {
      await transaction((client) =>
        saveTransactionalCp2Snapshot(client, store.snapshot(), baseline)
      );
      const edge = await createEdgeDomainRoutes({ transaction, approvalTransaction: transaction });
      return async (sessionId: string, method: string, path: string, body?: unknown) => {
        const response = await edge.routes(
          new Request(`https://grogoni.com${path}`, {
            method,
            headers: {
              cookie: `grogoni_session=${sessionId}`,
              ...(body === undefined ? {} : { "content-type": "application/json" })
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
          }),
          path
        );
        if (response === null) throw new Error(`No route for ${method} ${path}`);
        const text = await response.text();
        expect(response.status, text).toBe(200);
        return JSON.parse(text) as Record<string, unknown>;
      };
    }
  };
}

const fixturePublicKey = {
  kty: "EC" as const,
  crv: "P-256" as const,
  x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  y: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  ext: true
};

describe.skipIf(!databaseUrl)("direct messaging on PostgreSQL", () => {
  it("returns one conversation for concurrent creates from both sides of a pair", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("set local lock_timeout = '10s'");
        await client.query(
          "select pg_advisory_xact_lock_shared(hashtext('grogoni.cp2.normalized_store'))"
        );
        const result = await work(client);
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
    try {
      const store = createCp2Store();
      const baseline = store.snapshot();
      const a = store.continueWithChannelPin({
        channel: "email",
        destination: `dedupe-a-${randomUUID()}@example.invalid`,
        pin: "3927"
      });
      const b = store.continueWithChannelPin({
        channel: "email",
        destination: `dedupe-b-${randomUUID()}@example.invalid`,
        pin: "3927"
      });
      await transaction((client) =>
        saveTransactionalCp2Snapshot(client, store.snapshot(), baseline)
      );
      const edge = await createEdgeDomainRoutes({ transaction, approvalTransaction: transaction });
      const create = async (sessionId: string, recipient: string) => {
        const response = await edge.routes(
          new Request("https://grogoni.com/v1/conversations", {
            method: "POST",
            headers: { cookie: `grogoni_session=${sessionId}`, "content-type": "application/json" },
            body: JSON.stringify({ kind: "personal", activeShopId: null, recipient })
          }),
          "/v1/conversations"
        );
        if (response === null) throw new Error("No route for POST /v1/conversations");
        const text = await response.text();
        expect(response.status, text).toBe(200);
        return (JSON.parse(text) as { conversation: { id: string } }).conversation.id;
      };

      const ids = await Promise.all([
        create(a.session.id, b.account.primaryAuthDestination),
        create(a.session.id, b.account.primaryAuthDestination),
        create(b.session.id, a.account.primaryAuthDestination),
        create(b.session.id, a.account.primaryAuthDestination)
      ]);
      expect(new Set(ids).size).toBe(1);

      // What each person sees afterwards: exactly one chat with the other, the same one.
      for (const sessionId of [a.session.id, b.session.id]) {
        const response = await edge.routes(
          new Request("https://grogoni.com/v1/conversations", {
            method: "GET",
            headers: { cookie: `grogoni_session=${sessionId}` }
          }),
          "/v1/conversations"
        );
        const inbox = (await response!.json()) as {
          conversations: Array<{ id: string; hasHumanRecipient: boolean }>;
        };
        expect(
          inbox.conversations.filter((item) => item.hasHumanRecipient).map((item) => item.id)
        ).toEqual([ids[0]]);
      }
    } finally {
      await pool.end();
    }
  });

  it("persists Delivered when the recipient's app lists the inbox through the Edge API", async () => {
    const harness = edgeHarness();
    try {
      const a = harness.account("delivered-a");
      const b = harness.account("delivered-b");
      const call = await harness.start();
      // Device ids are unique across accounts and this database is shared by every run.
      const deviceA = `edge-delivered-${randomUUID()}`;
      const deviceB = `edge-delivered-${randomUUID()}`;
      for (const [session, deviceId] of [
        [a.session.id, deviceA],
        [b.session.id, deviceB]
      ] as const)
        await call(session, "POST", "/v1/e2ee/devices", {
          deviceId,
          label: "Test browser",
          publicKey: fixturePublicKey
        });
      const { conversation } = (await call(a.session.id, "POST", "/v1/conversations", {
        kind: "personal",
        activeShopId: null,
        recipient: b.account.primaryAuthDestination
      })) as { conversation: { id: string } };
      const sent = (await call(a.session.id, "POST", "/v1/messages", {
        conversationId: conversation.id,
        clientMessageId: `edge-delivered-${randomUUID()}`,
        content: {
          type: "encrypted",
          attachmentCount: 0,
          iv: "AAAAAAAAAAAAAAAA",
          ciphertext: btoa("edge-delivered").replaceAll("=", ""),
          envelopes: [deviceA, deviceB].map((recipientDeviceId) => ({
            version: 1,
            algorithm: "ECDH-P256-HKDF-SHA256-AES-256-GCM",
            recipientDeviceId,
            ephemeralPublicKey: fixturePublicKey,
            salt: "AAAAAAAAAAAAAAAAAAAAAA",
            iv: "AAAAAAAAAAAAAAAA",
            ciphertext: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
          }))
        }
      })) as { id: string; status: string };
      expect(sent.status).toBe("sent");
      const statusSeenBy = async (sessionId: string) =>
        (
          (await call(sessionId, "GET", `/v1/conversations/${conversation.id}`)) as {
            messages: Array<{ id: string; status: string; deliveredAt: string | null }>;
          }
        ).messages.find((message) => message.id === sent.id);
      expect(await statusSeenBy(a.session.id)).toMatchObject({ status: "sent", deliveredAt: null });
      await call(b.session.id, "GET", "/v1/conversations");
      // A new request, a new snapshot load: the status came from PostgreSQL.
      const delivered = await statusSeenBy(a.session.id);
      expect(delivered).toMatchObject({ status: "delivered" });
      expect(delivered?.deliveredAt).toEqual(expect.any(String));
    } finally {
      await harness.pool.end();
    }
  });
});
