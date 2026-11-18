import { describe, expect, it, vi } from "vitest";
import type { RuntimeModelProvider } from "../packages/shared-types/src";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

function fixture(provider?: RuntimeModelProvider) {
  const store = createCp2Store(provider ? { runtimeModelProvider: provider } : {});
  const owner = store.continueWithChannelPin({
    channel: "email",
    destination: "instant-fixture@example.invalid",
    pin: "3927"
  });
  const business = store.createBusiness({
    sessionId: owner.session.id,
    name: "Instant fixture",
    language: "en",
    phoneNumber: "+254711456789",
    phoneCountry: "KE"
  }).business;
  const chat = () =>
    store.createConversation({
      sessionId: owner.session.id,
      kind: "personal",
      activeShopId: business.id
    }).conversation;
  return { store, owner, business, chat, cookie: `grogoni_session=${owner.session.id}` };
}

describe("instant messaging API contracts", () => {
  it("returns acceptance before a blocked model, deduplicates resends and isolates queue reads", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const complete = vi.fn(async () => {
      await blocked;
      return {
        provider: "fixture",
        status: "available" as const,
        outputText: JSON.stringify({ type: "response", message: "Ready." }),
        durationMs: 1,
        errorCode: null,
        metadata: {}
      };
    });
    const f = fixture({ name: "fixture", complete });
    const conversation = f.chat();
    const app = buildApi({ cp2: { store: f.store, queuedAgentTurns: true } });
    try {
      await app.ready();
      const payload = {
        conversationId: conversation.id,
        clientMessageId: "instant-model-message",
        content: { type: "text", text: "What can you help me with?" },
        agent: { businessId: f.business.id, message: "What can you help me with?" }
      };
      const started = performance.now();
      const accepted = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { cookie: f.cookie },
        payload
      });
      expect(accepted.statusCode).toBe(200);
      expect(performance.now() - started).toBeLessThan(500);
      const body = accepted.json();
      expect(body.status).toBe("sent");
      expect(body.processing.status).toBe("pending");
      const repeated = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { cookie: f.cookie },
        payload
      });
      expect(repeated.json().id).toBe(body.id);
      expect(repeated.json().processing.turnId).toBe(body.processing.turnId);
      const humanSend = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { cookie: f.cookie },
        payload: {
          conversationId: f.chat().id,
          clientMessageId: "unrelated-human-message",
          content: { type: "text", text: "Human transport remains available." }
        }
      });
      expect(humanSend.statusCode).toBe(200);
      expect(humanSend.json().status).toBe("sent");
      const other = f.store.continueWithChannelPin({
        channel: "email",
        destination: "another-fixture@example.invalid",
        pin: "3927"
      });
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/v1/agent-turns/${body.processing.turnId}`,
            headers: { cookie: `grogoni_session=${other.session.id}` }
          })
        ).statusCode
      ).toBe(404);
      release();
      await vi.waitFor(async () => {
        const polled = await app.inject({
          method: "GET",
          url: `/v1/agent-turns/${body.processing.turnId}`,
          headers: { cookie: f.cookie }
        });
        expect(polled.json().processing.status).toBe("completed");
      });
      expect(complete).toHaveBeenCalledTimes(1);
      expect(
        f.store.getConversation({ sessionId: f.owner.session.id, conversationId: conversation.id })
          .messages
      ).toHaveLength(2);
    } finally {
      release();
      await app.close();
    }
  });

  it("returns authorized deltas and preserves edits without another account's messages", () => {
    const f = fixture();
    const a = f.chat(),
      b = f.chat();
    const first = f.store.createConversationMessage({
      sessionId: f.owner.session.id,
      conversationId: a.id,
      clientMessageId: "first-delta-message",
      content: { type: "text", text: "First" }
    });
    const initial = f.store.getConversation({
      sessionId: f.owner.session.id,
      conversationId: a.id
    });
    f.store.createConversationMessage({
      sessionId: f.owner.session.id,
      conversationId: b.id,
      clientMessageId: "other-delta-message",
      content: { type: "text", text: "Other conversation" }
    });
    const second = f.store.createConversationMessage({
      sessionId: f.owner.session.id,
      conversationId: a.id,
      clientMessageId: "second-delta-message",
      content: { type: "text", text: "Second" }
    });
    const delta = f.store.getConversation({
      sessionId: f.owner.session.id,
      conversationId: a.id,
      since: initial.messageCursor!
    });
    expect(delta.isDelta).toBe(true);
    expect(delta.messages.map((message) => message.id)).toEqual([second.id]);
    expect(first.status).toBe("sent");
    expect(first.deliveredAt).toBeNull();
    expect(initial.messages[0]?.serverSequence).toBeDefined();
    expect(delta.messages[0]!.serverSequence).toBeGreaterThan(initial.messages[0]!.serverSequence!);
    expect(() =>
      f.store.getConversation({ sessionId: null, conversationId: a.id, since: "0" })
    ).toThrow();
  });

  it("binds a runtime session to its conversation", async () => {
    const f = fixture();
    const a = f.chat(),
      b = f.chat();
    const runtime = f.store.createRuntimeSession({
      sessionId: f.owner.session.id,
      businessId: f.business.id,
      conversationId: a.id
    });
    await expect(
      f.store.createRuntimeTurn({
        sessionId: f.owner.session.id,
        businessId: f.business.id,
        conversationId: b.id,
        runtimeSessionId: runtime.id,
        message: "Cross-session turn"
      })
    ).rejects.toMatchObject({ code: "runtime_conversation_mismatch" });
    await expect(
      f.store.createAgentConversationMessage({
        sessionId: f.owner.session.id,
        conversationId: b.id,
        businessId: f.business.id,
        clientMessageId: "wrong-session-message",
        content: { type: "text", text: "hello" },
        message: "hello",
        runtimeSessionId: runtime.id
      })
    ).rejects.toMatchObject({ code: "runtime_conversation_mismatch" });
    expect(
      f.store.getConversation({ sessionId: f.owner.session.id, conversationId: b.id }).messages
    ).toHaveLength(0);
  });
});
