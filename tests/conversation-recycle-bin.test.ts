import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ConversationSummary, RecycleBinStatusSummary } from "@grogoni/shared-types";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

interface BusinessResponse {
  business: { id: string; name: string; grogoniId: string };
}

describe("conversation recycle bin", () => {
  it("moves a personal chat to the recycle bin, lists it, and restores it", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const cookie = await createAccountSession(app, "254700000101");

    const created = await postJson<{ conversation: ConversationSummary }>(
      app,
      "/v1/conversations",
      { kind: "personal", activeShopId: null, title: "Restock maize" },
      cookie
    );
    const conversationId = created.conversation.id;

    const deleted = await deleteJson<ConversationSummary>(
      app,
      `/v1/conversations/${conversationId}`,
      cookie
    );
    expect(deleted.deletedAt).toEqual(expect.any(String));
    expect(deleted.deletedByUserId).toEqual(expect.any(String));

    const inbox = await getJson<{ conversations: ConversationSummary[] }>(
      app,
      "/v1/conversations",
      cookie
    );
    expect(inbox.conversations.map((conversation) => conversation.id)).not.toContain(
      conversationId
    );

    const notFound = await app.inject({
      method: "GET",
      url: `/v1/conversations/${conversationId}`,
      headers: { cookie }
    });
    expect(notFound.statusCode).toBe(404);

    const bin = await getJson<RecycleBinStatusSummary>(
      app,
      "/v1/conversations/recycle-bin",
      cookie
    );
    expect(bin.scope).toBe("account");
    expect(bin.items).toHaveLength(1);
    const item = bin.items[0];
    expect(item).toBeDefined();
    expect(item?.conversation.id).toBe(conversationId);
    expect(Date.parse(item!.purgeAt)).toBeGreaterThan(Date.parse(item!.deletedAt));

    // Deleting it again 404s: it's already in the bin, not among the account's live conversations.
    const alreadyDeleted = await app.inject({
      method: "DELETE",
      url: `/v1/conversations/${conversationId}`,
      headers: { cookie }
    });
    expect(alreadyDeleted.statusCode).toBe(404);

    const restored = await postJson<ConversationSummary>(
      app,
      `/v1/conversations/${conversationId}/restore`,
      {},
      cookie
    );
    expect(restored.deletedAt).toBeNull();

    const inboxAfterRestore = await getJson<{ conversations: ConversationSummary[] }>(
      app,
      "/v1/conversations",
      cookie
    );
    expect(inboxAfterRestore.conversations.map((conversation) => conversation.id)).toContain(
      conversationId
    );

    const emptyBin = await getJson<RecycleBinStatusSummary>(
      app,
      "/v1/conversations/recycle-bin",
      cookie
    );
    expect(emptyBin.items).toHaveLength(0);
  });

  it("refuses to delete a conversation you aren't part of", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const ownerCookie = await createAccountSession(app, "254700000102");
    const strangerCookie = await createAccountSession(app, "254700000103");

    const created = await postJson<{ conversation: ConversationSummary }>(
      app,
      "/v1/conversations",
      { kind: "personal", activeShopId: null },
      ownerCookie
    );

    const response = await app.inject({
      method: "DELETE",
      url: `/v1/conversations/${created.conversation.id}`,
      headers: { cookie: strangerCookie }
    });
    expect(response.statusCode).toBe(404);
  });

  it("lets a shop owner delete a shop-scoped conversation and permanently empty its recycle bin", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const cookie = await createAccountSession(app, "254700000104");
    const business = await postJson<BusinessResponse>(
      app,
      "/businesses",
      { name: "Owner's Shop", language: "en" },
      cookie
    );

    const created = await postJson<{ conversation: ConversationSummary }>(
      app,
      "/v1/conversations",
      { kind: "personal", activeShopId: business.business.id },
      cookie
    );

    await deleteJson<ConversationSummary>(
      app,
      `/v1/conversations/${created.conversation.id}`,
      cookie
    );

    const bin = await getJson<RecycleBinStatusSummary>(
      app,
      `/v1/conversations/recycle-bin?businessId=${business.business.id}`,
      cookie
    );
    expect(bin.scope).toBe("business");
    expect(bin.items).toHaveLength(1);

    const emptied = await postJson<{ purged: number }>(
      app,
      "/v1/conversations/recycle-bin/empty",
      { businessId: business.business.id },
      cookie
    );
    expect(emptied.purged).toBe(1);

    const restoreAttempt = await app.inject({
      method: "POST",
      url: `/v1/conversations/${created.conversation.id}/restore`,
      headers: { cookie }
    });
    expect(restoreAttempt.statusCode).toBe(404);
  });

  it("hard-deletes a conversation once its 14-day recycle bin retention has passed", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const cookie = await createAccountSession(app, "254700000105");

    const created = await postJson<{ conversation: ConversationSummary }>(
      app,
      "/v1/conversations",
      { kind: "personal", activeShopId: null },
      cookie
    );
    await deleteJson<ConversationSummary>(
      app,
      `/v1/conversations/${created.conversation.id}`,
      cookie
    );

    const purgedTooSoon = store.purgeExpiredRecycleBinConversations(new Date());
    expect(purgedTooSoon).toBe(0);

    const fifteenDaysLater = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);
    const purged = store.purgeExpiredRecycleBinConversations(fifteenDaysLater);
    expect(purged).toBe(1);

    const bin = await getJson<RecycleBinStatusSummary>(
      app,
      "/v1/conversations/recycle-bin",
      cookie
    );
    expect(bin.items).toHaveLength(0);
  });
});

async function createAccountSession(app: FastifyInstance, destination: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ method: "phone", contact: destination, pin: "1234" })
  });
  return extractSessionCookie(response.headers["set-cookie"]);
}

async function getJson<T>(app: FastifyInstance, url: string, cookie: string): Promise<T> {
  const response = await app.inject({ method: "GET", url, headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return response.json<T>();
}

async function postJson<T>(
  app: FastifyInstance,
  url: string,
  payload: unknown,
  cookie: string
): Promise<T> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", cookie },
    payload: JSON.stringify(payload)
  });
  expect(response.statusCode).toBe(200);
  return response.json<T>();
}

async function deleteJson<T>(app: FastifyInstance, url: string, cookie: string): Promise<T> {
  const response = await app.inject({ method: "DELETE", url, headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return response.json<T>();
}

function extractSessionCookie(value: string | string[] | undefined): string {
  const cookie = Array.isArray(value) ? value[0] : value;
  if (cookie === undefined) {
    throw new Error("Session cookie missing");
  }
  return cookie.split(";", 1)[0] ?? cookie;
}
