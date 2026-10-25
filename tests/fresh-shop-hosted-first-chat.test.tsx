// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BuyResultSummary } from "@grogoni/shared-types";
import type { ConversationView } from "@grogoni/shared-types";

import { useChatRuntimeState } from "../apps/web/src/hooks/useChatRuntimeState";
import {
  keepDeviceOnlyMessages,
  readDeviceOnlyMessages
} from "../apps/web/src/chat-device-only-messages";
import { queueMessagingOutbox, readMessagingOutbox } from "../apps/web/src/messaging/outbox";
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
        // A conversation-less buyer's product question goes to the hosted buyer assistant.
        expect(path).toBe("/buy/assistant");
        expect(JSON.parse(String(init?.body)).message).toContain(query);
        return jsonResponse({
          reply: "Here are the available shopping options.",
          pendingCheckout: null,
          checkoutId: null
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      const searchBuyFeed = vi.fn(async (searched: string) => ({
        query: searched,
        results: [{ sourceLabel: "Kwa Jane" }] as BuyResultSummary[],
        marketplaceConnectorAvailable: true
      }));
      const statusMessages: string[] = [];
      const navigateToView = vi.fn();
      const renderedMessages: Array<{ author: string; body: string }> = [];

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
          navigateToView,
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
            // Applied to what is rendered, as React does: a guest's bubble and its reply arrive
            // as two updates.

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

      // The hosted buyer assistant answers a conversation-less product question; the local search
      // connector is not used on this path.
      expect(searchBuyFeed).not.toHaveBeenCalled();
      expect(
        fetchMock.mock.calls
          .map(([input]) => String(input))
          .filter((url) => !String(url).endsWith("/v1/daemon/tasks"))
      ).toEqual([expect.stringContaining("/buy/assistant")]);
      expect(renderedMessages.map((message) => message.body)).toEqual([
        message,
        "Here are the available shopping options."
      ]);
      // The hosted buyer assistant answers in place for both modes; it does not force a mode
      // switch, so the user stays where they asked the question.
      expect(navigateToView).not.toHaveBeenCalled();
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

  it("keeps a send that failed with 503 on screen, marked and queued, across thread refreshes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path === "/v1/messages")
          return jsonResponse({ code: "service_unavailable", message: "Busy" }, 503);
        return jsonResponse({});
      })
    );
    let messages: Array<{
      id: string;
      body: string;
      status?: string;
      deviceOnlyIn?: string | null;
    }> = [];
    const statusMessages: string[] = [];
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
        setStatusMessage: (message) => statusMessages.push(message),
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
        ensureRuntimeSession: async () => "runtime-session-1",
        loadDocumentImports: async () => undefined,
        chatMessages: [],
        setChatMessages: (next) => {
          messages = typeof next === "function" ? next(messages as never) : (next as never);
        },
        chatDraft: "",
        setChatDraft: () => undefined,
        pendingAttachments: [],
        setPendingAttachments: () => undefined,
        runtimeSessionId: null,
        setRuntimeSessionId: () => undefined,
        replyToMessageId: null,
        setReplyToMessageId: () => undefined,
        activeConversationId: "conversation-1",
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
      await sendChatDraft!("Add 5 bags of sugar to stock");
    });

    const sent = messages.find((message) => message.body === "Add 5 bags of sugar to stock");
    expect(sent).toMatchObject({
      status: "failed",
      outboxState: "retrying",
      deviceOnlyIn: "conversation-1"
    });
    // Stored, so a thread switch or a reload does not lose it either.
    expect(readDeviceOnlyMessages("account-1").map((message) => message.id)).toEqual([sent!.id]);
    expect(readMessagingOutbox("account-1").map((entry) => entry.clientMessageId)).toEqual([
      sent!.id
    ]);
    expect(statusMessages).toContain("Message not sent yet. Grogoni will keep trying.");
    // The next 4-second refresh returns only what the server has: the queued message stays.
    expect(keepDeviceOnlyMessages(messages as never, [], "conversation-1")).toContainEqual(sent);
  });
  it("gives the text back when the chat the URL names cannot be opened", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path === "/v1/messages") throw new Error("nothing to post to: no conversation is open");
        return jsonResponse({});
      })
    );
    let messages: Array<{
      id: string;
      body: string;
      status?: string;
      deviceOnlyIn?: string | null;
    }> = [];
    const statusMessages: string[] = [];
    const drafts: string[] = [];
    // The URL names a conversation that never gets selected (loadMessagingInbox finds nothing).
    window.history.replaceState(null, "", "/workspace/conversations/never-opens");
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
        setStatusMessage: (message) => statusMessages.push(message),
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
        ensureRuntimeSession: async () => "runtime-session-1",
        loadDocumentImports: async () => undefined,
        chatMessages: [],
        setChatMessages: (next) => {
          messages = typeof next === "function" ? next(messages as never) : (next as never);
        },
        chatDraft: "",
        setChatDraft: (draft) => drafts.push(draft),
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
      await sendChatDraft!("Add 5 bags of sugar to stock");
    });

    expect(messages.some((message) => message.body === "Add 5 bags of sugar to stock")).toBe(false);
    expect(drafts.at(-1)).toBe("Add 5 bags of sugar to stock");
    expect(statusMessages.at(-1)).toMatch(/still opening.*back in the box/u);
    window.history.replaceState(null, "", "/");
  });

  it("opens the chat the URL names and sends there when it has not been selected yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path === "/v1/messages") {
          posted.push(JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")));
          return jsonResponse({
            id: "server-1",
            conversationId: "conversation-1",
            clientMessageId: "x",
            author: "account",
            authorId: "user-1",
            content: { type: "text", text: "Add 5 bags of sugar to stock" }
          });
        }
        return jsonResponse({});
      })
    );
    let messages: Array<{
      id: string;
      body: string;
      status?: string;
      deviceOnlyIn?: string | null;
    }> = [];
    const statusMessages: string[] = [];
    const drafts: string[] = [];
    const posted: Array<{ conversationId?: string }> = [];
    let selected: string | null = null;
    window.history.replaceState(null, "", "/workspace/conversations/conversation-1");
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
        setStatusMessage: (message) => statusMessages.push(message),
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
        ensureRuntimeSession: async () => "runtime-session-1",
        loadDocumentImports: async () => undefined,
        chatMessages: [],
        setChatMessages: (next) => {
          messages = typeof next === "function" ? next(messages as never) : (next as never);
        },
        chatDraft: "",
        setChatDraft: (draft) => drafts.push(draft),
        pendingAttachments: [],
        setPendingAttachments: () => undefined,
        runtimeSessionId: null,
        setRuntimeSessionId: () => undefined,
        replyToMessageId: null,
        setReplyToMessageId: () => undefined,
        activeConversationId: selected,
        activeConversation: null,
        // Selecting the conversation re-renders with it, as the app does.
        loadMessagingInbox: async (preferred) => {
          selected = preferred ?? null;
          root.render(<Harness />);
        },
        registerReset: () => undefined
      });
      sendChatDraft = api.sendChatDraft;
      return null;
    }
    await act(async () => {
      root = createRoot(host);
      root.render(<Harness />);
    });
    // Outside act: the send waits for the app to render the newly selected conversation, which
    // act would hold back until the send itself finished.
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = false;
    try {
      await sendChatDraft!("Add 5 bags of sugar to stock");
    } finally {
      (
        globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = true;
    }

    // The user's message, sent once, to the conversation the URL named (the client also persists
    // the agent's reply there).
    expect(
      posted
        .filter((payload) => (payload as { author?: string }).author !== "agent")
        .map((payload) => payload.conversationId)
    ).toEqual(["conversation-1"]);
    expect(statusMessages).toContain("Opening this chat…");
    expect(statusMessages.some((message) => /still opening/u.test(message))).toBe(false);
    window.history.replaceState(null, "", "/");
  });

  it("keeps what was typed while the send waited for the chat to open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path === "/v1/messages") {
          posted.push(JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")));
          return jsonResponse({
            id: "server-1",
            conversationId: "conversation-1",
            clientMessageId: "x",
            author: "account",
            authorId: "user-1",
            content: { type: "text", text: "Add 5 bags of sugar to stock" }
          });
        }
        return jsonResponse({});
      })
    );
    let messages: Array<{
      id: string;
      body: string;
      status?: string;
      deviceOnlyIn?: string | null;
    }> = [];
    const statusMessages: string[] = [];
    const drafts: string[] = [];
    const posted: Array<{ conversationId?: string }> = [];
    let selected: string | null = null;
    let typedMeanwhile = "";
    let openedAt = -1;
    window.history.replaceState(null, "", "/workspace/conversations/conversation-1");
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
        setStatusMessage: (message) => statusMessages.push(message),
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
        ensureRuntimeSession: async () => "runtime-session-1",
        loadDocumentImports: async () => undefined,
        chatMessages: [],
        setChatMessages: (next) => {
          messages = typeof next === "function" ? next(messages as never) : (next as never);
        },
        chatDraft: typedMeanwhile,
        setChatDraft: (draft) => drafts.push(draft),
        pendingAttachments: [],
        setPendingAttachments: () => undefined,
        runtimeSessionId: null,
        setRuntimeSessionId: () => undefined,
        replyToMessageId: null,
        setReplyToMessageId: () => undefined,
        activeConversationId: selected,
        activeConversation: null,
        // Selecting the conversation re-renders with it, as the app does.
        loadMessagingInbox: async (preferred) => {
          selected = preferred ?? null;
          typedMeanwhile = "Also 2 bags of rice";
          openedAt = drafts.length;
          root.render(<Harness />);
        },
        registerReset: () => undefined
      });
      sendChatDraft = api.sendChatDraft;
      return null;
    }
    await act(async () => {
      root = createRoot(host);
      root.render(<Harness />);
    });
    // Outside act: the send waits for the app to render the newly selected conversation, which
    // act would hold back until the send itself finished.
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = false;
    try {
      await sendChatDraft!("Add 5 bags of sugar to stock");
    } finally {
      (
        globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = true;
    }

    // Sent once, and the box was not cleared: it now holds something else.
    expect(
      posted.filter((payload) => (payload as { author?: string }).author !== "agent")
    ).toHaveLength(1);
    // After the chat opened, the retried send did not wipe what was typed meanwhile.
    expect(openedAt).toBeGreaterThanOrEqual(0);
    expect(drafts.slice(openedAt)).not.toContain("");
    window.history.replaceState(null, "", "/");
  });

  it("waits out the backoff before rerunning an agent turn that failed after the message was saved", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path === "/v1/messages")
          return jsonResponse({
            id: "saved-1",
            conversationId: "conversation-1",
            clientMessageId: "saved-client",
            author: "account",
            authorId: "user-1",
            content: { type: "text", text: "Add 5 bags of sugar to stock" },
            processing: { status: "failed", errorCode: "MODEL_PROVIDER_TIMEOUT" }
          });
        return jsonResponse({});
      })
    );
    let messages: Array<{
      id: string;
      body: string;
      status?: string;
      deviceOnlyIn?: string | null;
    }> = [];
    const statusMessages: string[] = [];
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
        setStatusMessage: (message) => statusMessages.push(message),
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
        ensureRuntimeSession: async () => "runtime-session-1",
        loadDocumentImports: async () => undefined,
        chatMessages: [],
        setChatMessages: (next) => {
          messages = typeof next === "function" ? next(messages as never) : (next as never);
        },
        chatDraft: "",
        setChatDraft: () => undefined,
        pendingAttachments: [],
        setPendingAttachments: () => undefined,
        runtimeSessionId: null,
        setRuntimeSessionId: () => undefined,
        replyToMessageId: null,
        setReplyToMessageId: () => undefined,
        activeConversationId: "conversation-1",
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
      await sendChatDraft!("Add 5 bags of sugar to stock");
    });

    const [entry] = readMessagingOutbox("account-1");
    expect(entry).toMatchObject({ attempts: 0 });
    // Not due at once: the next 4-second refresh must not rerun a paid model turn.
    expect(entry!.nextAttemptAt).toBeGreaterThan(Date.now() + 10_000);
  });

  it("sends nothing past an earlier message still waiting in the same conversation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path === "/v1/messages") throw new Error("must not post past a waiting message");
        return jsonResponse({});
      })
    );
    let messages: Array<{
      id: string;
      body: string;
      status?: string;
      deviceOnlyIn?: string | null;
    }> = [];
    const statusMessages: string[] = [];
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
        setStatusMessage: (message) => statusMessages.push(message),
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
        ensureRuntimeSession: async () => "runtime-session-1",
        loadDocumentImports: async () => undefined,
        chatMessages: [],
        setChatMessages: (next) => {
          messages = typeof next === "function" ? next(messages as never) : (next as never);
        },
        chatDraft: "",
        setChatDraft: () => undefined,
        pendingAttachments: [],
        setPendingAttachments: () => undefined,
        runtimeSessionId: null,
        setRuntimeSessionId: () => undefined,
        replyToMessageId: null,
        setReplyToMessageId: () => undefined,
        activeConversationId: "conversation-1",
        activeConversation: null,
        loadMessagingInbox: async () => undefined,
        registerReset: () => undefined
      });
      sendChatDraft = api.sendChatDraft;
      return null;
    }
    queueMessagingOutbox({
      accountId: "account-1",
      clientMessageId: "earlier-message",
      payload: { conversationId: "conversation-1", clientMessageId: "earlier-message" },
      attempts: 1,
      nextAttemptAt: Date.now() + 60_000
    });
    await act(async () => {
      root = createRoot(host);
      root.render(<Harness />);
    });
    await act(async () => {
      await sendChatDraft!("Add 5 bags of sugar to stock");
    });

    const sent = messages.find((message) => message.body === "Add 5 bags of sugar to stock");
    expect(sent).toMatchObject({ status: "queued", outboxState: "retrying" });
    // Behind the earlier one: the resend pass sends them in the order they were typed.
    expect(readMessagingOutbox("account-1").map((entry) => entry.clientMessageId)).toEqual([
      "earlier-message",
      sent!.id
    ]);
    expect(statusMessages).toContain(
      "This message will send right after your earlier one, which is still waiting."
    );
  });
});
