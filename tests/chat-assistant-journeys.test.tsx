// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatRuntimeState } from "../apps/web/src/hooks/useChatRuntimeState";
import {
  parseMarketplaceBuyIntent,
  parseReminderIntent
} from "../apps/web/src/chat-assistant-intents";
import { daemonTaskUpdatedEvent, readChatDaemonTasks } from "../apps/web/src/daemon-chat";
import type { ConversationView } from "@grogoni/shared-types";
import type { ChatAttachment, ChatMessage, GrogoniMode } from "../apps/web/src/app-shell";
import type {
  ActiveBusiness,
  AgentSettings,
  SessionResponse
} from "../apps/web/src/grogoni-application-shared";

describe("buyer and seller assistant journeys", () => {
  let root: Root;
  let send: (text: string) => Promise<void>;
  let messages: ChatMessage[];
  let status: string;
  let draft: string;
  let completed: boolean;
  let attachments: ChatAttachment[];
  let historyRefresh: () => Promise<void>;
  let requests: Array<{ path: string; method: string; body: Record<string, unknown> }>;
  const search = vi.fn(async () => undefined);
  const session = {
    account: { id: "review-account" },
    user: { id: "review-user" },
    session: { id: "session" }
  } as SessionResponse;
  const task = () => ({
    id: "task-1",
    payload: {
      kind: "agent",
      message: "fixture",
      modelId: "gpt-6-luna",
      agentAdapterId: "grogoni"
    },
    status: completed ? "completed" : "queued",
    executions: completed ? 1 : 0,
    runAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    result: completed
      ? { text: "3 baskets cost 1,350 shillings.", modelId: "gpt-6-luna", executedBy: "server" }
      : null
  });
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T20:00:00Z"));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    localStorage.clear();
    historyRefresh = async () => undefined;
    completed = false;
    attachments = [];
    requests = [];
    messages = [];
    status = "";
    search.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url, "http://localhost").pathname;
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        // Read-only recovery runs on mount; these journeys assert submitted actions and routing.
        if (!(path === "/v1/daemon/tasks" && method === "GET"))
          requests.push({ path, method, body });
        let response: unknown;
        if (path === "/v1/daemon/tasks" && method === "POST")
          response = { task: { ...task(), runAt: body.runAt ?? task().runAt } };
        else if (path === "/v1/daemon/tasks" && method === "GET") response = { tasks: [] };
        else if (path === "/v1/daemon/tasks/task-1") response = { task: task() };
        else if (path === "/buy/assistant")
          response = {
            reply: "3 baskets cost 1,350 shillings.",
            pendingCheckout: null,
            checkoutId: null
          };
        else if (path === "/v1/chat/images/read")
          response = {
            fileName: "receipt.png",
            text: "RECEIPT ZXQ-4827\nTOTAL KES 570",
            format: "ocr",
            engine: "gpt-6-luna",
            warnings: []
          };
        else if (path === "/v1/messages")
          response = {
            id: "persisted",
            conversationId: body.conversationId,
            author: "merchant",
            content: body.content,
            createdAt: new Date().toISOString(),
            status: "delivered",
            channel: "web",
            deliveryAttempts: []
          };
        else if (path.endsWith("/runtime/turns"))
          response = {
            session: { id: "runtime" },
            turn: {
              status: "completed",
              response: "3 baskets cost 1,350 shillings.",
              plan: {
                toolName: "unknown.clarify",
                input: {},
                executedAt: new Date().toISOString(),
                confirmationToken: null
              },
              model: { status: "available", modelId: "gpt-6-luna", executionTarget: "backend" },
              toolResult: null
            }
          };
        else if (path.startsWith("/buy/checkouts/"))
          response = { handoffs: [{ orderId: "order-1", status: "delivered" }] };
        else throw new Error(`Unexpected ${method} ${path}`);
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      })
    );
    root = createRoot(document.createElement("div"));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });
  async function mount(
    mode: GrogoniMode = "marketplace",
    business: ActiveBusiness | null = null,
    conversation: ConversationView | null = null,
    initialAttachments: ChatAttachment[] = []
  ) {
    function Harness() {
      const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
      const [chatDraft, setChatDraft] = useState("");
      const [pendingAttachments, setPendingAttachments] = useState(initialAttachments);
      attachments = pendingAttachments;
      messages = chatMessages;
      draft = chatDraft;
      const noop = async () => undefined;
      const runtime = useChatRuntimeState({
        business,
        mode,
        session,
        authBootstrapState: "authenticated",
        ensureAuthenticatedSession: async () => session,
        rejectDefinitiveAuthenticationFailure: () => false,
        agentSettings: { name: "Shopkeeper", model: "gpt-6-luna" } as AgentSettings,
        setStatusMessage: (text) => {
          status = text;
        },
        navigateToView: () => undefined,
        requireMessagingSignIn: () => undefined,
        searchBuyFeed: search,
        loadProducts: noop,
        loadSuppliers: noop,
        loadCustomers: noop,
        loadInvoices: noop,
        loadReports: noop,
        loadNotifications: noop,
        loadRuntimeSessions: () => historyRefresh(),
        createManagedRuntimeSession: async () => "runtime",
        ensureRuntimeSession: async () => "runtime",
        loadDocumentImports: noop,
        chatMessages,
        setChatMessages,
        chatDraft,
        setChatDraft,
        pendingAttachments,
        setPendingAttachments,
        runtimeSessionId: null,
        setRuntimeSessionId: () => undefined,
        replyToMessageId: null,
        setReplyToMessageId: () => undefined,
        activeConversationId: conversation?.conversation.id ?? null,
        activeConversation: conversation,
        loadMessagingInbox: noop,
        registerReset: () => undefined
      });
      send = runtime.sendChatDraft;
      return null;
    }
    await act(async () => root.render(<Harness />));
  }
  const receipt = {
    id: "photo-1",
    name: "receipt.png",
    type: "image/png",
    size: 8,
    category: "image",
    dataUrl: "data:image/png;base64,cGhvdG8="
  } as ChatAttachment;
  it.each(["marketplace", "seller"] as const)(
    "reads a receipt before the %s assistant turn",
    async (mode) => {
      await mount(
        mode,
        mode === "seller" ? ({ id: "shop-1", name: "Shop" } as ActiveBusiness) : null,
        null,
        [receipt]
      );
      await act(async () => send("Read this receipt"));
      expect(requests[0]?.path).toBe("/v1/chat/images/read");
      const turn = requests.find((request) =>
        request.path.endsWith(mode === "seller" ? "/runtime/turns" : "/v1/daemon/tasks")
      );
      expect(turn?.body.message).toContain("RECEIPT ZXQ-4827");
      expect(turn?.body.message).toContain("TOTAL KES 570");
      expect(messages.find((message) => message.author === "merchant")?.attachments).toEqual([
        receipt
      ]);
      expect(attachments).toEqual([]);
    }
  );
  it("keeps a buyer receipt out of private shop records even when the account owns a shop", async () => {
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) =>
      input.endsWith("/v1/chat/images/read")
        ? new Response(
            JSON.stringify({
              fileName: "receipt.png",
              text: "TOTAL 570",
              receiptFields: { supplier: { supplierName: "Acacia" }, products: [] }
            }),
            { headers: { "content-type": "application/json" } }
          )
        : fetch(input, init)
    );
    await mount("marketplace", { id: "shop-1", name: "Shop" } as ActiveBusiness, null, [receipt]);
    await act(async () => send("Read this receipt"));
    expect(requests.some((request) => request.path.includes("receipt-ocr/jobs"))).toBe(false);
    expect(
      requests.some((request) => request.path === "/v1/daemon/tasks" && request.method === "POST")
    ).toBe(true);
  });
  it("includes Luna's reading in a saved seller conversation before server processing", async () => {
    const conversation = {
      conversation: { id: "receipt-chat", kind: "personal", activeShopId: "shop-1" },
      participants: [],
      messages: []
    } as unknown as ConversationView;
    await mount("seller", { id: "shop-1", name: "Shop" } as ActiveBusiness, conversation, [
      receipt
    ]);
    await act(async () => send("Read this receipt"));
    const saved = requests.find((request) => request.path === "/v1/messages");
    expect((saved?.body.agent as { message: string })?.message).toContain("RECEIPT ZXQ-4827");
    expect(requests.findIndex((request) => request.path === "/v1/chat/images/read")).toBeLessThan(
      requests.findIndex((request) => request.path === "/v1/messages")
    );
  });
  it("keeps the receipt and draft retryable when Luna cannot read it", async () => {
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) =>
      input.endsWith("/v1/chat/images/read")
        ? new Response(JSON.stringify({ message: "Luna unavailable" }), {
            status: 503,
            headers: { "content-type": "application/json" }
          })
        : fetch(input, init)
    );
    await mount("marketplace", null, null, [receipt]);
    await act(async () => send("Read this receipt"));
    expect(status).toContain("Your draft is saved");
    expect(draft).toBe("Read this receipt");
    expect(attachments).toEqual([receipt]);
    expect(requests.some((request) => request.path === "/v1/daemon/tasks")).toBe(false);
  });
  it("does not send a human-directed receipt to Luna", async () => {
    const conversation = {
      conversation: { id: "human-chat", kind: "personal", activeShopId: null },
      participants: [{ role: "account", accountId: "another-person" }],
      messages: []
    } as unknown as ConversationView;
    await mount("marketplace", null, conversation, [receipt]);
    await act(async () => send("Here is your receipt"));
    expect(requests.some((request) => request.path === "/v1/chat/images/read")).toBe(false);
  });
  it("answers buyer arithmetic through the queued daemon without duplicate delivery", async () => {
    await mount();
    await act(async () => send("A basket costs 450 shillings. What do 3 baskets cost?"));
    expect(search).not.toHaveBeenCalled();
    expect(
      requests.find((request) => request.path === "/v1/daemon/tasks" && request.method === "POST")
        ?.body.message
    ).toContain("A basket costs 450 shillings");
    expect(readChatDaemonTasks(session.account.id)).toHaveLength(1);
    completed = true;
    await act(async () => window.dispatchEvent(new Event(daemonTaskUpdatedEvent)));
    expect(messages.filter((message) => message.body.includes("1,350"))).toHaveLength(1);
    expect(readChatDaemonTasks(session.account.id)).toHaveLength(0);
  });
  it.each(["marketplace", "seller"] as const)(
    "schedules and cancels a %s reminder",
    async (mode) => {
      await mount(
        mode,
        mode === "seller" ? ({ id: "shop-1", name: "Shop" } as ActiveBusiness) : null
      );
      await act(async () => send("Remind me in 2 minutes to check my stock."));
      expect(search).not.toHaveBeenCalled();
      expect(requests.find((request) => request.method === "POST")?.body.runAt).toBe(
        "2026-10-16T20:02:00.000Z"
      );
      expect(messages.at(-1)?.body).toContain("Reminder scheduled");
      await act(async () => send("Cancel my latest reminder"));
      expect(
        requests.some((request) => request.method === "DELETE" && request.path.endsWith("task-1"))
      ).toBe(true);
      expect(messages.at(-1)?.body).toBe("Your latest reminder is cancelled.");
    }
  );
  it("asks for a tracking reference then loads the authenticated checkout status", async () => {
    await mount();
    await act(async () => send("Track my delivery"));
    expect(messages.at(-1)?.body).toContain("checkout ID");
    expect(requests).toHaveLength(0);
    await act(async () => send("Track my delivery 990a066d-2a72-4ebf-a1fe-337ee1c9dc8a"));
    expect(messages.at(-1)?.body).toBe("Order order-1: delivered");
    expect(search).not.toHaveBeenCalled();
  });
  it("asks for an unambiguous reminder time without enqueuing work", async () => {
    await mount();
    await act(async () => send("Remind me tomorrow to check stock"));
    expect(messages.at(-1)?.body).toContain("When should I remind you?");
    expect(requests).toHaveLength(0);
  });
  it("keeps explicit shopping requests on marketplace search", async () => {
    await mount();
    await act(async () => send("Find me 50kg maize nearby"));
    expect(search).not.toHaveBeenCalled();
    expect(requests).toEqual([
      expect.objectContaining({
        path: "/buy/assistant",
        body: expect.objectContaining({ message: "Find me 50kg maize nearby" })
      })
    ]);
  });
  it("recovers queued replies after reload only in their originating buyer or seller scope", async () => {
    await mount();
    await act(async () => send("Remind me in 2 minutes to check stock."));
    await mount("seller", { id: "another-shop", name: "Other Shop" } as ActiveBusiness);
    completed = true;
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(messages).toHaveLength(0);
    expect(readChatDaemonTasks(session.account.id)).toHaveLength(1);
    await mount();
    expect(messages.at(-1)?.body).toContain("Reminder: check stock");
    expect(readChatDaemonTasks(session.account.id)).toHaveLength(0);
  });
  it("releases seller chat after the reply while runtime history is still refreshing", async () => {
    historyRefresh = () => new Promise<void>(() => {});
    await mount("seller", { id: "shop-1", name: "Shop" } as ActiveBusiness);
    await act(async () => send("A basket costs 450 shillings. What do 3 baskets cost?"));
    expect(messages.at(-1)?.body).toContain("1,350");
    expect(messages.find((message) => message.author === "merchant")?.status).toBe("delivered");
    expect(requests.some((request) => request.path === "/businesses/shop-1/runtime/turns")).toBe(
      true
    );
  });
  it("does not send human-directed shopping or reminder messages to marketplace search or the model", async () => {
    const conversation = {
      conversation: { id: "human-chat", kind: "personal", activeShopId: null },
      participants: [{ role: "account", accountId: "another-person" }],
      messages: []
    } as unknown as ConversationView;
    await mount("marketplace", null, conversation);
    await act(async () => send("Find me 50kg maize nearby"));
    await act(async () => send("Remind me in 2 minutes to check stock"));
    expect(search).not.toHaveBeenCalled();
    expect(requests.every((request) => request.path.endsWith("/encryption-devices"))).toBe(true);
    expect(readChatDaemonTasks(session.account.id)).toHaveLength(0);
  });
  it("delivers the scheduled reminder text after reload regardless of model wording", async () => {
    await mount();
    await act(async () => send("Remind me in 2 minutes to check my stock."));
    completed = true;
    await mount();
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(messages.at(-1)?.body).toBe("Reminder: check my stock");
    expect(readChatDaemonTasks(session.account.id)).toHaveLength(0);
  });
  it("restores the seller draft after a temporary runtime outage", async () => {
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (input.endsWith("/runtime/turns"))
        return new Response(
          JSON.stringify({ code: "service_unavailable", message: "Unavailable" }),
          { status: 503, headers: { "content-type": "application/json" } }
        );
      return fetch(input, init);
    });
    await mount("seller", { id: "shop-1", name: "Shop" } as ActiveBusiness);
    await act(async () => send("Show my products"));
    expect(draft).toBe("Show my products");
    expect(
      messages.some((message) => message.author === "merchant" && message.status === "pending")
    ).toBe(false);
    expect(messages.at(-1)?.body).toContain("Your draft is saved");
  });
  it("does not mistake an order status question for a purchase", () => {
    expect(parseMarketplaceBuyIntent("What is my order status?")).toBeNull();
    expect(parseMarketplaceBuyIntent("Track my order")).toBeNull();
    expect(
      parseMarketplaceBuyIntent("If I buy 3 baskets at 450 each, how much is that?")
    ).toBeNull();
    expect(parseMarketplaceBuyIntent("I want to order maize")).toBe("maize");
    expect(parseMarketplaceBuyIntent("Nitafutie mahindi")).toBe("mahindi");
    expect(parseReminderIntent("Remind me in 0 minutes to check stock")).toEqual({
      kind: "clarify"
    });
  });
});
