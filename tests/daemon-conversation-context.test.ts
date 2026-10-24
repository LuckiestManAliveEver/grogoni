import { expect, it } from "vitest";
import { createCp2Store } from "../services/api/src/cp2/store";
it("restores only the originating daemon's earlier context and rejects another owner", () => {
  const store = createCp2Store();
  const a = store.continueWithChannelPin({
    channel: "phone",
    destination: "+442079460571",
    pin: "1234"
  });
  const b = store.continueWithChannelPin({
    channel: "phone",
    destination: "+442079460572",
    pin: "1234"
  });
  const id = store.getGrogoniSessionContext({ sessionId: a.session.id }).conversationId;
  const other = store.createConversation({
    sessionId: a.session.id,
    kind: "personal",
    activeShopId: null,
    title: "Other daemon context"
  }).conversation.id;
  store.createConversationMessage({
    sessionId: a.session.id,
    conversationId: other,
    clientMessageId: "other-secret",
    content: { type: "text", text: "UNRELATED-SECRET" }
  });
  store.createConversationMessage({
    sessionId: a.session.id,
    conversationId: id,
    clientMessageId: "origin-secret",
    content: { type: "text", text: "Remember ALPHA-571" }
  });
  store.createConversationMessage({
    sessionId: a.session.id,
    conversationId: id,
    clientMessageId: "origin-followup",
    content: { type: "text", text: "What did I ask you to remember?" }
  });
  store.createConversationMessage({
    sessionId: a.session.id,
    conversationId: id,
    clientMessageId: "future-message",
    content: { type: "text", text: "FUTURE-SECRET" }
  });
  const restored = createCp2Store();
  restored.hydrateSnapshot(store.snapshot());
  expect(restored.daemonConversationHistory(a.user.id, id, "origin-followup", new Date())).toEqual([
    { role: "user", content: "Remember ALPHA-571" }
  ]);
  expect(() =>
    restored.daemonConversationHistory(b.user.id, id, "origin-followup", new Date())
  ).toThrow();
});
