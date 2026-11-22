import { describe, expect, it } from "vitest";
import type {
  ConversationView,
  RuntimeModelCompletionResult,
  RuntimeModelPrompt
} from "../packages/shared-types/src";
import { buildApi } from "../services/api/src/app";
import { createLocalDefaultCp2Store as createCp2Store } from "./fixtures/local-default-store";
import { activateGenericGlobalDefaultModel } from "./fixtures/native-runtime-test-helpers";

/**
 * Agent sessions (docs/audits/instant-messaging-remaining-2026-11-19.md, section 2): behaviour that
 * existed without a test. Each test drives the real API with an in-memory store and a recording
 * model, so assertions are on what the server builds and stores, not on client state.
 */

type App = ReturnType<typeof buildApi>;

function recordingModel() {
  const prompts: RuntimeModelPrompt[] = [];
  const provider = {
    name: "test",
    complete: async (prompt: RuntimeModelPrompt): Promise<RuntimeModelCompletionResult> => {
      prompts.push(prompt);
      return {
        provider: "test",
        status: "available",
        outputText: JSON.stringify({ type: "response", message: `Reply ${prompts.length}` }),
        durationMs: 1,
        errorCode: null,
        metadata: {}
      };
    }
  };
  return { prompts, provider };
}

async function setup() {
  const model = recordingModel();
  const store = createCp2Store({ runtimeModelProvider: model.provider });
  activateGenericGlobalDefaultModel(store, new Date().toISOString());
  const app = buildApi({ cp2: { store } });
  const owner = await signUp(app, "254700000071");
  const business = await request<{ business: { id: string } }>(
    app,
    "POST",
    "/businesses",
    { name: "Session Test Shop", language: "en" },
    owner
  );
  return { app, store, model, owner, businessId: business.business.id };
}

async function signUp(app: App, phone: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ method: "phone", contact: phone, pin: "3927" })
  });
  expect(response.statusCode).toBe(200);
  const header = response.headers["set-cookie"];
  const cookie = Array.isArray(header) ? header[0] : header;
  return cookie!.split(";")[0]!;
}

function send(
  app: App,
  method: "GET" | "POST" | "PATCH",
  url: string,
  body: unknown,
  cookie: string
) {
  return app.inject({
    method,
    url,
    headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) })
  });
}

async function request<T>(
  app: App,
  method: "GET" | "POST" | "PATCH",
  url: string,
  body: unknown,
  cookie: string
): Promise<T> {
  const response = await send(app, method, url, body, cookie);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}

function newSession(app: App, cookie: string, businessId: string) {
  return request<ConversationView>(
    app,
    "POST",
    "/v1/conversations",
    { kind: "personal", activeShopId: businessId },
    cookie
  ).then((view) => view.conversation);
}

function ask(
  app: App,
  cookie: string,
  businessId: string,
  conversationId: string,
  text: string,
  clientMessageId: string
) {
  return request<{ id: string; agentMessage: { id: string } | null }>(
    app,
    "POST",
    "/v1/messages",
    {
      conversationId,
      clientMessageId,
      content: { type: "text", text },
      agent: { businessId, message: text }
    },
    cookie
  );
}

