// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationView } from "@grogoni/shared-types";

import { useChatRuntimeState } from "../apps/web/src/hooks/useChatRuntimeState";
import {
  guestExplainReply,
  parseMarketplaceBuyIntent,
  routeGuestMessage
} from "../apps/web/src/marketplace-search-reply";
import type { SessionResponse } from "../apps/web/src/grogoni-application-shared";

/** Product-search helper rules remain available, but personal chat always uses the model. */
describe("guest message routing", () => {
  const route = (message: string) => {
    const routed = routeGuestMessage(message);
    return routed.kind === "search" ? `search:${routed.query}` : routed.reply;
  };
  const shopSetup = expect.stringMatching(/^To sell on Grogoni, tap the shop button/u);
  const orderHelp = expect.stringMatching(/^I can't look up orders or deliveries/u);
  const welcome = expect.stringMatching(/^You're welcome/u);

  it.each([
    ["sugar", "search:sugar"],
    ["Sugar?", "search:Sugar"],
    ["Sugar please", "search:Sugar"],
    ["unga?", "search:unga"],
    ["maize flour 2kg", "search:maize flour 2kg"],
    ["Track pants", "search:Track pants"],
    ["I want to buy sugar", "search:sugar"],
    ["I want to order sugar", "search:sugar"],
    ["Order sugar", "search:sugar"],
    ["I need sugar", "search:sugar"],
    ["I'd like sugar", "search:sugar"],
    ["Give me 2kg sugar", "search:2kg sugar"],
    ["Sell me sugar", "search:sugar"],
    ["Can I get sugar?", "search:sugar"],
    ["Can I order 2kg maize flour?", "search:2kg maize flour"],
    ["Is there sugar?", "search:sugar"],
    ["Is sugar available?", "search:sugar"],
    ["Does anyone sell rice?", "search:rice"],
    ["Who has sugar?", "search:sugar"],
    ["Where can I get rice?", "search:rice"],
    ["Selling price of maize", "search:maize"],
    ["I want to buy a delivery bag", "search:delivery bag"],
    ["Hi, I need sugar", "search:sugar"],
    ["Hi, do you have sugar?", "search:sugar"],
    ["Thanks, do you have rice?", "search:rice"],
    ["Please, do you have unga?", "search:unga"],
    ["Nataka sukari", "search:sukari"],
    ["Nataka kuagiza sukari", "search:sukari"],
    ["Kuna mchele?", "search:mchele"],
    ["help me find sugar", "search:sugar"],
    ["Bei ya sukari ni ngapi?", "search:sukari"],
    ["Thanks! I also need sugar", "search:sugar"],
    ["Thanks for the help, I need rice", "search:rice"],
    ["thanks, sugar too", "search:sugar"],
    ["Do you have sugar available?", "search:sugar"],
    ["Is there sugar in stock?", "search:sugar"],
    ["Looking for rice", "search:rice"],
    ["Show me sugar", "search:sugar"],
    ["Any eggs?", "search:eggs"],
    ["Is there anyone selling eggs?", "search:eggs"],
    ["cement price?", "search:cement"],
    ["Who sells eggs near me?", "search:eggs"],
    ["Who has sugar in Nairobi?", "search:sugar"],
    ["How much for a bag of cement?", "search:bag of cement"],
    ["Can you help me find rice?", "search:rice"]
  ])("searches the product in %j", (message, expected) => {
    expect(route(message)).toBe(expected);
  });

  it.each([
    "hello there",
    "hi",
    "Habari!",
    "Habari gani",
    "Habari yako",
    "Hujambo",
    "Karibu",
    "Good night",
    "Morning",
    "Bye",
    "ok",
    "yes",
    "sawa",
    "Sawa sawa",
    "Poa sana",
    "help",
    "Help me",
    "Help me please",
    "Can you help me",
    "Please call me",
    "I want to talk to a person",
    "Who are you",
    "what is this?",
    "what is this app?",
    "I want to know how this works",
    "I am trying to figure out how this whole thing works",
    "help!",
    "Help?",
    "I need help",
    "Hi I need help",
    "need help",
    "how are you?",
    "hi how are you",
    "good morning, how are you?",
    "see you later",
    "Is anyone there?",
    "Hello, is anyone there?",
    "👍",
    "Good evening sir",
    "How much is it?",
    "What's up",
    "Pole",
    "Niko sawa",
    "?",
    "??",
    "!!",
    "..."
  ])("answers %j without searching it", (message) => {
    expect(route(message)).toBe(guestExplainReply);
  });

  it.each([
    "Where is my order?",
    "I want to cancel my order",
    "How much does delivery cost?",
    "What is the delivery fee?",
    "Do you deliver to Nakuru",
    "Track order",
    "track my delivery",
    "Delivery?",
    "kuna shida",
    "I have a problem with my order",
    "Can you deliver sugar to Kisumu?"
  ])("sends order and delivery questions to the shop: %j", (message) => {
    expect(route(message)).toEqual(orderHelp);
  });

  it.each(["How do I open a shop", "sell", "I want to start a business", "fungua duka"])(
    "points %j at shop setup",
    (message) => {
      expect(route(message)).toEqual(shopSetup);
    }
  );

  it.each([
    "Thanks!",
    "asante sana",
    "Thank you so much!",
    "Thank you very much",
    "Thanks bro",
    "Thank u",
    "OK thanks",
    "Ok thank you",
    "Thank you for the sugar",
    "Thank you for your help",
    "Thank you, I found it",
    "Thanks for the help",
    "Asante kwa msaada"
  ])("answers %j with a welcome", (message) => {
    expect(route(message)).toEqual(welcome);
  });

  it("never sends a message about the shop's own hours to shop setup", () => {
    expect(route("When do you open the shop?")).not.toEqual(shopSetup);
  });
});

describe("buy intent", () => {
  it("extracts the product and drops the scaffolding around it", () => {
    expect(parseMarketplaceBuyIntent("I want to buy sugar")).toBe("sugar");
    expect(parseMarketplaceBuyIntent("Hi, do you have sugar?")).toBe("sugar");
    expect(parseMarketplaceBuyIntent("Habari yako, I'm looking for maize flour")).toBe(
      "maize flour"
    );
    expect(parseMarketplaceBuyIntent("how much is sugar")).toBe("sugar");
    expect(parseMarketplaceBuyIntent("How much does a bag of rice cost?")).toBe("bag of rice");
    expect(parseMarketplaceBuyIntent("price of cooking oil")).toBe("cooking oil");
    expect(parseMarketplaceBuyIntent("natafuta mafuta ya kupika")).toBe("mafuta ya kupika");
    // Nothing asked for: not a buy request (it may still be searched as a product name).
    expect(parseMarketplaceBuyIntent("sugar")).toBeNull();
    expect(parseMarketplaceBuyIntent("hello there")).toBeNull();
    expect(parseMarketplaceBuyIntent("what is this app?")).toBeNull();
    expect(parseMarketplaceBuyIntent("")).toBeNull();
  });
});

describe("guest chat send", () => {
  let host: HTMLDivElement;
  let root: Root;
  const session = {
    account: { id: "account-1" },
    user: { id: "user-1", accountId: "account-1", displayName: "Guest", language: "en" },
    session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
  } as unknown as SessionResponse;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options?: RequestInit) => {
        const payload = options?.body ? JSON.parse(String(options.body)) : {};
        return new Response(
          JSON.stringify(
            url.endsWith("/v1/daemon/tasks")
              ? { task: { id: "task-1", runAt: new Date().toISOString() } }
              : { id: payload.clientMessageId, conversationId: payload.conversationId }
          ),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      })
    );
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function send(message: string, activeConversation: ConversationView | null) {
    const searchBuyFeed = vi.fn(async () => null);
    const rendered: Array<{ body: string; deviceOnlyIn?: string | null }> = [];
    let sendChatDraft: ((draft?: string) => Promise<void>) | null = null;
    function Harness() {
      const api = useChatRuntimeState({
        business: null,
        mode: "marketplace",
        session,
        authBootstrapState: "authenticated",
        ensureAuthenticatedSession: async () => session,
        rejectDefinitiveAuthenticationFailure: () => false,
        agentSettings: { model: "m", role: "shopkeeper", instructions: "", name: "S" } as never,
        setStatusMessage: () => undefined,
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
        createManagedRuntimeSession: async () => "r1",
        ensureRuntimeSession: async () => "r1",
        loadDocumentImports: async () => undefined,
        chatMessages: [],
        setChatMessages: (next) => {
          // Applied to what is rendered, as React does: a guest's bubble and its reply arrive
          // as two updates.
          const resolved = typeof next === "function" ? next([...rendered]) : next;
          rendered.splice(0, rendered.length, ...resolved);
        },
        chatDraft: "",
        setChatDraft: () => undefined,
        pendingAttachments: [],
        setPendingAttachments: () => undefined,
        runtimeSessionId: null,
        setRuntimeSessionId: () => undefined,
        replyToMessageId: null,
        setReplyToMessageId: () => undefined,
        activeConversationId: activeConversation?.id ?? "agent-thread-1",
        activeConversation,
        loadMessagingInbox: async () => undefined,
        registerReset: () => undefined
      });
      sendChatDraft = api.sendChatDraft;
      return null;
    }
    await act(async () => root.render(<Harness />));
    await act(async () => {
      await sendChatDraft!(message).catch(() => undefined);
    });
    return { searchBuyFeed, rendered };
  }

  it.each(["hello there", "Help me please", "Explain why a rainbow forms"])(
    "sends %j to the conversational model without a structured reply",
    async (message) => {
      const { searchBuyFeed, rendered } = await send(message, null);
      expect(searchBuyFeed).not.toHaveBeenCalled();
      expect(rendered.map((item) => item.body)).toEqual([message]);
      const requests = vi.mocked(fetch).mock.calls;
      const task = requests.find(
        ([url, options]) => String(url).endsWith("/v1/daemon/tasks") && options?.method === "POST"
      );
      expect(task).toBeDefined();
      expect(JSON.parse(String(task![1]!.body))).toMatchObject({
        message,
        conversation: { id: "agent-thread-1", kind: "reply" }
      });
      expect(requests.some(([url]) => String(url).includes("/v1/guest/intent"))).toBe(false);
    }
  );

  it("never searches or explains a message addressed to another person", async () => {
    const direct = {
      id: "dm-1",
      participants: [
        { role: "account", accountId: "account-1" },
        { role: "account", accountId: "friend-2" }
      ]
    } as unknown as ConversationView;
    const { searchBuyFeed, rendered } = await send("hello there", direct);
    expect(searchBuyFeed).not.toHaveBeenCalled();
    expect(rendered.map((message) => message.body)).not.toContain(guestExplainReply);
    const again = await send("do you have sugar?", direct);
    expect(again.searchBuyFeed).not.toHaveBeenCalled();
  });
});
