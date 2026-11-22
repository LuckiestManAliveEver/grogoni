import { describe, expect, it } from "vitest";
import { createCp2Store } from "../services/api/src/cp2/store";

// A new agent session is titled deterministically from its first user message (no model call):
// whitespace collapsed, at most 60 characters. The title stays editable and is never overwritten
// by later messages.
function fixture() {
  const store = createCp2Store();
  const owner = store.continueWithChannelPin({
    channel: "email",
    destination: "auto-title@example.invalid",
    pin: "3927"
  });
  const business = store.createBusiness({
    sessionId: owner.session.id,
    name: "Title fixture",
    language: "en",
    phoneNumber: "+254711456781",
    phoneCountry: "KE"
  }).business;
  const conversation = store.createConversation({
    sessionId: owner.session.id,
    kind: "personal",
    activeShopId: business.id
  }).conversation;
  const send = (text: string, clientMessageId: string) =>
    store.createConversationMessage({
      sessionId: owner.session.id,
      conversationId: conversation.id,
      clientMessageId,
      content: { type: "text", text }
    });
  const title = () =>
    store.getConversation({ sessionId: owner.session.id, conversationId: conversation.id })
      .conversation.title;
  return { store, owner, conversation, send, title };
}

describe("agent session auto-title", () => {
  it("titles a session from its first message, deterministically and at most 60 characters", () => {
    const f = fixture();
    expect(f.title()).toBeNull();
    f.send(
      "  Please   check\nwhich products will run out this week and draft purchase orders for them  ",
      "auto-title-first"
    );
    expect(f.title()).toBe("Please check which products will run out this week and draft");
    expect(f.title()!.length).toBeLessThanOrEqual(60);
    f.send("A later message must not retitle the session", "auto-title-second");
    expect(f.title()).toBe("Please check which products will run out this week and draft");
  });

  it("keeps a title the user edited", () => {
    const f = fixture();
    f.send("Restock sugar and maize flour", "auto-title-edit-1");
    f.store.updateConversationSettings({
      sessionId: f.owner.session.id,
      conversationId: f.conversation.id,
      title: "Weekly restock"
    });
    expect(f.title()).toBe("Weekly restock");
    f.send("And cooking oil", "auto-title-edit-2");
    expect(f.title()).toBe("Weekly restock");
  });

  it("never titles a customer's storefront conversation with their message", () => {
    const store = createCp2Store();
    const owner = store.continueWithChannelPin({
      channel: "email",
      destination: "storefront-title-owner@example.invalid",
      pin: "3927"
    });
    const customer = store.continueWithChannelPin({
      channel: "email",
      destination: "storefront-title-customer@example.invalid",
      pin: "3927"
    });
    const shop = store.createBusiness({
      sessionId: owner.session.id,
      name: "Storefront title fixture",
      language: "en",
      phoneNumber: "+254711456783",
      phoneCountry: "KE"
    }).business;
    const conversationId = store.createConversation({
      sessionId: customer.session.id,
      kind: "storefront",
      activeShopId: shop.id
    }).conversation.id;
    store.createConversationMessage({
      sessionId: customer.session.id,
      conversationId,
      clientMessageId: "storefront-title-1",
      content: { type: "text", text: "Hi, my phone is 0712 345 678, is the blue dress in stock?" }
    });
    expect(
      store.getConversation({ sessionId: owner.session.id, conversationId }).conversation.title
    ).toBeNull();
  });
});