describe("agent sessions", () => {
  it("never puts one session's messages into another session's model prompt", async () => {
    const { app, model, owner, businessId } = await setup();
    try {
      const first = await newSession(app, owner, businessId);
      const second = await newSession(app, owner, businessId);
      expect(second.id).not.toBe(first.id);

      await ask(
        app,
        owner,
        businessId,
        first.id,
        "Remember the code ALPHA-7731 for later.",
        "msg-iso-a-1-0000"
      );
      await ask(app, owner, businessId, second.id, "What code did I give you?", "msg-iso-b-1-0000");
      await ask(app, owner, businessId, first.id, "Which code was it?", "msg-iso-a-2-0000");

      expect(model.prompts).toHaveLength(3);
      const [, inSecond, firstAgain] = model.prompts;
      // Everything the model receives for the second session's turn: nothing from the first.
      expect(JSON.stringify(inSecond)).not.toContain("ALPHA-7731");
      expect(JSON.stringify(inSecond)).not.toContain("Reply 1");
      expect(inSecond!.conversationHistory ?? []).toEqual([]);
      // Control: the first session does see its own history.
      expect(firstAgain!.conversationHistory).toEqual([
        { role: "user", content: "Remember the code ALPHA-7731 for later." },
        { role: "assistant", content: "Reply 1" }
      ]);
      expect(JSON.stringify(firstAgain)).not.toContain("What code did I give you?");
    } finally {
      await app.close();
    }
  });

  it("titles a session from its first message (60 characters), keeps it, and lets the owner rename it", async () => {
    const { app, owner, businessId } = await setup();
    try {
      const session = await newSession(app, owner, businessId);
      expect(session.title ?? null).toBeNull();
      const first =
        "  Restock   maize flour for the Kawangware branch before the weekend rush, please  ";
      await ask(app, owner, businessId, session.id, first, "msg-title-1-0000");
      const titled = await request<ConversationView>(
        app,
        "GET",
        `/v1/conversations/${session.id}`,
        undefined,
        owner
      );
      const expected = Array.from(first.trim().replace(/\s+/gu, " ")).slice(0, 60).join("");
      expect(titled.conversation.title).toBe(expected);
      expect(titled.conversation.title).toHaveLength(60);

      await ask(app, owner, businessId, session.id, "Also sugar.", "msg-title-2-0000");
      const unchanged = await request<ConversationView>(
        app,
        "GET",
        `/v1/conversations/${session.id}`,
        undefined,
        owner
      );
      expect(unchanged.conversation.title).toBe(expected);

      const renamed = await send(
        app,
        "PATCH",
        `/v1/conversations/${session.id}`,
        { title: "Weekend restock" },
        owner
      );
      expect(renamed.statusCode, renamed.body).toBe(200);
      await ask(app, owner, businessId, session.id, "And cooking oil.", "msg-title-3-0000");
      const after = await request<ConversationView>(
        app,
        "GET",
        `/v1/conversations/${session.id}`,
        undefined,
        owner
      );
      expect(after.conversation.title).toBe("Weekend restock");
    } finally {
      await app.close();
    }
  });

  it("treats a retried send with the same clientMessageId as the same message, with one agent turn", async () => {
    const { app, store, model, owner, businessId } = await setup();
    try {
      const session = await newSession(app, owner, businessId);
      const first = await ask(
        app,
        owner,
        businessId,
        session.id,
        "Tell me something about tea.",
        "retry-same-id"
      );
      const retried = await ask(
        app,
        owner,
        businessId,
        session.id,
        "Tell me something about tea.",
        "retry-same-id"
      );
      expect(retried.id).toBe(first.id);
      expect(retried.agentMessage?.id).toBe(first.agentMessage?.id);
      expect(model.prompts).toHaveLength(1);
      const stored = store
        .snapshot()
        .conversationMessages.filter((message) => message.conversationId === session.id);
      expect(stored.filter((message) => message.author === "user")).toHaveLength(1);
      expect(stored.filter((message) => message.author === "agent")).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("keeps one account's sessions and their history out of another account's reach", async () => {
    const { app, owner, businessId } = await setup();
    try {
      const session = await newSession(app, owner, businessId);
      await ask(
        app,
        owner,
        businessId,
        session.id,
        "Private plan: lower bread to 55.",
        "msg-tenant-1-0000"
      );
      const stranger = await signUp(app, "254700000072");

      const inbox = await request<{ conversations: Array<{ id: string }> }>(
        app,
        "GET",
        "/v1/conversations",
        undefined,
        stranger
      );
      expect(inbox.conversations.map((item) => item.id)).not.toContain(session.id);
      expect(JSON.stringify(inbox)).not.toContain("lower bread");

      for (const attempt of [
        send(app, "GET", `/v1/conversations/${session.id}`, undefined, stranger),
        send(app, "GET", `/v1/conversations/${session.id}/model`, undefined, stranger),
        send(app, "PATCH", `/v1/conversations/${session.id}`, { title: "Taken" }, stranger),
        send(
          app,
          "POST",
          "/v1/messages",
          {
            conversationId: session.id,
            clientMessageId: "tenant-intrude",
            content: { type: "text", text: "hello" }
          },
          stranger
        ),
        send(
          app,
          "POST",
          "/v1/messages",
          {
            conversationId: session.id,
            clientMessageId: "tenant-intrude-agent",
            content: { type: "text", text: "hello" },
            agent: { businessId, message: "hello" }
          },
          stranger
        )
      ]) {
        const response = await attempt;
        expect(response.statusCode, response.body).toBeGreaterThanOrEqual(400);
        expect(response.statusCode).toBeLessThan(500);
        expect(response.body).not.toContain("lower bread");
      }

      const changes = await request<unknown>(app, "GET", "/v1/sync/changes", undefined, stranger);
      expect(JSON.stringify(changes)).not.toContain(session.id);
      expect(JSON.stringify(changes)).not.toContain("lower bread");

      const ownerView = await request<ConversationView>(
        app,
        "GET",
        `/v1/conversations/${session.id}`,
        undefined,
        owner
      );
      expect(ownerView.conversation.title).not.toBe("Taken");
    } finally {
      await app.close();
    }
  });
});
