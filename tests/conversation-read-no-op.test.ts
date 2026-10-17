import { describe, expect, it } from "vitest";
import { createCp2Store } from "../services/api/src/cp2/store";

/**
 * The web app marks the open conversation read on every 4-second refresh. Each call used to
 * rewrite the participant row and record a sync change even with nothing new, so concurrent
 * requests on the conversation lost their optimistic save (40001) and answered 503.
 */
describe("marking a conversation read", () => {
  function setup() {
    const store = createCp2Store();
    const owner = store.continueWithChannelPin({
      channel: "phone",
      destination: "+254712345678",
      pin: "1234"
    });
    const businessId = store.createBusiness({
      sessionId: owner.session.id,
      name: "Read marker shop",
      language: "en",
      phoneNumber: "+254712345678",
      phoneCountry: "KE"
    }).business.id;
    const conversation = store.createConversation({
      sessionId: owner.session.id,
      kind: "personal",
      activeShopId: businessId
    }).conversation;
    const participant = () =>
      store
        .snapshot()
        .conversationParticipants.find(
          (entry) =>
            entry.conversationId === conversation.id && entry.accountId === owner.account.id
        );
    return { store, owner, conversation, participant };
  }

  it("changes nothing, and records no sync change, when nothing new is unread", () => {
    const { store, owner, conversation, participant } = setup();
    store.updateConversationSettings({
      sessionId: owner.session.id,
      conversationId: conversation.id,
      read: true,
      now: new Date("2026-10-16T10:00:00Z")
    });
    const afterFirst = structuredClone(participant());
    const syncCount = store.snapshot().syncChanges.length;
    store.updateConversationSettings({
      sessionId: owner.session.id,
      conversationId: conversation.id,
      read: true,
      now: new Date("2026-10-16T10:00:04Z")
    });
    expect(participant()).toEqual(afterFirst);
    expect(store.snapshot().syncChanges.length).toBe(syncCount);
  });

  // Marking unread messages read is covered end to end in cp20-unified-session-conversations.
  it("still saves other settings sent together with read", () => {
    const { store, owner, conversation, participant } = setup();
    const lastReadAt = participant()?.lastReadAt;
    store.updateConversationSettings({
      sessionId: owner.session.id,
      conversationId: conversation.id,
      read: true,
      pinned: true,
      now: new Date("2026-10-16T10:01:00Z")
    });
    expect(participant()?.pinnedAt).toBe("2026-10-16T10:01:00.000Z");
    expect(participant()?.lastReadAt).toBe(lastReadAt);
  });

  it("advances this participant's read point past a message someone else already marked read", () => {
    const { store, owner, conversation, participant } = setup();
    const before = participant()?.lastReadAt ?? "2026-01-01T00:00:00.000Z";
    const later = new Date(Date.parse(before) + 60_000).toISOString();
    // readAt is one value per message, shared by every participant: another participant read
    // this message, but this one has not.
    const snapshot = store.snapshot();
    snapshot.conversationMessages.push({
      id: "from-someone-else",
      conversationId: conversation.id,
      clientMessageId: "from-someone-else-client",
      idempotencyKey: "from-someone-else-key",
      author: "agent",
      authorId: "someone-else",
      content: { type: "text", text: "Your order is ready" },
      status: "read",
      createdAt: later,
      readAt: later,
      deletedAt: null
    } as never);
    store.hydrateSnapshot(snapshot);
    const readAt = new Date(Date.parse(later) + 60_000);
    store.updateConversationSettings({
      sessionId: owner.session.id,
      conversationId: conversation.id,
      read: true,
      now: readAt
    });
    expect(participant()?.lastReadAt).toBe(readAt.toISOString());
  });

  it("lists an agent's reply after the message it answers when both share a timestamp", () => {
    const { store, owner, conversation } = setup();
    const at = "2026-10-16T10:05:00.000Z";
    const base = {
      conversationId: conversation.id,
      status: "delivered",
      createdAt: at,
      readAt: at,
      deletedAt: null
    };
    const snapshot = store.snapshot();
    // Loaded reply first, as rows can arrive in any order on the Edge API.
    snapshot.conversationMessages.push(
      {
        ...base,
        id: "reply",
        clientMessageId: "reply-client",
        idempotencyKey: "reply-key",
        author: "agent",
        authorId: "agent",
        content: { type: "text", text: "Done." }
      } as never,
      {
        ...base,
        id: "question",
        clientMessageId: "question-client",
        idempotencyKey: "question-key",
        author: "user",
        authorId: owner.user.id,
        content: { type: "text", text: "Add 5 bags of sugar" }
      } as never
    );
    store.hydrateSnapshot(snapshot);
    const view = store.updateConversationSettings({
      sessionId: owner.session.id,
      conversationId: conversation.id,
      pinned: true
    });
    const ids = view.messages.map((message) => message.id);
    expect(ids.indexOf("question")).toBeLessThan(ids.indexOf("reply"));
  });
});
