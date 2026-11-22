import { describe, expect, it } from "vitest";
import { createCp2Store } from "../services/api/src/cp2/store";

// An order conversation is a customer's thread with a shop about one order. Unlike a storefront
// chat (one per customer and shop, reused), every order gets its own thread, and the shop's staff
// see and answer it without being participants by name.
function setup() {
  const store = createCp2Store();
  const owner = store.continueWithChannelPin({
    channel: "email",
    destination: "order-owner@example.test",
    pin: "3927"
  });
  const customer = store.continueWithChannelPin({
    channel: "email",
    destination: "order-customer@example.test",
    pin: "3927"
  });
  const outsider = store.continueWithChannelPin({
    channel: "email",
    destination: "order-outsider@example.test",
    pin: "3927"
  });
  const shop = store.createBusiness({
    sessionId: owner.session.id,
    name: "Order Test Shop",
    language: "en",
    phoneNumber: "+254711000222",
    phoneCountry: "KE"
  }).business;
  return { store, owner, customer, outsider, shop };
}

describe("order conversations", () => {
  it("need a shop", () => {
    const { store, customer } = setup();
    expect(() =>
      store.createConversation({
        sessionId: customer.session.id,
        kind: "order",
        activeShopId: null
      })
    ).toThrow(/Choose a business/u);
  });

  it("get their own thread per order, unlike a storefront chat", () => {
    const { store, customer, shop } = setup();
    const open = (kind: "order" | "storefront") =>
      store.createConversation({ sessionId: customer.session.id, kind, activeShopId: shop.id })
        .conversation.id;
    expect(open("storefront")).toBe(open("storefront"));
    expect(open("order")).not.toBe(open("order"));
  });

  it("carry the customer's message to the shop and the shop's answer back", () => {
    const { store, owner, customer, shop } = setup();
    const conversationId = store.createConversation({
      sessionId: customer.session.id,
      kind: "order",
      activeShopId: shop.id
    }).conversation.id;
    store.createConversationMessage({
      sessionId: customer.session.id,
      conversationId,
      clientMessageId: "order-q-1",
      content: { type: "text", text: "When will order 1042 arrive?" }
    });

    const shopInbox = store.listConversations({ sessionId: owner.session.id });
    expect(shopInbox.map((item) => item.id)).toContain(conversationId);
    const thread = store.getConversation({ sessionId: owner.session.id, conversationId });
    expect(thread.conversation.kind).toBe("order");
    expect(thread.messages.map((message) => message.content)).toContainEqual(
      expect.objectContaining({ text: "When will order 1042 arrive?" })
    );

    store.createConversationMessage({
      sessionId: owner.session.id,
      conversationId,
      clientMessageId: "order-a-1",
      content: { type: "text", text: "Tomorrow before noon." }
    });
    const customerThread = store.getConversation({
      sessionId: customer.session.id,
      conversationId
    });
    expect(customerThread.messages.map((message) => message.content)).toContainEqual(
      expect.objectContaining({ text: "Tomorrow before noon." })
    );
  });

  it("are not readable by anyone else", () => {
    const { store, customer, outsider, shop } = setup();
    const conversationId = store.createConversation({
      sessionId: customer.session.id,
      kind: "order",
      activeShopId: shop.id
    }).conversation.id;
    expect(() =>
      store.getConversation({ sessionId: outsider.session.id, conversationId })
    ).toThrow();
    expect(
      store.listConversations({ sessionId: outsider.session.id }).map((item) => item.id)
    ).not.toContain(conversationId);
  });
});
