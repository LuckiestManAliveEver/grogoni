import type { ChatMessage } from "../apps/web/src/app-shell";
// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationView } from "@grogoni/shared-types";
import { useChatRuntimeState } from "../apps/web/src/hooks/useChatRuntimeState";
import type {
  ActiveBusiness,
  AgentSettings,
  SessionResponse
} from "../apps/web/src/grogoni-application-shared";

// Regression coverage for the private on-device model architecture's removal: a fresh shop's
// first AI message must reach the plain server runtime turn with zero client-side model state -
// no device id, no local model installation, no browser-inference session, nothing read or
// written before the request goes out. This is what "hosted-first" means end to end, not just at
// the type level.
describe("fresh shop, first AI message: hosted-first with no client model state", () => {
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

  function business(): ActiveBusiness {
    return {
      id: "fresh-shop-1",
      name: "Fresh Shop",
      language: "en",
      grogoniId: "fresh-shop-1",
      role: "owner"
    } as unknown as ActiveBusiness;
  }

  function agentSettings(): AgentSettings {
    return {
      model: "smollm2-360m",
      role: "shopkeeper",
      instructions: "Help the owner run their shop.",
      name: "Shopkeeper"
    } as unknown as AgentSettings;
  }

  function session(): SessionResponse {
    return {
      account: {
        id: "account-1",
        primaryAuthChannel: "phone",
        primaryAuthDestination: "+254700000000",
        identityLevel: "verified_contact"
      },
      user: { id: "user-1", accountId: "account-1", displayName: "Owner", language: "en" },
      session: { id: "session-1", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
    } as unknown as SessionResponse;
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    });
  }

  it.each([
    ["marketplace", "I want to buy sukuma from Kwa Jane", "sukuma from Kwa Jane"],
    ["marketplace", "Do you have maize flour 2kg?", "maize flour 2kg"],
    ["seller", "Do you have maize flour 2kg?", "maize flour 2kg"]
  ] as const)(
    "routes %s buyer question %s to the buyer assistant without requiring a shop",
    async (mode, message, query) => {
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const path = new URL(url, "http://localhost").pathname;
        if (path === "/v1/daemon/tasks" && !init?.method) return jsonResponse({ tasks: [] });
        expect(path).toBe("/buy/assistant");
        expect(JSON.parse(String(init?.body)).message).toContain(query);
        return jsonResponse({
          reply: "Here are the available shopping options.",
          pendingCheckout: null,
          checkoutId: null
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      const searchBuyFeed = vi.fn(async () => undefined);
      const statusMessages: string[] = [];
      const renderedMessages: ChatMessage[] = [];

      let sendChatDraft: ((draft?: string) => Promise<void>) | null = null;
      function Harness() {
        const api = useChatRuntimeState({
          business: null,
          mode,
          session: session(),
          authBootstrapState: "authenticated",
          ensureAuthenticatedSession: async () => session(),
          rejectDefinitiveAuthenticationFailure: () => false,
          agentSettings: agentSettings(),
          setStatusMessage: (message) => statusMessages.push(message),
          navigateToView: () => undefined,
          requireMessagingSignIn: () => undefined,
          searchBuyFeed,
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
          chatMessages: [],
          setChatMessages: (next) => {
            const resolved = typeof next === "function" ? next([...renderedMessages]) : next;
            renderedMessages.splice(0, renderedMessages.length, ...resolved);
          },
          chatDraft: "",
          setChatDraft: () => undefined,
          pendingAttachments: [],
          setPendingAttachments: () => undefined,
          runtimeSessionId: null,
          setRuntimeSessionId: () => undefined,
          replyToMessageId: null,
          setReplyToMessageId: () => undefined,
          activeConversationId: null,
          activeConversation: null,
          loadMessagingInbox: async () => undefined,
          registerReset: () => undefined
        });
        sendChatDraft = api.sendChatDraft;
        return null;
      }

      await act(async () => {
        root = createRoot(host);
        root.render(<Harness />);
      });

      await act(async () => {
        await sendChatDraft!(message);
      });

      expect(searchBuyFeed).not.toHaveBeenCalled();
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
      expect(renderedMessages.map((message) => message.body)).toEqual([
        message,
        "Here are the available shopping options."
      ]);
      expect(statusMessages).toContain("Shopping assistant replied.");
    }
  );

  it.each([true, false])(
    "sends the first message without device/model fetch (conversation loaded: %s)",
    async (loaded) => {
      const conversation = {
        conversation: { id: "conversation-1", kind: "personal", activeShopId: "fresh-shop-1" },
        participants: [],
        messages: []
      } as unknown as ConversationView;
      const fetchedPaths: string[] = [];
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        const path = new URL(url, "http://localhost").pathname;
        if (path === "/v1/daemon/tasks") return jsonResponse({ tasks: [] });
        fetchedPaths.push(path);
        if (path === "/v1/conversations/conversation-1") return jsonResponse(conversation);
        if (path === "/v1/messages") {
          return jsonResponse({
            id: "merchant-message-1",
            agentMessage: { id: "agent-message-1" },
            runtime: null
          });
        }
        throw new Error(
          `Unexpected fetch to ${path} - a fresh shop's first message should only ` +
            "call POST /v1/messages, never an owner-node/device endpoint."
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      let sendChatDraft: ((draft?: string) => Promise<void>) | null = null;
      function Harness() {
        const api = useChatRuntimeState({
          business: business(),
          mode: "seller",
          session: session(),
          authBootstrapState: "authenticated",
          ensureAuthenticatedSession: async () => session(),
          rejectDefinitiveAuthenticationFailure: () => false,
          agentSettings: agentSettings(),
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
          chatMessages: [],
          setChatMessages: () => undefined,
          chatDraft: "",
          setChatDraft: () => undefined,
          pendingAttachments: [],
          setPendingAttachments: () => undefined,
          runtimeSessionId: null,
          setRuntimeSessionId: () => undefined,
          replyToMessageId: null,
          setReplyToMessageId: () => undefined,
          activeConversationId: "conversation-1",
          activeConversation: loaded ? conversation : null,
          loadMessagingInbox: async () => undefined,
          registerReset: () => undefined
        });
        sendChatDraft = api.sendChatDraft;
        return null;
      }

      await act(async () => {
        root = createRoot(host);
        root.render(<Harness />);
      });

      expect(sendChatDraft).not.toBeNull();
      // The existing auth/device identifier is allowed; no model installation state is created.
      expect(
        Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      ).toEqual(["grogoni.device-id.v1"]);

      await act(async () => {
        await sendChatDraft!("Hello, what can you help me with today?");
      });

      // Resolve an unloaded selected thread before routing; no device/model fetch is needed.
      expect(fetchedPaths.filter((path) => !path.startsWith("/v1/ai/turn-stream/"))).toEqual(
        loaded ? ["/v1/messages"] : ["/v1/conversations/conversation-1", "/v1/messages"]
      );
      expect(fetchedPaths.some((path) => path.includes("owner-node"))).toBe(false);
      expect(fetchedPaths.some((path) => path.includes("device"))).toBe(false);

      const messagesCall = fetchMock.mock.calls.find(([input]) =>
        String(input).includes("/v1/messages")
      ) as unknown as [unknown, RequestInit | undefined];
      const [, requestInit] = messagesCall;
      const body = JSON.parse(String(requestInit?.body)) as {
        agent?: { businessId: string; message: string };
      };
      expect(body.agent).toMatchObject({ businessId: "fresh-shop-1" });

      // No on-device model assignment, browser-inference session, or model-scoped device id was
      // read or written - only lib/api.ts's generic request-tracing device id (unrelated to model
      // execution) may exist. The retired keys (agent-model-assignment.ts's
      // "grogoni.agent-model-assignment.v1", browser-inference-*'s IndexedDB/localStorage state) must
      // never reappear.
      const storedKeys = Object.keys(localStorage);
      expect(storedKeys).not.toContain("grogoni.agent-model-assignment.v1");
      expect(storedKeys.some((key) => key.includes("model-scope"))).toBe(false);
      expect(storedKeys.some((key) => key.includes("browser-inference"))).toBe(false);
    }
  );
});
