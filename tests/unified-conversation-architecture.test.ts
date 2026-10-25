import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function setup(snapshot?: ReturnType<ReturnType<typeof createCp2Store>["snapshot"]>) {
  const store = createCp2Store();
  if (snapshot) store.hydrateSnapshot(snapshot);
  const app = buildApi({ cp2: { store } });
  apps.push(app);
  return { store, app };
}
async function account(app: FastifyInstance, contact: string) {
  const response = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    payload: { method: "phone", contact, pin: "1234" }
  });
  expect(response.statusCode).toBe(200);
  const value = response.headers["set-cookie"];
  return (Array.isArray(value) ? value[0]! : value!).split(";")[0]!;
}
async function request(
  app: FastifyInstance,
  cookie: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: object
) {
  return app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
}

describe("Phase 6 unified conversation authority", () => {
  it("reuses direct pairs in both directions under concurrency and never adopts a direct chat as the daemon", async () => {
    const { app, store } = setup();
    const alice = await account(app, "+254700090001");
    const bob = await account(app, "+254700090002");
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request(app, i % 2 ? alice : bob, "POST", "/v1/conversations", {
          kind: "personal",
          activeShopId: null,
          recipient: i % 2 ? "+254700090002" : "+254700090001"
        })
      )
    );
    expect(results.every((response) => response.statusCode === 200)).toBe(true);
    const ids = new Set(results.map((response) => response.json().conversation.id));
    expect(ids.size).toBe(1);
    const direct = results[0]!.json();
    expect(direct.conversation).toMatchObject({
      conversationType: "DIRECT",
      runtimeBindingId: null
    });
    expect(direct.participants.map((participant: { role: string }) => participant.role)).toEqual([
      "account",
      "account"
    ]);
    const inbox = (await request(app, alice, "GET", "/v1/conversations")).json().conversations;
    const daemon = inbox.find((item: { isPermanentDaemon?: boolean }) => item.isPermanentDaemon);
    expect(daemon.conversationType).toBe("DAEMON");
    expect(daemon.id).not.toBe(direct.conversation.id);
    const restored = setup(store.snapshot());
    const reloaded = (await request(restored.app, alice, "GET", "/v1/conversations")).json()
      .conversations;
    expect(
      reloaded.find((item: { isPermanentDaemon?: boolean }) => item.isPermanentDaemon).id
    ).toBe(daemon.id);
    expect((await request(app, alice, "DELETE", `/v1/conversations/${daemon.id}`)).statusCode).toBe(
      400
    );
    expect(
      (await request(app, alice, "PATCH", `/v1/conversations/${daemon.id}`, { archived: true }))
        .statusCode
    ).toBe(400);
  });

  it("delivers customer messages to the authorized business inbox and preserves shared replies across restart", async () => {
    const { app, store } = setup();
    const owner = await account(app, "+254700090003");
    const buyer = await account(app, "+254700090004");
    const stranger = await account(app, "+254700090005");
    const business = (
      await request(app, owner, "POST", "/businesses", { name: "Unified Shop", language: "en" })
    ).json().business;
    const creations = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app, buyer, "POST", "/v1/conversations", {
          kind: "storefront",
          activeShopId: business.id
        })
      )
    );
    expect(new Set(creations.map((response) => response.json().conversation.id)).size).toBe(1);
    const conversation = creations[0]!.json().conversation;
    expect(conversation.conversationType).toBe("BUSINESS");
    const message = {
      conversationId: conversation.id,
      clientMessageId: "customer-message-0001",
      content: { type: "text", text: "Is the shop open?" }
    };
    const submissions = await Promise.all(
      Array.from({ length: 5 }, () => request(app, buyer, "POST", "/v1/messages", message))
    );
    expect(submissions.every((response) => response.statusCode === 200)).toBe(true);
    expect(new Set(submissions.map((response) => response.json().id)).size).toBe(1);
    const ownerInbox = (await request(app, owner, "GET", "/v1/conversations")).json().conversations;
    expect(ownerInbox.find((item: { id: string }) => item.id === conversation.id)).toMatchObject({
      conversationType: "BUSINESS",
      hasHumanRecipient: false,
      lastMessage: { content: { text: "Is the shop open?" } }
    });
    const reply = await request(app, owner, "POST", "/v1/messages", {
      ...message,
      clientMessageId: "business-reply-0001",
      content: { type: "text", text: "Yes, welcome." }
    });
    expect(reply.statusCode).toBe(200);
    expect(
      (await request(app, stranger, "GET", `/v1/conversations/${conversation.id}`)).statusCode
    ).toBe(404);
    expect(
      (
        await request(app, stranger, "POST", "/v1/messages", {
          ...message,
          clientMessageId: "unauthorized-0001"
        })
      ).statusCode
    ).toBe(404);
    expect(store.snapshot().runtimeTurns).toHaveLength(0);
    const restored = setup(store.snapshot());
    const history = (
      await request(restored.app, buyer, "GET", `/v1/conversations/${conversation.id}`)
    ).json();
    expect(
      history.messages.map((item: { content: { text: string } }) => item.content.text)
    ).toEqual(["Is the shop open?", "Yes, welcome."]);
  });

  it("opens registered phonebook contacts without accepting another owner's node", async () => {
    const { app } = setup();
    const alice = await account(app, "+254700090008");
    await account(app, "+254700090009");
    const stranger = await account(app, "+254700090010");
    const synced = await request(app, alice, "POST", "/network/sync/contacts", {
      contacts: [{ name: "My contact", phone: "+254700090009" }]
    });
    expect(synced.statusCode).toBe(200);
    const nodeId = synced.json().syncedContactNodeIds[0];
    const opened = await request(app, alice, "POST", "/v1/conversations", {
      kind: "personal",
      activeShopId: null,
      recipient: `network-node:${nodeId}`
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.json().conversation.conversationType).toBe("DIRECT");
    const byNumber = await request(app, alice, "POST", "/v1/conversations", {
      kind: "personal",
      activeShopId: null,
      recipient: "+254700090009"
    });
    expect(byNumber.json().conversation.id).toBe(opened.json().conversation.id);
    expect(
      (
        await request(app, stranger, "POST", "/v1/conversations", {
          kind: "personal",
          activeShopId: null,
          recipient: `network-node:${nodeId}`
        })
      ).statusCode
    ).toBe(404);
  });

  it("rejects agent tenant substitution before storing a message", async () => {
    const { app, store } = setup();
    const owner = await account(app, "+254700090006");
    const buyer = await account(app, "+254700090007");
    const business = (
      await request(app, owner, "POST", "/businesses", { name: "Scoped Shop", language: "en" })
    ).json().business;
    const conversation = (
      await request(app, buyer, "POST", "/v1/conversations", {
        kind: "storefront",
        activeShopId: business.id
      })
    ).json().conversation;
    const response = await request(app, buyer, "POST", "/v1/messages", {
      conversationId: conversation.id,
      clientMessageId: "tenant-substitution-01",
      content: { type: "text", text: "private records" },
      agent: { businessId: "other-business", message: "private records" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("conversation_business_mismatch");
    expect(
      store
        .snapshot()
        .conversationMessages.filter((message) => message.conversationId === conversation.id)
    ).toHaveLength(0);
  });
});
