import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type {
  ConversationMessageSummary,
  ConversationView,
  MessageDeliveryAttemptSummary,
  MessageHandoffSummary,
  GrogoniSessionContext
} from "@grogoni/shared-types";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

interface BusinessResponse {
  business: {
    id: string;
    name: string;
    grogoniId: string;
  };
}

describe("CP20 unified account, conversation, and session foundation", () => {
  it("persists marketplace completion and validates backend AI model activation", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const sessionCookie = await createAccountSession(app, "254700000019");

    const initial = await getJson<{ completedAt: string | null }>(
      app,
      "/v1/marketplace-intro",
      sessionCookie
    );
    expect(initial.completedAt).toBeNull();
    const completed = await postJson<{ completedAt: string | null }>(
      app,
      "/v1/marketplace-intro/complete",
      { businessId: null },
      sessionCookie
    );
    expect(completed.completedAt).toEqual(expect.any(String));

    const shop = await createBusiness(app, sessionCookie, "Model Shop");
    const registry = await getJson<{
      models: Array<{
        id: string;
        available: boolean;
        source: string;
        format: string;
        license: string | null;
        downloadUrl: string | null;
      }>;
    }>(app, "/v1/ai-models", sessionCookie);
    expect(registry.models.map((model) => model.id)).toContain("qwen2.5-0.5b-android");
    expect(registry.models.filter((model) => model.source === "huggingface")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "smollm2-360m-android",
          format: "GGUF",
          license: "Apache-2.0",
          downloadUrl: expect.stringContaining("huggingface.co")
        }),
        expect.objectContaining({ id: "qwen2.5-1.5b-android", license: "Apache-2.0" })
      ])
    );

    const searchResults = await getJson<{ models: Array<{ id: string }> }>(
      app,
      "/v1/ai-models?search=qwen",
      sessionCookie
    );
    expect(searchResults.models.map((model) => model.id)).toEqual(
      expect.arrayContaining(["qwen2.5-0.5b-android", "qwen2.5-1.5b-android"])
    );

    const localFallbackSelection = await app.inject({
      method: "PUT",
      url: `/businesses/${shop.business.id}/ai-model`,
      headers: { "content-type": "application/json", cookie: sessionCookie },
      payload: JSON.stringify({ modelId: "grogoniclaw-local" })
    });
    expect(localFallbackSelection.statusCode).toBe(400);
    expect(localFallbackSelection.json().code).toBe("cloud_model_unavailable");

    const invalid = await app.inject({
      method: "PUT",
      url: `/businesses/${shop.business.id}/ai-model`,
      headers: { "content-type": "application/json", cookie: sessionCookie },
      payload: JSON.stringify({ modelId: "invented-client-model" })
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe("cloud_model_unavailable");

    const custom = await app.inject({
      method: "PUT",
      url: `/businesses/${shop.business.id}/ai-model`,
      headers: { "content-type": "application/json", cookie: sessionCookie },
      payload: JSON.stringify({ modelId: "custom:merchant-model-abc123" })
    });
    expect(custom.statusCode).toBe(400);
    expect(custom.json().code).toBe("cloud_model_unavailable");

    const github = await app.inject({
      method: "PUT",
      url: `/businesses/${shop.business.id}/ai-model`,
      headers: { "content-type": "application/json", cookie: sessionCookie },
      payload: JSON.stringify({ modelId: "github:example.android-gguf.qwen-mini-q4-k-m" })
    });
    expect(github.statusCode).toBe(400);
    expect(github.json().code).toBe("cloud_model_unavailable");

    const huggingFace = await app.inject({
      method: "PUT",
      url: `/businesses/${shop.business.id}/ai-model`,
      headers: { "content-type": "application/json", cookie: sessionCookie },
      payload: JSON.stringify({
        modelId: "huggingface:example.mobile-gguf.qwen-mini-q4-k-m"
      })
    });
    expect(huggingFace.statusCode).toBe(400);
    expect(huggingFace.json().code).toBe("cloud_model_unavailable");

    const snapshot = store.snapshot();
    expect(snapshot.marketplaceIntroStates).toHaveLength(1);
    expect(snapshot.activeAiModels).toEqual([]);
    await app.close();
  });

  it("supports an account without a shop and resolves seller permissions from memberships", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const sessionCookie = await createAccountSession(app, "254700000020");

    const initialContext = await getJson<GrogoniSessionContext>(
      app,
      "/v1/session/context",
      sessionCookie
    );
    expect(initialContext).toMatchObject({
      activeShopId: null,
      mode: "marketplace",
      activeSurface: "conversation",
      sessionVersion: 1,
      shops: []
    });
    expect(initialContext.agentId).toBe(`account-${initialContext.accountId}-agent`);
    expect(initialContext.permissions).toContain("marketplace:search");

    const missingShop = await patchJson(
      app,
      "/v1/session/context",
      {
        mode: "seller",
        activeShopId: null,
        activeSurface: "owner-controls",
        expectedSessionVersion: 1
      },
      sessionCookie
    );
    expect(missingShop.statusCode).toBe(409);
    expect(missingShop.json().code).toBe("active_shop_required");

    const firstShop = await createBusiness(app, sessionCookie, "Jane Cereals");
    const duplicateShop = await postResponse(
      app,
      "/businesses",
      { name: "Jane Shoes", language: "en" },
      sessionCookie
    );
    expect(duplicateShop.statusCode).toBe(409);
    expect(duplicateShop.json().code).toBe("store_already_registered");
    const shops = await getJson<{ shops: Array<{ business: { id: string } }> }>(
      app,
      "/v1/shops",
      sessionCookie
    );
    expect(shops.shops.map((shop) => shop.business.id)).toEqual([firstShop.business.id]);

    const sellerContextResponse = await patchJson(
      app,
      "/v1/session/context",
      {
        mode: "seller",
        activeShopId: firstShop.business.id,
        activeSurface: "owner-controls",
        expectedSessionVersion: 1
      },
      sessionCookie
    );
    expect(sellerContextResponse.statusCode).toBe(200);
    const sellerContext = sellerContextResponse.json<GrogoniSessionContext>();
    expect(sellerContext).toMatchObject({
      activeShopId: firstShop.business.id,
      mode: "seller",
      activeSurface: "owner-controls",
      sessionVersion: 2
    });
    expect(sellerContext.permissions).toEqual(
      expect.arrayContaining(["product:write", "payment:write", "membership:manage"])
    );

    const staleUpdate = await patchJson(
      app,
      "/v1/session/context",
      {
        mode: "marketplace",
        activeShopId: null,
        activeSurface: "conversation",
        expectedSessionVersion: 1
      },
      sessionCookie
    );
    expect(staleUpdate.statusCode).toBe(409);
    expect(staleUpdate.json().code).toBe("session_context_conflict");
    expect(store.snapshot().auditEvents.map((event) => event.type)).toContain(
      "session.context_updated"
    );

    await app.close();
  });

  it("gives each conversation its own session context row instead of one shared account-wide row", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const ownerCookie = await createAccountSession(app, "254700000024");
    const shop = await createBusiness(app, ownerCookie, "Two Contexts Shop");

    const personalContext = await getJson<GrogoniSessionContext>(
      app,
      "/v1/session/context",
      ownerCookie
    );
    const sellerUpdate = await patchJson(
      app,
      "/v1/session/context",
      {
        mode: "seller",
        activeShopId: shop.business.id,
        activeSurface: "owner-controls",
        expectedSessionVersion: personalContext.sessionVersion
      },
      ownerCookie
    );
    expect(sellerUpdate.statusCode).toBe(200);

    const storefrontConversation = await postJson<ConversationView>(
      app,
      "/v1/conversations",
      { kind: "storefront", activeShopId: shop.business.id },
      ownerCookie
    );

    const storefrontContext = await getJson<GrogoniSessionContext>(
      app,
      `/v1/session/context?conversationId=${storefrontConversation.conversation.id}`,
      ownerCookie
    );
    expect(storefrontContext).toMatchObject({
      conversationId: storefrontConversation.conversation.id,
      activeShopId: null,
      mode: "marketplace",
      activeSurface: "conversation",
      sessionVersion: 1
    });

    const storefrontUpdate = await patchJson(
      app,
      "/v1/session/context",
      {
        conversationId: storefrontConversation.conversation.id,
        mode: "seller",
        activeShopId: shop.business.id,
        activeSurface: "catalogue",
        expectedSessionVersion: 1
      },
      ownerCookie
    );
    expect(storefrontUpdate.statusCode).toBe(200);
    expect(storefrontUpdate.json<GrogoniSessionContext>()).toMatchObject({
      conversationId: storefrontConversation.conversation.id,
      activeSurface: "catalogue",
      sessionVersion: 2
    });

    const personalContextAfter = await getJson<GrogoniSessionContext>(
      app,
      "/v1/session/context",
      ownerCookie
    );
    expect(personalContextAfter).toMatchObject({
      conversationId: personalContext.conversationId,
      activeSurface: "owner-controls",
      sessionVersion: 2
    });

    const accountContexts = store
      .snapshot()
      .sessionContexts.filter((context) => context.accountId === personalContext.accountId);
    expect(accountContexts).toHaveLength(2);
    expect(accountContexts.map((context) => context.conversationId).sort()).toEqual(
      [personalContext.conversationId, storefrontConversation.conversation.id].sort()
    );

    await app.close();
  });

  it("lets an account hold several independent agent sessions, distinct from direct messages", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const ownerCookie = await createAccountSession(app, "254700000025");
    const friendCookie = await createAccountSession(app, "254700000026");

    const firstSession = await postJson<ConversationView>(
      app,
      "/v1/conversations",
      { kind: "personal", activeShopId: null, title: "Restock maize" },
      ownerCookie
    );
    const secondSession = await postJson<ConversationView>(
      app,
      "/v1/conversations",
      { kind: "personal", activeShopId: null, title: "Chicken feed" },
      ownerCookie
    );
    expect(secondSession.conversation.id).not.toBe(firstSession.conversation.id);

    const directMessage = await postJson<ConversationView>(
      app,
      "/v1/conversations",
      { kind: "personal", activeShopId: null, recipient: "+254700000026" },
      ownerCookie
    );

    const inbox = await getJson<{
      conversations: Array<{ id: string; title: string | null; hasHumanRecipient: boolean }>;
    }>(app, "/v1/conversations", ownerCookie);

    const sessionIds = new Set([firstSession.conversation.id, secondSession.conversation.id]);
    const agentSessions = inbox.conversations.filter((conversation) =>
      sessionIds.has(conversation.id)
    );
    expect(agentSessions).toHaveLength(2);
    expect(agentSessions.every((conversation) => !conversation.hasHumanRecipient)).toBe(true);

    const directMessageItem = inbox.conversations.find(
      (conversation) => conversation.id === directMessage.conversation.id
    );
    expect(directMessageItem?.hasHumanRecipient).toBe(true);

    const friendInbox = await getJson<{
      conversations: Array<{ id: string; hasHumanRecipient: boolean }>;
    }>(app, "/v1/conversations", friendCookie);
    expect(
      friendInbox.conversations.find(
        (conversation) => conversation.id === directMessage.conversation.id
      )?.hasHumanRecipient
    ).toBe(true);

    await app.close();
  });

  it("restores one account-wide working context on every device", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const phone = "254700000023";
    const firstDeviceCookie = await createAccountSession(app, phone);
    const firstShop = await createBusiness(app, firstDeviceCookie, "Everywhere Shop");
    const initial = await getJson<GrogoniSessionContext>(
      app,
      "/v1/session/context",
      firstDeviceCookie
    );

    const firstUpdate = await patchJson(
      app,
      "/v1/session/context",
      {
        mode: "seller",
        activeShopId: firstShop.business.id,
        activeSurface: "owner-controls",
        expectedSessionVersion: initial.sessionVersion
      },
      firstDeviceCookie
    );
    expect(firstUpdate.statusCode).toBe(200);

    const secondLogin = await postResponse(app, "/auth/pin/login", {
      method: "phone",
      contact: phone,
      pin: "1234"
    });
    expect(secondLogin.statusCode).toBe(200);
    const secondDeviceCookie = extractSessionCookie(secondLogin.headers["set-cookie"]);
    const restored = await getJson<GrogoniSessionContext>(
      app,
      "/v1/session/context",
      secondDeviceCookie
    );
    expect(restored).toMatchObject({
      accountId: initial.accountId,
      activeShopId: firstShop.business.id,
      mode: "seller",
      activeSurface: "owner-controls",
      conversationId: initial.conversationId,
      sessionVersion: initial.sessionVersion + 1
    });
    expect(restored.sessionId).not.toBe(initial.sessionId);

    const partialUpdate = await patchJson(
      app,
      "/v1/session/context",
      {
        activeSurface: "catalogue",
        expectedSessionVersion: restored.sessionVersion
      },
      secondDeviceCookie
    );
    expect(partialUpdate.statusCode).toBe(200);
    expect(partialUpdate.json<GrogoniSessionContext>()).toMatchObject({
      activeShopId: firstShop.business.id,
      mode: "seller",
      activeSurface: "catalogue",
      conversationId: initial.conversationId,
      sessionVersion: restored.sessionVersion + 1
    });

    const visibleOnFirstDevice = await getJson<GrogoniSessionContext>(
      app,
      "/v1/session/context",
      firstDeviceCookie
    );
    expect(visibleOnFirstDevice).toMatchObject({
      activeSurface: "catalogue",
      sessionVersion: restored.sessionVersion + 1
    });
    expect(store.snapshot().sessionContexts).toEqual([
      expect.objectContaining({ accountId: initial.accountId })
    ]);

    await app.close();
  });

  it("keeps conversations account-scoped and messages idempotent across persistence", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const ownerCookie = await createAccountSession(app, "254700000021");
    const strangerCookie = await createAccountSession(app, "254700000022");
    const shop = await createBusiness(app, ownerCookie, "Conversation Shop");
    const context = await getJson<GrogoniSessionContext>(app, "/v1/session/context", ownerCookie);

    const conversation = await postJson<ConversationView>(
      app,
      "/v1/conversations",
      { kind: "storefront", activeShopId: shop.business.id },
      ownerCookie
    );
    expect(conversation.participants.map((participant) => participant.role)).toEqual(
      expect.arrayContaining(["account", "agent", "shop"])
    );

    const payload = {
      conversationId: conversation.conversation.id,
      clientMessageId: "android-message-0001",
      idempotencyKey: "offline-message-attempt-0001",
      content: { type: "text", text: "Do you have 10 kg of maize flour?" },
      clientTimestamp: "2026-07-11T21:04:27+03:00",
      queuedAt: "2026-07-11T18:04:20.000Z",
      selectedChannel: "grogoni"
    };
    const firstMessage = await postJson<ConversationMessageSummary>(
      app,
      "/v1/messages",
      payload,
      ownerCookie
    );
    const repeatedMessage = await postJson<ConversationMessageSummary>(
      app,
      "/v1/messages",
      { ...payload, clientMessageId: "android-message-retry-0002" },
      ownerCookie
    );
    expect(repeatedMessage.id).toBe(firstMessage.id);
    expect(firstMessage).toMatchObject({
      idempotencyKey: payload.idempotencyKey,
      status: "delivered",
      queuedAt: payload.queuedAt,
      sentAt: expect.any(String),
      deliveredAt: expect.any(String),
      retryCount: 0,
      selectedChannel: "grogoni",
      actualChannel: "grogoni",
      failureCode: null
    });
    const attempts = await getJson<{ attempts: MessageDeliveryAttemptSummary[] }>(
      app,
      `/v1/conversations/${conversation.conversation.id}/messages/${firstMessage.id}/delivery-attempts`,
      ownerCookie
    );
    expect(attempts.attempts).toEqual([
      expect.objectContaining({
        accountId: context.accountId,
        conversationId: conversation.conversation.id,
        messageId: firstMessage.id,
        channel: "grogoni",
        provider: "grogoni",
        attemptNumber: 1,
        result: "succeeded"
      })
    ]);

    const forbiddenConversation = await getResponse(
      app,
      `/v1/conversations/${conversation.conversation.id}`,
      strangerCookie
    );
    expect(forbiddenConversation.statusCode).toBe(404);
    const forbiddenAttempts = await getResponse(
      app,
      `/v1/conversations/${conversation.conversation.id}/messages/${firstMessage.id}/delivery-attempts`,
      strangerCookie
    );
    expect(forbiddenAttempts.statusCode).toBe(404);

    const unavailableChannel = await postResponse(
      app,
      "/v1/messages",
      {
        ...payload,
        clientMessageId: "android-message-sms-0003",
        idempotencyKey: "offline-message-attempt-0003",
        selectedChannel: "sms"
      },
      ownerCookie
    );
    expect(unavailableChannel.statusCode).toBe(400);
    expect(unavailableChannel.json().code).toBe("message_channel_unavailable");

    const handoff = await postJson<MessageHandoffSummary>(
      app,
      "/v1/message-handoffs",
      {
        businessId: shop.business.id,
        conversationId: conversation.conversation.id,
        channel: "sms_external_app",
        status: "composer_opened",
        normalizedErrorCode: null
      },
      ownerCookie
    );
    expect(handoff).toMatchObject({
      accountId: context.accountId,
      businessId: shop.business.id,
      conversationId: conversation.conversation.id,
      channel: "sms_external_app",
      status: "composer_opened",
      normalizedErrorCode: null
    });

    const platformHandoff = await postJson<MessageHandoffSummary>(
      app,
      "/v1/message-handoffs",
      {
        businessId: shop.business.id,
        conversationId: conversation.conversation.id,
        channel: "platform_share_sheet",
        status: "share_completed",
        normalizedErrorCode: null
      },
      ownerCookie
    );
    expect(platformHandoff).toMatchObject({
      accountId: context.accountId,
      channel: "platform_share_sheet",
      status: "share_completed",
      normalizedErrorCode: null
    });

    const ownerControlsOutsideSellerMode = await postResponse(
      app,
      "/v1/messages",
      {
        conversationId: context.conversationId,
        clientMessageId: "owner-controls-0001",
        content: { type: "owner-controls", shopId: shop.business.id }
      },
      ownerCookie
    );
    expect(ownerControlsOutsideSellerMode.statusCode).toBe(403);
    expect(ownerControlsOutsideSellerMode.json().code).toBe("seller_context_required");

    const snapshot = store.snapshot();
    await app.close();

    const hydratedStore = createCp2Store();
    hydratedStore.hydrateSnapshot(snapshot);
    const hydratedApp = buildApi({ cp2: { store: hydratedStore } });
    const restored = await getJson<ConversationView>(
      hydratedApp,
      `/v1/conversations/${conversation.conversation.id}`,
      ownerCookie
    );
    expect(restored.messages).toHaveLength(1);
    expect(restored.messages[0]?.id).toBe(firstMessage.id);
    expect(restored.messages[0]).toMatchObject({
      idempotencyKey: payload.idempotencyKey,
      selectedChannel: "grogoni",
      actualChannel: "grogoni"
    });
    expect(hydratedStore.snapshot().messageDeliveryAttempts).toHaveLength(1);
    const hydratedAuditEvents = hydratedStore.snapshot().auditEvents;
    expect(hydratedAuditEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining(["conversation.created", "message.created", "message.handoff"])
    );
    const handoffAudit = hydratedAuditEvents.find((event) => event.type === "message.handoff");
    expect(JSON.stringify(handoffAudit)).not.toContain("Hello");
    expect(JSON.stringify(handoffAudit)).not.toContain("+254");

    await hydratedApp.close();
  });

  it("adds discussion participants, alerts the receiver, persists membership and keeps message encryption", async () => {
    const deliveries: string[] = [];
    const store = createCp2Store({
      pushNotificationSender: async (_subscription, payload) => {
        deliveries.push(JSON.stringify(payload));
        return "sent";
      }
    });
    const app = buildApi({ cp2: { store, vapidPublicKey: "test-vapid-public-key" } });
    const owner = await createAccountSession(app, "254700000071");
    const contact = await createAccountSession(app, "254700000072");
    const third = await createAccountSession(app, "254700000073");
    await postJson(
      app,
      "/v1/push/subscriptions",
      {
        endpoint: "https://push.example.test/group-contact",
        expirationTime: null,
        keys: {
          auth: "AAAAAAAAAAAAAAAAAAAAAA",
          p256dh: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
        }
      },
      contact
    );
    const created = await postJson<ConversationView>(
      app,
      "/v1/conversations",
      {
        kind: "personal",
        activeShopId: null,
        recipient: "+254700000072",
        title: "Group discussion"
      },
      owner
    );
    const path = `/v1/conversations/${created.conversation.id}/participants`;
    const unauthorized = await postResponse(app, path, { recipient: "+254700000073" }, contact);
    expect(unauthorized.statusCode).toBe(403);
    const outsider = await postResponse(app, path, { agent: true }, third);
    expect(outsider.statusCode).toBe(404);
    const missing = await postResponse(app, path, { recipient: "+254700000099" }, owner);
    expect(missing.statusCode).toBe(404);
    const withAgent = await postJson<ConversationView>(app, path, { agent: true }, owner);
    expect(withAgent.participants.filter((p) => p.role === "agent")).toHaveLength(1);
    const added = await postJson<ConversationView>(
      app,
      path,
      { recipient: "+254700000073" },
      owner
    );
    expect(added.participants.filter((p) => p.role === "account")).toHaveLength(3);
    expect(added.messages.at(-1)).toMatchObject({ author: "system", content: { type: "text" } });
    const retry = await postJson<ConversationView>(
      app,
      path,
      { recipient: "+254700000073" },
      owner
    );
    expect(retry.participants).toHaveLength(added.participants.length);
    expect(retry.messages).toHaveLength(added.messages.length);
    await getJson(app, `/v1/conversations/${created.conversation.id}`, third);
    const plaintext = await postResponse(
      app,
      "/v1/messages",
      {
        conversationId: created.conversation.id,
        clientMessageId: "group-plaintext-test",
        content: { type: "text", text: "private" }
      },
      owner
    );
    expect(plaintext.statusCode).toBe(400);
    expect(plaintext.json().code).toBe("e2ee_required");
    await registerEncryptionDevice(app, owner, "group-owner-device");
    await registerEncryptionDevice(app, contact, "group-contact-device");
    await registerEncryptionDevice(app, third, "group-third-device");
    await postJson(
      app,
      "/v1/messages",
      {
        conversationId: created.conversation.id,
        clientMessageId: "group-encrypted-test",
        content: encryptedFixture(
          ["group-owner-device", "group-contact-device", "group-third-device"],
          "group ciphertext"
        )
      },
      owner
    );
    await store.deliverPendingMessageNotifications({});
    expect(deliveries.some((payload) => payload.includes("added to your discussion"))).toBe(true);
    const hydrated = createCp2Store();
    hydrated.hydrateSnapshot(store.snapshot());
    const hydratedApp = buildApi({ cp2: { store: hydrated } });
    const restored = await getJson<ConversationView>(
      hydratedApp,
      `/v1/conversations/${created.conversation.id}`,
      third
    );
    expect(restored.participants).toHaveLength(4);
    await app.close();
    await hydratedApp.close();
  });

  it("supports full direct-message lifecycle across two accounts", async () => {
    const deliveries: Array<{ endpoint: string; body: string }> = [];
    const store = createCp2Store({
      pushNotificationSender: async (subscription, payload) => {
        deliveries.push({ endpoint: subscription.endpoint, body: JSON.stringify(payload) });
        return "sent";
      }
    });
    const app = buildApi({ cp2: { store, vapidPublicKey: "test-vapid-public-key" } });
    const senderCookie = await createAccountSession(app, "254700000031");
    const recipientCookie = await createAccountSession(app, "254700000032");
    const senderDeviceId = "device-sender-00000001";
    const recipientDeviceId = "device-recipient-0001";
    await registerEncryptionDevice(app, senderCookie, senderDeviceId);
    await registerEncryptionDevice(app, recipientCookie, recipientDeviceId);
    const pushConfig = await getJson<{ enabled: boolean; publicKey: string }>(
      app,
      "/v1/push/config",
      recipientCookie
    );
    expect(pushConfig).toEqual({ enabled: true, publicKey: "test-vapid-public-key" });
    await postJson(
      app,
      "/v1/push/subscriptions",
      {
        endpoint: "https://push.example.test/recipient",
        expirationTime: null,
        keys: {
          auth: "AAAAAAAAAAAAAAAAAAAAAA",
          p256dh: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
        }
      },
      recipientCookie
    );

    const conversation = await postJson<ConversationView>(
      app,
      "/v1/conversations",
      {
        kind: "personal",
        activeShopId: null,
        recipient: "+254700000032",
        title: "Delivery coordination"
      },
      senderCookie
    );
    expect(
      conversation.participants.filter((participant) => participant.role === "account")
    ).toHaveLength(2);

    const plaintextRejected = await postResponse(
      app,
      "/v1/messages",
      {
        conversationId: conversation.conversation.id,
        clientMessageId: "direct-plaintext-0001",
        content: { type: "text", text: "This must never reach storage." }
      },
      senderCookie
    );
    expect(plaintextRejected.statusCode).toBe(400);
    expect(plaintextRejected.json()).toMatchObject({ code: "e2ee_required" });

    const sent = await postJson<ConversationMessageSummary>(
      app,
      "/v1/messages",
      {
        conversationId: conversation.conversation.id,
        clientMessageId: "direct-message-0001",
        content: encryptedFixture([senderDeviceId, recipientDeviceId], "ciphertext-one"),
        clientTimestamp: "2026-07-15T12:00:00.000Z"
      },
      senderCookie
    );
    expect(sent).toMatchObject({ status: "delivered", deliveredAt: expect.any(String) });
    expect(sent.content).toMatchObject({ type: "encrypted", attachmentCount: 1 });
    await Promise.resolve();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ endpoint: "https://push.example.test/recipient" });
    expect(deliveries[0]?.body).not.toContain("The order is ready");
    expect(JSON.stringify(store.snapshot().conversationMessages)).not.toContain(
      "The order is ready"
    );

    const recipientInbox = await getJson<{
      conversations: Array<{ id: string; unreadCount: number }>;
    }>(app, "/v1/conversations", recipientCookie);
    expect(recipientInbox.conversations).toContainEqual(
      expect.objectContaining({ id: conversation.conversation.id, unreadCount: 1 })
    );

    const typing = await postJson<{ typing: Array<{ displayName: string }> }>(
      app,
      `/v1/conversations/${conversation.conversation.id}/typing`,
      { typing: true },
      recipientCookie
    );
    expect(typing.typing).toEqual(expect.any(Array));

    const markedRead = await patchJson(
      app,
      `/v1/conversations/${conversation.conversation.id}`,
      { read: true, pinned: true },
      recipientCookie
    );
    expect(markedRead.statusCode).toBe(200);
    expect(markedRead.json<ConversationView>().messages[0]).toMatchObject({
      status: "read",
      readAt: expect.any(String)
    });

    const edited = await patchJson(
      app,
      `/v1/conversations/${conversation.conversation.id}/messages/${sent.id}`,
      { content: encryptedFixture([senderDeviceId, recipientDeviceId], "ciphertext-two") },
      senderCookie
    );
    expect(edited.statusCode).toBe(200);
    expect(edited.json<ConversationMessageSummary>()).toMatchObject({
      editedAt: expect.any(String),
      content: { type: "encrypted" }
    });

    const reacted = await patchJson(
      app,
      `/v1/conversations/${conversation.conversation.id}/messages/${sent.id}`,
      { reaction: "👍" },
      recipientCookie
    );
    expect(reacted.json<ConversationMessageSummary>().reactions).toHaveLength(1);

    const deleted = await patchJson(
      app,
      `/v1/conversations/${conversation.conversation.id}/messages/${sent.id}`,
      { deleted: true },
      senderCookie
    );
    expect(deleted.json<ConversationMessageSummary>()).toMatchObject({
      deletedAt: expect.any(String),
      content: { type: "encrypted" }
    });

    await app.close();
  });
});

