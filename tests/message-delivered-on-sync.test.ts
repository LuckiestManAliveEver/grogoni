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

  it("shows the sender read status in its open thread's next delta read", async () => {
    const { store, a, b, conversationId, message } = await directThread();
    pullAll(store, b.session.id);
    const open = store.getConversation({ sessionId: a.session.id, conversationId });
    store.updateConversationSettings({ sessionId: b.session.id, conversationId, read: true });
    const delta = store.getConversation({
      sessionId: a.session.id,
      conversationId,
      since: open.messageCursor
    });
    expect(delta.isDelta).toBe(true);
    expect(delta.messages.find((item) => item.id === message.id)?.status).toBe("read");
  });

  it("counts delivery in a shop's conversation only from the other side", () => {
    const store = createCp2Store();
    const owner = account(store, "623");
    const customer = account(store, "624");
    const staff = account(store, "625");
    const shop = store.createBusiness({
      sessionId: owner.session.id,
      name: "Delivery shop",
      language: "en",
      phoneNumber: "+442079460626",
      phoneCountry: "GB"
    }).business;
    const invitation = store.inviteStaff({
      sessionId: owner.session.id,
      businessId: shop.id,
      role: "manager",
      inviteeName: "Staff",
      channel: "phone",
      destination: staff.account.primaryAuthDestination
    });
    store.acceptStaffInvitation({ sessionId: staff.session.id, invitationId: invitation.id });
    const conversationId = store.createConversation({
      sessionId: customer.session.id,
      kind: "storefront",
      activeShopId: shop.id
    }).conversation.id;
    const question = store.createConversationMessage({
      sessionId: customer.session.id,
      conversationId,
      clientMessageId: "customer-question-1",
      content: { type: "text", text: "Is the blue dress in stock?" }
    });
    const reply = store.createConversationMessage({
      sessionId: owner.session.id,
      conversationId,
      clientMessageId: "owner-reply-1",
      content: { type: "text", text: "Yes, size M and L." }
    });
    const status = (id: string) =>
      store
        .getConversation({ sessionId: owner.session.id, conversationId })
        .messages.find((item) => item.id === id)?.status;

    // Opening the thread or the inbox on a colleague's device is not delivery either.
    store.getConversation({ sessionId: staff.session.id, conversationId });
    store.listConversations({ sessionId: staff.session.id });
    expect(status(reply.id)).toBe("sent");
    // A colleague's device is not the customer's: the owner's reply stays sent.
    pullAll(store, staff.session.id);
    expect(status(reply.id)).toBe("sent");
    // The shop's devices did receive the customer's question.
    expect(status(question.id)).toBe("delivered");
    // The customer's device receiving the reply is delivery.
    pullAll(store, customer.session.id);
    expect(status(reply.id)).toBe("delivered");

    // A shop conversation owned by a member's account (a storefront visitor's chat belongs to the
    // owner's account): a colleague's reply is still not delivered by the owner's own device.
    const memberOwned = store.createConversation({
      sessionId: owner.session.id,
      kind: "storefront",
      activeShopId: shop.id
    }).conversation.id;
    const staffReply = store.createConversationMessage({
      sessionId: staff.session.id,
      conversationId: memberOwned,
      clientMessageId: "staff-reply-1",
      content: { type: "text", text: "I will pack it now." }
    });
    pullAll(store, owner.session.id);
    expect(
      store
        .getConversation({ sessionId: owner.session.id, conversationId: memberOwned })
        .messages.find((item) => item.id === staffReply.id)?.status
    ).toBe("sent");
  });
});
