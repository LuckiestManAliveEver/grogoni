// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "../apps/web/src/app-shell";
import { useChatRuntimeState } from "../apps/web/src/hooks/useChatRuntimeState";
import { readMessagingOutbox } from "../apps/web/src/messaging/outbox";
import type {
  ActiveBusiness,
  AgentSettings,
  SessionResponse
} from "../apps/web/src/grogoni-application-shared";

/**
 * On the Edge API an agent reply runs after POST /v1/messages answered (`processing.status:
 * "pending"`, docs/deployment/supabase-edge-api.md "Agent turns"). The chat must show that a reply
 * is coming, put the reply under its message when the turn completes, with no page refresh, and
 * show a failed reply (queued for the outbox resend) when the turn fails.
 */
describe("chat with an agent reply that runs after the message was accepted", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    localStorage.clear();
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const session = {
    account: {
      id: "account-1",
      primaryAuthChannel: "phone",
      primaryAuthDestination: "+254700000000",
      identityLevel: "verified_contact"
    },
    user: { id: "user-1", accountId: "account-1", displayName: "Owner", language: "en" },
    session: { id: "session-1", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
  } as unknown as SessionResponse;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    });

  const serverMessage = (
    id: string,
    author: "user" | "agent",
    text: string,
    createdAt: string
  ) => ({
    id,
    conversationId: "conversation-1",
    clientMessageId: id,
    author,
    authorId: author === "user" ? "user-1" : "account-account-1-agent",
    content: { type: "text", text },
    status: "delivered",
    createdAt,
    deletedAt: null,
    replyToMessageId: author === "agent" ? "server-message-1" : null,
    reactions: []
  });

  async function run(turnAnswers: unknown[], options: { conversationOpen?: boolean } = {}) {
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input), "http://localhost").pathname;
        fetched.push(path);
        if (path === "/v1/messages")
          return json({
            ...serverMessage(
              "server-message-1",
              "user",
              "How are sales?",
              "2026-10-17T10:00:00.000Z"
            ),
            processing: {
              correlationId: "server-message-1",
              status: "pending",
              errorCode: null,
              retryable: false,
              turnId: "turn-1"
            }
          });
        if (path === "/v1/conversations/conversation-1")
          return json({
            conversation: { id: "conversation-1", kind: "personal", activeShopId: "shop-1" },
            participants: []
          });
        if (path === "/v1/agent-turns/turn-1") return json(turnAnswers.shift());
        if (path.startsWith("/v1/ai/turn-stream/")) return new Response("", { status: 204 });
        throw new Error(`Unexpected fetch to ${path}`);
      })
    );
    const seen: ChatMessage[][] = [];
    let send: ((draft?: string) => Promise<void>) | null = null;
    let current: ChatMessage[] = [];
    function Harness() {
      const [chatMessages, setState] = useState<ChatMessage[]>([]);
      current = chatMessages;
      // Every intermediate thread state, in order (act batches the renders themselves).
      const setChatMessages: typeof setState = (next) =>
        setState((previous) => {
          const value = typeof next === "function" ? next(previous) : next;
          seen.push(value);
          return value;
        });
      const api = useChatRuntimeState({
        business: {
          id: "shop-1",
          name: "Shop",
          language: "en",
          grogoniId: "shop-1",
          role: "owner"
        } as unknown as ActiveBusiness,
        mode: "seller",
        session,
        authBootstrapState: "authenticated",
        ensureAuthenticatedSession: async () => session,
        rejectDefinitiveAuthenticationFailure: () => false,
        agentSettings: {
          model: "gpt-6-luna",
          role: "shopkeeper",
          instructions: "Help.",
          name: "Shopkeeper"
        } as unknown as AgentSettings,
        setStatusMessage: () => undefined,
        navigateToView: () => undefined,
        requireMessagingSignIn: () => undefined,
        loadProducts: async () => undefined,
        loadSuppliers: async () => undefined,
        loadCustomers: async () => undefined,
        loadInvoices: async () => undefined,
        loadReports: async () => undefined,
        loadNotifications: async () => undefined,
        loadRuntimeSessions: async () => undefined,
        createManagedRuntimeSession: async () => "runtime-session-1",
        ensureRuntimeSession: async (setRuntimeSessionId) => {
          setRuntimeSessionId("runtime-session-1");
          return "runtime-session-1";
        },
        loadDocumentImports: async () => undefined,
        chatMessages,
        setChatMessages,
        chatDraft: "",
        setChatDraft: () => undefined,
        pendingAttachments: [],
        setPendingAttachments: () => undefined,
        runtimeSessionId: "runtime-session-1",
        setRuntimeSessionId: () => undefined,
        replyToMessageId: null,
        setReplyToMessageId: () => undefined,
        activeConversationId: "conversation-1",
        activeConversation:
          options.conversationOpen === false
            ? null
            : ({
                conversation: { id: "conversation-1", kind: "personal", activeShopId: "shop-1" },
                participants: []
              } as never),
        loadMessagingInbox: async () => undefined,
        registerReset: () => undefined
      });
      send = api.sendChatDraft;
      return null;
    }
    await act(async () => {
      root = createRoot(host);
      root.render(<Harness />);
    });
    await act(async () => {
      await send!("How are sales?");
    });
    return { fetched, seen, current: () => current };
  }

  it("shows a pending reply, then the reply under its message, with no refresh", async () => {
    const result = await run([
      { processing: { correlationId: "server-message-1", status: "pending", turnId: "turn-1" } },
      {
        agentMessage: serverMessage(
          "agent-reply-1",
          "agent",
          "Sales are up this week.",
          "2026-10-17T10:00:00.001Z"
        ),
        runtime: null,
        processing: {
          correlationId: "server-message-1",
          status: "completed",
          errorCode: null,
          retryable: false
        }
      }
    ]);
    const polls = result.fetched.filter((path) => path === "/v1/agent-turns/turn-1");
    expect(polls).toHaveLength(2);
    // While the turn ran, a placeholder reply sat right under the message.
    expect(
      result.seen.some((messages) =>
        messages.some(
          (item) => item.id === "agent-turn-pending-server-message-1" && item.status === "sending"
        )
      )
    ).toBe(true);
    const final = result.current();
    expect(final.map((item) => item.id)).toEqual(["server-message-1", "agent-reply-1"]);
    expect(final[1]).toMatchObject({ author: "grogoniclaw", body: "Sales are up this week." });
    expect(readMessagingOutbox("account-1")).toHaveLength(0);
  }, 20_000);

  it("shows the reply even when the chat was still opening when the message was sent", async () => {
    // Found by the browser eval: the reply waited for the next thread refresh (15 s) because the
    // send path placed it only when the open conversation had loaded.
    const result = await run(
      [
        {
          agentMessage: serverMessage(
            "agent-reply-1",
            "agent",
            "Sales are up this week.",
            "2026-10-17T10:00:00.001Z"
          ),
          runtime: null,
          processing: {
            correlationId: "server-message-1",
            status: "completed",
            errorCode: null,
            retryable: false
          }
        }
      ],
      { conversationOpen: false }
    );
    expect(result.current().map((item) => item.id)).toContain("agent-reply-1");
    expect(result.current().find((item) => item.id === "agent-reply-1")).toMatchObject({
      author: "grogoniclaw",
      body: "Sales are up this week."
    });
  }, 20_000);

  it("shows a failed reply and queues the message for the outbox resend when the turn fails", async () => {
    const result = await run([
      {
        processing: {
          correlationId: "server-message-1",
          status: "failed",
          errorCode: "AGENT_TURN_LOST",
          retryable: true
        }
      }
    ]);
    const final = result.current();
    expect(final.map((item) => item.id)).toEqual([
      "server-message-1",
      "agent-turn-failed-server-message-1"
    ]);
    expect(final[1]).toMatchObject({ author: "grogoniclaw", status: "failed" });
    expect(final[1]!.body).toContain("Your message is saved");
    // The retry: the same message (same clientMessageId) waits in the outbox.
    expect(readMessagingOutbox("account-1")).toHaveLength(1);
  }, 20_000);
});