const fixturePublicKey = {
  kty: "EC" as const,
  crv: "P-256" as const,
  x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  y: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  ext: true
};

async function registerEncryptionDevice(
  app: FastifyInstance,
  cookie: string,
  deviceId: string
): Promise<void> {
  await postJson(
    app,
    "/v1/e2ee/devices",
    {
      deviceId,
      label: "Test browser",
      publicKey: fixturePublicKey
    },
    cookie
  );
}

function encryptedFixture(deviceIds: string[], ciphertextSeed: string) {
  return {
    type: "encrypted",
    attachmentCount: 1,
    iv: "AAAAAAAAAAAAAAAA",
    ciphertext: btoa(ciphertextSeed).replaceAll("=", ""),
    envelopes: deviceIds.map((recipientDeviceId) => ({
      version: 1,
      algorithm: "ECDH-P256-HKDF-SHA256-AES-256-GCM",
      recipientDeviceId,
      ephemeralPublicKey: fixturePublicKey,
      salt: "AAAAAAAAAAAAAAAAAAAAAA",
      iv: "AAAAAAAAAAAAAAAA",
      ciphertext: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
    }))
  };
}

async function createAccountSession(app: FastifyInstance, destination: string): Promise<string> {
  const response = await postResponse(app, "/auth/pin/signup", {
    method: "phone",
    contact: destination,
    pin: "1234"
  });
  return extractSessionCookie(response.headers["set-cookie"]);
}

