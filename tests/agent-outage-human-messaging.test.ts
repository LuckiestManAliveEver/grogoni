import { describe, expect, it } from "vitest";
import type { RuntimeModelProvider } from "../packages/shared-types/src";
import { createCp2Store } from "../services/api/src/cp2/store";

// A model outage must leave person-to-person messaging fully working: the agent turn fails on its
// own, and a customer and the shop still exchange messages in their storefront conversation.
describe("agent failure isolation", () => {
  it("keeps human messaging working while every model call throws", async () => {
    let modelCalls = 0;
    const provider: RuntimeModelProvider = {
      name: "outage-fixture",
      complete: async () => {
        modelCalls += 1;
        throw new Error("upstream model unavailable");
      }
    };
    const store = createCp2Store({ runtimeModelProvider: provider });
    const owner = store.continueWithChannelPin({
      channel: "email",
      destination: "outage-owner@example.invalid",
      pin: "3927"
    });
    const customer = store.continueWithChannelPin({
      channel: "email",
      destination: "outage-customer@example.invalid",
      pin: "3927"
    });
    const shop = store.createBusiness({
      sessionId: owner.session.id,
      name: "Outage fixture shop",
      language: "en",
      phoneNumber: "+254711456781",
      phoneCountry: "KE"
    }).business;

    // The owner's agent turn hits the outage. Whatever it reports, it must not take the store down.
    const agentChat = store.createConversation({
      sessionId: owner.session.id,
      kind: "personal",
      activeShopId: shop.id
    }).conversation;
    await Promise.resolve(
      store.createAgentConversationMessage({
        sessionId: owner.session.id,
        conversationId: agentChat.id,
        businessId: shop.id,
        clientMessageId: "outage-agent-message-1",
        content: { type: "text", text: "Count the stock" },
        message: "Count the stock"
      })
    ).catch(() => undefined);
    expect(modelCalls).toBeGreaterThan(0);

    // Human messaging both ways, during the outage.
    const storefront = store.createConversation({
      sessionId: customer.session.id,
      kind: "storefront",
      activeShopId: shop.id
    }).conversation;
    const question = store.createConversationMessage({
      sessionId: customer.session.id,
      conversationId: storefront.id,
      clientMessageId: "outage-customer-question",
      content: { type: "text", text: "Is the blue dress in stock?" }
    });
    expect(question.status).toBe("sent");
    const ownerView = store.getConversation({
      sessionId: owner.session.id,
      conversationId: storefront.id
    });
    expect(JSON.stringify(ownerView.messages)).toContain("Is the blue dress in stock?");
    const answer = store.createConversationMessage({
      sessionId: owner.session.id,
      conversationId: storefront.id,
      clientMessageId: "outage-owner-answer",
      content: { type: "text", text: "Yes, two left." }
    });
    expect(answer.status).toBe("sent");
    const customerView = store.getConversation({
      sessionId: customer.session.id,
      conversationId: storefront.id
    });
    expect(JSON.stringify(customerView.messages)).toContain("Yes, two left.");
    // The outage did not leak into the human thread as an agent reply or error message.
    expect(customerView.messages.every((message) => message.author !== "agent")).toBe(true);
  });
});
