import { describe, expect, it } from "vitest";
import type { RuntimeModelProvider } from "../packages/shared-types/src";
import { createCp2Store } from "../services/api/src/cp2/store";

// One account, two agents: its shop's agent and its Grogoni agent (a personal session with no
// shop). Since #83 every session is listed in one Chats list with its agent's badge, so "an
// independent session list per agent" means each session stays its own agent's: listed under it,
// answered by it, and carrying nothing from the other agent's sessions.
describe("agent sessions per agent", () => {
  it("keeps two agents' sessions apart in the list, in the model request and in the thread", async () => {
    const requests: string[] = [];
    const provider: RuntimeModelProvider = {
      name: "recording-fixture",
      complete: async (request) => {
        requests.push(JSON.stringify(request));
        return {
          provider: "recording-fixture",
          status: "available" as const,
          outputText: JSON.stringify({ type: "response", message: "Noted." }),
          durationMs: 1,
          errorCode: null,
          metadata: {}
        };
      }
    };
    const store = createCp2Store({ runtimeModelProvider: provider });
    const owner = store.continueWithChannelPin({
      channel: "email",
      destination: "two-agents@example.invalid",
      pin: "3927"
    });
    const shop = store.createBusiness({
      sessionId: owner.session.id,
      name: "Bravo Bakery",
      language: "en",
      phoneNumber: "+254711456791",
      phoneCountry: "KE"
    }).business;
    const session = (activeShopId: string | null) =>
      store.createConversation({ sessionId: owner.session.id, kind: "personal", activeShopId })
        .conversation;
    const shopFirst = session(shop.id);
    const shopSecond = session(shop.id);
    const grogoni = session(null);

    // The Grogoni agent's session: a plain message, no shop agent turn.
    store.createConversationMessage({
      sessionId: owner.session.id,
      conversationId: grogoni.id,
      clientMessageId: "grogoni-session-message-1",
      content: { type: "text", text: "Looking for cheap cement in Thika" }
    });
    expect(requests).toHaveLength(0);

    const askShopAgent = (conversationId: string, text: string, clientMessageId: string) =>
      store.createAgentConversationMessage({
        sessionId: owner.session.id,
        conversationId,
        businessId: shop.id,
        clientMessageId,
        content: { type: "text", text },
        message: text
      });
    await askShopAgent(shopFirst.id, "Bake 40 loaves for Saturday", "shop-session-message-1");
    await askShopAgent(shopSecond.id, "What sold best this week?", "shop-session-message-2");
    expect(requests).toHaveLength(2);
    // Each shop session is answered as the shop's agent, with nothing from the Grogoni session
    // and nothing from the other shop session.
    for (const request of requests) {
      expect(request).toContain(shop.id);
      expect(request).not.toContain("cheap cement");
    }
    expect(requests[1]).not.toContain("Bake 40 loaves");

    // Listed once each, under its own agent.
    const listed = store
      .listConversations({ sessionId: owner.session.id })
      .filter((item) => [shopFirst.id, shopSecond.id, grogoni.id].includes(item.id));
    const agentOf = Object.fromEntries(listed.map((item) => [item.id, item.activeShopId]));
    expect(agentOf).toEqual({
      [shopFirst.id]: shop.id,
      [shopSecond.id]: shop.id,
      [grogoni.id]: null
    });

    // Each thread holds only its own messages.
    const text = (conversationId: string) =>
      JSON.stringify(
        store.getConversation({ sessionId: owner.session.id, conversationId }).messages
      );
    expect(text(grogoni.id)).toContain("cheap cement");
    expect(text(grogoni.id)).not.toContain("Bake 40 loaves");
    expect(text(shopFirst.id)).not.toContain("cheap cement");
    expect(text(shopSecond.id)).not.toContain("Bake 40 loaves");
  });
});
