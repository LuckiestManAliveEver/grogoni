import { describe, expect, it } from "vitest";
import type { RuntimeModelProvider } from "../packages/shared-types/src";
import { createCp2Store } from "../services/api/src/cp2/store";

// Two agent sessions (conversations) of one shop: what session A was told must never reach the
// model request built for session B. Asserts on the exact requests the server sends the model.
describe("agent session context isolation", () => {
  it("builds session B's model request without anything from session A", async () => {
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
    // The deterministic provider's catalogue, as the PostgreSQL queue test does.
    const owner = store.continueWithChannelPin({
      channel: "email",
      destination: "session-isolation@example.invalid",
      pin: "3927"
    });
    const business = store.createBusiness({
      sessionId: owner.session.id,
      name: "Isolation fixture",
      language: "en",
      phoneNumber: "+254711456780",
      phoneCountry: "KE"
    }).business;
    const conversation = () =>
      store.createConversation({
        sessionId: owner.session.id,
        kind: "personal",
        activeShopId: business.id
      }).conversation;
    const sessionA = conversation();
    const sessionB = conversation();
    const send = (conversationId: string, text: string, clientMessageId: string) =>
      store.createAgentConversationMessage({
        sessionId: owner.session.id,
        conversationId,
        businessId: business.id,
        clientMessageId,
        content: { type: "text", text },
        message: text
      });

    const secret = "The back door code is TANGERINE-4417";
    await send(sessionA.id, secret, "session-a-message-1");
    const fromA = requests.length;
    expect(fromA).toBeGreaterThan(0);
    // Positive control: session A's own request did carry the fact.
    expect(requests.some((request) => request.includes("TANGERINE-4417"))).toBe(true);

    await send(sessionB.id, "What is the back door code?", "session-b-message-1");
    const fromB = requests.slice(fromA);
    expect(fromB.length).toBeGreaterThan(0);
    for (const request of fromB) expect(request).not.toContain("TANGERINE-4417");

    // And B's thread holds none of A's messages.
    const threadB = store.getConversation({
      sessionId: owner.session.id,
      conversationId: sessionB.id
    }).messages;
    expect(JSON.stringify(threadB)).not.toContain("TANGERINE-4417");
  });
});
