import { describe, expect, it } from "vitest";
import type { PublicDaemonTask } from "@grogoni/shared-types";
import { createCp2Store } from "../services/api/src/cp2/store";

function fixture() {
  const sent: unknown[] = [];
  const store = createCp2Store({
    pushNotificationSender: async (_subscription, payload) => {
      sent.push(payload);
      return "sent";
    }
  });
  const actor = store.continueWithChannelPin({
    channel: "phone",
    destination: "+442079460112",
    pin: "1234"
  });
  const context = store.getGrogoniSessionContext({ sessionId: actor.session.id });
  const conversationId = context.conversationId;
  store.createConversationMessage({
    sessionId: actor.session.id,
    conversationId,
    clientMessageId: "origin-user-message",
    content: { type: "text", text: "Remember this." }
  });
  const task: PublicDaemonTask = {
    id: "11111111-1111-4111-8111-111111111111",
    key: "user-task",
    payload: {
      kind: "agent",
      message: "Remember this.",
      modelId: "selected",
      agentAdapterId: "grogoni",
      conversation: {
        id: conversationId,
        clientMessageId: "origin-user-message",
        scope: "test",
        kind: "reply"
      }
    },
    status: "completed",
    runAt: new Date().toISOString(),
    intervalMs: null,
    attempts: 1,
    maxAttempts: 3,
    executions: 1,
    leaseUntil: null,
    result: { text: "I remember." },
    errorCode: null,
    lane: "server",
    createdAt: new Date(Date.now() - 1000).toISOString(),
    updatedAt: new Date().toISOString()
  };
  return { store, actor, task, conversationId, sent };
}
describe("Phase 6 durable daemon message projection", () => {
  it("delivers into the existing history exactly once without an authenticated browser", () => {
    const { store, actor, task, conversationId } = fixture();
    store.deliverDaemonTask(task, actor.user.id);
    store.deliverDaemonTask(task, actor.user.id);
    const view = store.getConversation({ sessionId: actor.session.id, conversationId });
    expect(view.messages).toHaveLength(2);
    expect(view.messages[1]).toMatchObject({
      author: "agent",
      content: { type: "text", text: "I remember." },
      replyToMessageId: view.messages[0]!.id,
      execution: { status: "completed", modelId: "selected" }
    });
    expect(view.messages[0]!.execution?.status).toBe("completed");
  });
  it("rejects cross-account projection and preserves failed-task history through successful retry", () => {
    const { store, actor, task, conversationId } = fixture();
    const stranger = store.continueWithChannelPin({
      channel: "phone",
      destination: "+442079460113",
      pin: "1234"
    });
    expect(() => store.deliverDaemonTask(task, stranger.user.id)).toThrow();
    store.deliverDaemonTask(
      { ...task, status: "failed", result: null, errorCode: "PROVIDER_UNAVAILABLE", executions: 0 },
      actor.user.id
    );
    store.deliverDaemonTask(
      { ...task, updatedAt: new Date(Date.parse(task.updatedAt) + 100).toISOString() },
      actor.user.id
    );
    const view = store.getConversation({ sessionId: actor.session.id, conversationId });
    expect(view.messages).toHaveLength(3);
    expect(view.messages[1]!.execution).toMatchObject({
      status: "failed",
      retryable: true,
      errorCode: "PROVIDER_UNAVAILABLE"
    });
    expect(view.messages[0]!.execution?.status).toBe("completed");
    store.deliverDaemonTask(
      { ...task, status: "queued", updatedAt: task.createdAt },
      actor.user.id
    );
    expect(
      store.getConversation({ sessionId: actor.session.id, conversationId }).messages[0]!.execution
        ?.status
    ).toBe("completed");
  });
  it("queues a private push notification for the daemon owner and preserves it through restore", async () => {
    const { store, actor, task, conversationId, sent } = fixture();
    store.registerPushSubscription({
      sessionId: actor.session.id,
      endpoint: "https://push.example.test/phase6",
      expirationTime: null,
      keys: {
        auth: "AAAAAAAAAAAAAAAAAAAAAA",
        p256dh: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
      }
    });
    store.deliverDaemonTask(task, actor.user.id);
    await store.deliverPendingMessageNotifications();
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "message.new",
        conversationId,
        body: "Open Grogoni to read your message."
      })
    );
    expect(JSON.stringify(sent)).not.toContain("I remember.");
    const restored = createCp2Store();
    restored.hydrateSnapshot(store.snapshot());
    expect(
      restored.getConversation({ sessionId: actor.session.id, conversationId }).messages
    ).toHaveLength(2);
  });
});
