import { describe, expect, it } from "vitest";
import { encryptDirectMessage } from "../apps/web/src/e2ee";
import { createCp2Store } from "../services/api/src/cp2/store";

// A Grogoni message is "sent" when the server accepts it. Before this, nothing ever moved it to
// "delivered": senders saw Sent, then Read. It now becomes "delivered" when the recipient's device
// pulls it down in its account sync, and the sender's device learns that through its own sync.
function account(store: ReturnType<typeof createCp2Store>, suffix: string) {
  return store.continueWithChannelPin({
    channel: "phone",
    destination: `+442079460${suffix}`,
    pin: "3927"
  });
}

async function directThread() {
  const store = createCp2Store();
  const a = account(store, "611");
  const b = account(store, "622");
  const direct = store.createConversation({
    sessionId: a.session.id,
    kind: "personal",
    activeShopId: null,
    recipient: b.account.primaryAuthDestination
  });
  for (const actor of [a, b]) {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits"
    ]);
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    store.registerE2eeDevice({
      sessionId: actor.session.id,
      deviceId: `device-${crypto.randomUUID()}`,
      label: "Delivery fixture",
      publicKey: { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y!, ext: true }
    });
  }
  const content = await encryptDirectMessage({
    conversationId: direct.conversation.id,
    devices: store.listConversationE2eeDevices({
      sessionId: a.session.id,
      conversationId: direct.conversation.id
    }),
    message: { text: "Is the order ready?", attachments: [] }
  });
  const message = store.createConversationMessage({
    sessionId: a.session.id,
    conversationId: direct.conversation.id,
    clientMessageId: "delivery-message",
    content
  });
  return { store, a, b, conversationId: direct.conversation.id, message };
}

const statusOf = (
  store: ReturnType<typeof createCp2Store>,
  sessionId: string,
  conversationId: string,
  messageId: string
) =>
  store
    .getConversation({ sessionId, conversationId })
    .messages.find((message) => message.id === messageId);

const pullAll = (store: ReturnType<typeof createCp2Store>, sessionId: string) =>
  store.pullSyncChanges({ sessionId, cursor: null, limit: 100 });

describe("delivered status for Grogoni messages", () => {
  it("stays sent until the recipient's device pulls it, then becomes delivered", async () => {
    const { store, a, b, conversationId, message } = await directThread();
    expect(message.status).toBe("sent");

    // The sender's own devices pulling their own message is not delivery.
    pullAll(store, a.session.id);
    expect(statusOf(store, a.session.id, conversationId, message.id)?.status).toBe("sent");

    pullAll(store, b.session.id);
    const delivered = statusOf(store, a.session.id, conversationId, message.id);
    expect(delivered?.status).toBe("delivered");
    expect(delivered?.deliveredAt).toEqual(expect.any(String));

    // The sender's device learns it through its sync journal.
    const senderChanges = pullAll(store, a.session.id).changes.filter(
      (change) => change.collection === "conversation_messages" && change.entityId === message.id
    );
    expect(senderChanges.at(-1)?.entity).toMatchObject({ status: "delivered" });
  });

  it("settles: pulling again changes nothing and journals nothing new", async () => {
    const { store, b, conversationId, message } = await directThread();
    pullAll(store, b.session.id);
    const deliveredAt = statusOf(store, b.session.id, conversationId, message.id)?.deliveredAt;
    const journalSize = store.snapshot().syncChanges?.length ?? 0;
    pullAll(store, b.session.id);
    pullAll(store, b.session.id);
    expect(statusOf(store, b.session.id, conversationId, message.id)?.deliveredAt).toBe(
      deliveredAt
    );
    expect(store.snapshot().syncChanges?.length ?? 0).toBe(journalSize);
  });

  it("does not downgrade a read message", async () => {
    const { store, b, conversationId, message } = await directThread();
    store.updateConversationSettings({ sessionId: b.session.id, conversationId, read: true });
    expect(statusOf(store, b.session.id, conversationId, message.id)?.status).toBe("read");
    pullAll(store, b.session.id);
    expect(statusOf(store, b.session.id, conversationId, message.id)?.status).toBe("read");
  });
});