function createBusiness(
  app: FastifyInstance,
  cookie: string,
  name: string
): Promise<BusinessResponse> {
  return postJson<BusinessResponse>(app, "/businesses", { name, language: "en" }, cookie);
}

async function getJson<T>(app: FastifyInstance, url: string, cookie: string): Promise<T> {
  const response = await getResponse(app, url, cookie);
  expect(response.statusCode).toBe(200);
  return response.json<T>();
}

function getResponse(app: FastifyInstance, url: string, cookie: string) {
  return app.inject({ method: "GET", url, headers: { cookie } });
}

async function postJson<T>(
  app: FastifyInstance,
  url: string,
  payload: unknown,
  cookie?: string
): Promise<T> {
  const response = await postResponse(app, url, payload, cookie);
  expect(response.statusCode).toBe(200);
  return response.json<T>();
}

function postResponse(app: FastifyInstance, url: string, payload: unknown, cookie?: string) {
  return app.inject({
    method: "POST",
    url,
    headers: {
      "content-type": "application/json",
      ...(cookie === undefined ? {} : { cookie })
    },
    payload: JSON.stringify(payload)
  });
}

function patchJson(app: FastifyInstance, url: string, payload: unknown, cookie: string) {
  return app.inject({
    method: "PATCH",
    url,
    headers: { "content-type": "application/json", cookie },
    payload: JSON.stringify(payload)
  });
}

function extractSessionCookie(value: string | string[] | undefined): string {
  const cookie = Array.isArray(value) ? value[0] : value;

  if (cookie === undefined) {
    throw new Error("Session cookie missing");
  }

  return cookie.split(";", 1)[0] ?? cookie;
}
