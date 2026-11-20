import { describe, expect, it } from "vitest";
import { createCp2Store } from "../services/api/src/cp2/store";

// The recipient picker's recents and an agent's session history are both built from the caller's
// own conversation list (GET /v1/conversations). That list must never carry another account's
// agent sessions or threads, including after the two accounts start a direct conversation.
function account(store: ReturnType<typeof createCp2Store>, suffix: string) {
  return store.continueWithChannelPin({
    channel: "phone",
    destination: `+442079460${suffix}`,
    pin: "3927"
  });
}

describe("tenant boundaries for the picker and session history", () => {
  it("lists only the caller's own conversations, before and after a direct conversation", () => {
    const store = createCp2Store();
    const a = account(store, "701");
    const b = account(store, "702");
    const shopB = store.createBusiness({
      sessionId: b.session.id,
      name: "B's shop",
      language: "en",
      phoneNumber: "+254711456782",
      phoneCountry: "KE"
    }).business;
    const bSessions = [1, 2].map(
      () =>
        store.createConversation({
          sessionId: b.session.id,
          kind: "personal",
          activeShopId: shopB.id
        }).conversation.id
    );
    const listed = (sessionId: string) =>
      store.listConversations({ sessionId }).map((item) => item.id);

    for (const id of bSessions) expect(listed(a.session.id)).not.toContain(id);

    const direct = store.createConversation({
      sessionId: a.session.id,
      kind: "personal",
      activeShopId: null,
      recipient: b.account.primaryAuthDestination
    }).conversation.id;
    // Both see the shared thread; A still sees none of B's agent sessions.
    expect(listed(a.session.id)).toContain(direct);
    expect(listed(b.session.id)).toContain(direct);
    for (const id of bSessions) expect(listed(a.session.id)).not.toContain(id);
    // And A cannot open them directly either.
    for (const id of bSessions)
      expect(() =>
        store.getConversation({ sessionId: a.session.id, conversationId: id })
      ).toThrow();
  });
});
