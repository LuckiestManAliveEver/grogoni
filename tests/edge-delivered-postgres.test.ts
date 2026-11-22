import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Pool as PgPool, PoolClient } from "pg";
import { createCp2Store } from "../services/api/src/cp2/store";
import { saveTransactionalCp2Snapshot } from "../services/api/src/cp2/postgres-store";
import { createEdgeDomainRoutes } from "../services/api/src/edge-domain-routes";

// "Delivered" is written by a GET (the recipient's sync pull). Through the real Edge pipeline on
// PostgreSQL, that write must be saved and journaled back to the sender's devices.
const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const requireApi = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Pool } = requireApi("pg") as { Pool: typeof PgPool };

describe.skipIf(!databaseUrl)("delivered status on PostgreSQL (Edge)", () => {
  it("saves delivery in both directions of a shop conversation and journals it to the sender", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
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
      const owner = store.continueWithChannelPin({
        channel: "email",
        destination: `delivered-owner-${randomUUID()}@example.invalid`,
        pin: "3927"
      });
      const customer = store.continueWithChannelPin({
        channel: "email",
        destination: `delivered-customer-${randomUUID()}@example.invalid`,
        pin: "3927"
      });
      const shop = store.createBusiness({
        sessionId: owner.session.id,
        name: `Delivered shop ${randomUUID()}`,
        language: "en",
        phoneNumber: `+25471${Date.now().toString().slice(-7)}`,
        phoneCountry: "KE"
      }).business;
      const conversationId = store.createConversation({
        sessionId: customer.session.id,
        kind: "storefront",
        activeShopId: shop.id
      }).conversation.id;
      const question = store.createConversationMessage({
        sessionId: customer.session.id,
        conversationId,
        clientMessageId: `delivered-question-${randomUUID()}`,
        content: { type: "text", text: "Is the blue dress in stock?" }
      });
      expect(question.status).toBe("sent");
      const answer = store.createConversationMessage({
        sessionId: owner.session.id,
        conversationId,
        clientMessageId: `delivered-answer-${randomUUID()}`,
        content: { type: "text", text: "Yes, two left." }
      });
      expect(answer.status).toBe("sent");
      // A colleague's reply in a shop conversation owned by the owner's account (as a storefront
      // visitor's chat is): the owner's own pull is not delivery.
      const staff = store.continueWithChannelPin({
        channel: "phone",
        destination: `+44207946${String(Math.floor(Math.random() * 10_000)).padStart(4, "0")}`,
        pin: "3927"
      });
      const invitation = store.inviteStaff({
        sessionId: owner.session.id,
        businessId: shop.id,
        role: "manager",
        inviteeName: "Staff",
        channel: "phone",
        destination: staff.account.primaryAuthDestination
      });
      store.acceptStaffInvitation({ sessionId: staff.session.id, invitationId: invitation.id });
      const memberOwned = store.createConversation({
        sessionId: owner.session.id,
        kind: "storefront",
        activeShopId: shop.id
      }).conversation.id;
      const staffReply = store.createConversationMessage({
        sessionId: staff.session.id,
        conversationId: memberOwned,
        clientMessageId: `delivered-staff-${randomUUID()}`,
        content: { type: "text", text: "I will pack it now." }
      });
      await transaction((client) =>
        saveTransactionalCp2Snapshot(client, store.snapshot(), baseline)
      );
      const edge = await createEdgeDomainRoutes({ transaction });
      const pull = async (sessionId: string) => {
        const response = await edge.routes(
          new Request("https://grogoni.com/v1/sync/changes?limit=100", {
            headers: { cookie: `grogoni_session=${sessionId}` }
          }),
          "/v1/sync/changes"
        );
        expect(response?.status, await response?.clone().text()).toBe(200);
        return (await response!.json()) as {
          changes: Array<{ collection: string; entityId: string; entity: { status?: string } }>;
        };
      };

      const status = async (id: string) =>
        (
          await pool.query(
            "select record->>'status' as status, record->>'deliveredAt' as delivered_at from cp2_conversation_messages where entity_id = $1",
            [id]
          )
        ).rows[0];
      await pull(owner.session.id);
      expect(await status(question.id)).toMatchObject({ status: "delivered" });
      expect((await status(question.id)).delivered_at).toEqual(expect.any(String));
      // The owner's own device pulling the shop's reply is not delivery, nor a colleague's.
      expect(await status(answer.id)).toMatchObject({ status: "sent" });
      expect(await status(staffReply.id)).toMatchObject({ status: "sent" });

      const senderView = await pull(customer.session.id);
      const journaled = senderView.changes.filter(
        (change) => change.collection === "conversation_messages" && change.entityId === question.id
      );
      expect(journaled.at(-1)?.entity.status).toBe("delivered");
      // The customer's pull delivers the shop's reply (its Edge scope loads the shop's memberships
      // for this), and the owner's devices are told.
      expect(await status(answer.id)).toMatchObject({ status: "delivered" });
      const ownerView = await pull(owner.session.id);
      expect(
        ownerView.changes
          .filter(
            (change) =>
              change.collection === "conversation_messages" && change.entityId === answer.id
          )
          .at(-1)?.entity.status
      ).toBe("delivered");
    } finally {
      await pool.end();
    }
  }, 60_000);
});
