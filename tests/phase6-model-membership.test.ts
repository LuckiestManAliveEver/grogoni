import { encryptDirectMessage, decryptDirectMessage } from "../apps/web/src/e2ee";
import { describe, expect, it } from "vitest";
import type { AiModelSummary } from "@grogoni/shared-types";
import { createCp2Store } from "../services/api/src/cp2/store";
import type { ModelRuntimeAdapter } from "../services/api/src/inference/model-runtime";

function account(store: ReturnType<typeof createCp2Store>, suffix: string) {
  return store.continueWithChannelPin({
    channel: "phone",
    destination: `+442079460${suffix}`,
    pin: "1234"
  });
}
describe("Phase 6 model selection and business revocation", () => {
  it("switches only the owned daemon's registry binding, persists history and rejects an unavailable model without changing selection", async () => {
    const prototype = createCp2Store()
      .listAiModels()
      .find((m) => m.id === "gpt-6-luna")!;
    const models: AiModelSummary[] = ["phase6-model-a", "phase6-model-b"].map((id) => ({
      ...prototype,
      id,
      label: id,
      canonicalModelId: id
    }));
    let unavailable = false;
    const resolver = ({ modelId }: { modelId: string }): ModelRuntimeAdapter | undefined =>
      models.some((m) => m.id === modelId)
        ? {
            provider: "fixture",
            executionTarget: "backend",
            canRun: async () => ({ available: !unavailable, errorCode: null, message: null }),
            healthCheck: async () => ({
              available: !unavailable,
              errorCode: unavailable ? "PROVIDER_UNAVAILABLE" : null,
              message: null,
              modelId,
              provider: "fixture",
              executionTarget: "backend",
              latencyMs: 1,
              responsePreview: null,
              retryable: unavailable
            }),
            generate: async () => {
              throw new Error("Model selection must use healthCheck.");
            }
          }
        : undefined;
    const options = { configuredModels: models, modelRuntimeAdapterResolver: resolver };
    const store = createCp2Store(options);
    const a = account(store, "421"),
      b = account(store, "422");
    const id = store.getGrogoniSessionContext({ sessionId: a.session.id }).conversationId;
    const message = store.createConversationMessage({
      sessionId: a.session.id,
      conversationId: id,
      clientMessageId: "preserved-user-message",
      content: { type: "text", text: "Remember this across model changes." }
    });
    const globalBefore = store
      .snapshot()
      .nativeRuntimeBindings!.find((binding) => binding.accountId === null);
    expect(
      (await store.selectConversationModel(a.session.id, id, models[0]!.id)).selectedModelId
    ).toBe(models[0]!.id);
    expect(
      (await store.selectConversationModel(a.session.id, id, models[1]!.id)).selectedModelId
    ).toBe(models[1]!.id);
    expect(
      store.snapshot().nativeRuntimeBindings!.find((binding) => binding.accountId === null)
    ).toEqual(globalBefore);
    expect(
      store.getConversation({ sessionId: a.session.id, conversationId: id }).messages[0]!.id
    ).toBe(message.id);
    expect(() => store.getConversationModelSelection(b.session.id, id)).toThrow();
    const restored = createCp2Store(options);
    restored.hydrateSnapshot(store.snapshot());
    expect(restored.getConversationModelSelection(a.session.id, id).selectedModelId).toBe(
      models[1]!.id
    );
    unavailable = true;
    await expect(
      restored.selectConversationModel(a.session.id, id, models[0]!.id)
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(restored.getConversationModelSelection(a.session.id, id).selectedModelId).toBe(
      models[1]!.id
    );
    // The model is unavailable, but ordinary encrypted delivery must still work.
    const direct = restored.createConversation({
      sessionId: a.session.id,
      kind: "personal",
      activeShopId: null,
      recipient: b.account.primaryAuthDestination
    });
    const keys = [];
    for (const actor of [a, b]) {
      const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
        "deriveBits"
      ]);
      const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
      const publicKey = {
        kty: "EC" as const,
        crv: "P-256" as const,
        x: jwk.x!,
        y: jwk.y!,
        ext: true
      };
      const deviceId = `device-${crypto.randomUUID()}`;
      restored.registerE2eeDevice({
        sessionId: actor.session.id,
        deviceId,
        label: "Outage fixture",
        publicKey
      });
      keys.push({ deviceId, privateKey: pair.privateKey, publicKey });
    }
    const content = await encryptDirectMessage({
      conversationId: direct.conversation.id,
      devices: restored.listConversationE2eeDevices({
        sessionId: a.session.id,
        conversationId: direct.conversation.id
      }),
      message: { text: "Human messaging during the provider outage.", attachments: [] }
    });
    const delivered = restored.createConversationMessage({
      sessionId: a.session.id,
      conversationId: direct.conversation.id,
      clientMessageId: "outage-direct-message",
      content
    });
    expect(delivered.status).toBe("delivered");
    if (content.type !== "encrypted") throw new Error("Expected encrypted content");
    expect(
      (
        await decryptDirectMessage({
          conversationId: direct.conversation.id,
          content,
          identity: keys[1]!
        })
      ).text
    ).toBe("Human messaging during the provider outage.");
  });
  it("revokes an existing business participant and pending notifications when staff membership is removed", async () => {
    const sent: string[] = [];
    const store = createCp2Store({
      pushNotificationSender: async (subscription) => {
        sent.push(subscription.accountId);
        return "sent";
      }
    });
    const owner = account(store, "423"),
      customer = account(store, "424"),
      staff = account(store, "425");
    const shop = store.createBusiness({
      sessionId: owner.session.id,
      name: "Revocation fixture",
      language: "en",
      phoneNumber: "+442079460426",
      phoneCountry: "GB"
    }).business;
    const invitation = store.inviteStaff({
      sessionId: owner.session.id,
      businessId: shop.id,
      role: "manager",
      inviteeName: "Fixture staff",
      channel: "phone",
      destination: staff.account.primaryAuthDestination
    });
    const joined = store.acceptStaffInvitation({
      sessionId: staff.session.id,
      invitationId: invitation.id
    });
    const thread = store.createConversation({
      sessionId: customer.session.id,
      kind: "storefront",
      activeShopId: shop.id
    });
    const id = thread.conversation.id;
    expect(
      store
        .getConversation({ sessionId: staff.session.id, conversationId: id })
        .participants.some((p) => p.accountId === staff.account.id)
    ).toBe(true);
    expect(() =>
      store.updateConversationSettings({
        sessionId: customer.session.id,
        conversationId: id,
        agentEnabled: true
      })
    ).toThrow();
    store.updateConversationSettings({
      sessionId: owner.session.id,
      conversationId: id,
      agentEnabled: true
    });
    for (const actor of [owner, staff])
      store.registerPushSubscription({
        sessionId: actor.session.id,
        endpoint: `https://push.example.test/${actor.account.id}`,
        expirationTime: null,
        keys: {
          auth: "AAAAAAAAAAAAAAAAAAAAAA",
          p256dh: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
        }
      });
    store.createConversationMessage({
      sessionId: customer.session.id,
      conversationId: id,
      clientMessageId: "business-message-before-revoke",
      content: { type: "text", text: "A private customer question." }
    });
    store.removeStaffMember({
      sessionId: owner.session.id,
      businessId: shop.id,
      membershipId: joined.membership.id
    });
    expect(() =>
      store.getConversation({ sessionId: staff.session.id, conversationId: id })
    ).toThrow();
    expect(() =>
      store.createConversationMessage({
        sessionId: staff.session.id,
        conversationId: id,
        clientMessageId: "removed-member-message",
        content: { type: "text", text: "forbidden" }
      })
    ).toThrow();
    expect(store.listConversations({ sessionId: staff.session.id }).some((c) => c.id === id)).toBe(
      false
    );
    await store.deliverPendingMessageNotifications();
    expect(sent).toEqual([owner.account.id]);
  });
});
