// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const help = vi.hoisted(() => ({ runHelpQuestion: vi.fn(async () => undefined) }));
vi.mock("../apps/web/src/help-chat", () => help);

const { useChatRuntimeState } = await import("../apps/web/src/hooks/useChatRuntimeState");
const { clearDeviceOnlyMessages } = await import("../apps/web/src/chat-device-only-messages");

/**
 * A message sent as a chat opens, before its view has loaded, on an account without a shop. The
 * runtime loads the view to learn where the message goes: a buyer's chat with a shop goes to the
 * shop (it used to be answered by the guest model and never reach the shop), while a personal
 * agent thread still goes to the model.
 */
describe("a send before the conversation view has loaded", () => {
  let host: HTMLDivElement;
  let root: Root;
  const session = {
    account: { id: "account-1" },
    user: { id: "user-1" },
    session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
  } as never;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    clearDeviceOnlyMessages("account-1");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function sendAsChatOpens(
    conversationId: string,
    view: unknown,
    viewStatus = 200,
    extras: {
      attachments?: unknown[];
      replyTo?: string;
      switchTo?: string;
      /** The user picks another message to reply to, in the same chat, while the send waits. */
      replyMeanwhile?: string;
    } = {}
  ) {
    // With switchTo, the view request is held until the user has opened another chat.
    let releaseView: () => void = () => undefined;
    const viewHeld =
      extras.switchTo || extras.replyMeanwhile
        ? new Promise<void>((resolve) => (releaseView = resolve))
        : Promise.resolve();
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      const body = options?.body ? JSON.parse(String(options.body)) : {};
      const json = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { "content-type": "application/json" }
        });
      if (String(url).endsWith(`/v1/conversations/${conversationId}`)) {
        await viewHeld;
        return viewStatus === 200
          ? json(view)
          : json({ code: viewStatus === 404 ? "not_found" : "service_unavailable" }, viewStatus);
      }
      if (String(url).endsWith("/v1/messages") && options?.method === "POST")
        return json({
          id: `server-${body.clientMessageId}`,
          conversationId,
          clientMessageId: body.clientMessageId,
          author: "user",
          authorId: "user-1",
          content: body.content,
          status: "sent",
          createdAt: new Date().toISOString()
        });
      if (String(url).endsWith("/v1/daemon/tasks"))
        return json({ task: { id: "task-1", runAt: new Date().toISOString() } });
      return json({ code: "service_unavailable" }, 503);
    });
    vi.stubGlobal("fetch", fetchMock);
    let sendChatDraft: ((draft?: string) => Promise<void>) | null = null;
    let messages: Array<{ id: string; body: string }> = [];
    let draft = "";
    let attachments: unknown[] = extras.attachments ?? [];
    let replyTo: string | null = extras.replyTo ?? null;
    function Harness({ open = conversationId }: { open?: string }) {
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
        searchBuyFeed: async () => null,
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
          messages = typeof next === "function" ? next(messages as never) : (next as never);
        },
        chatDraft: "",
        setChatDraft: (next) => {
          draft = typeof next === "function" ? next(draft) : next;
        },
        pendingAttachments: (extras.attachments ?? []) as never,
        setPendingAttachments: (next) => {
          attachments = typeof next === "function" ? next(attachments as never) : (next as never);
        },
        runtimeSessionId: null,
        setRuntimeSessionId: () => undefined,
        replyToMessageId: extras.replyTo ?? null,
        setReplyToMessageId: (next) => {
          replyTo = typeof next === "function" ? next(replyTo) : next;
        },
        activeConversationId: open,
        activeConversation: null,
        loadMessagingInbox: async () => undefined,
        registerReset: () => undefined
      });
      sendChatDraft = api.sendChatDraft;
      return null;
    }
    await act(async () => root.render(<Harness />));
    let sending!: Promise<void>;
    await act(async () => {
      sending = sendChatDraft!("do you have maize flour 2kg");
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    // Each step in its own act: React renders a switch only when its act scope ends.
    if (extras.switchTo) await act(async () => root.render(<Harness open={extras.switchTo} />));
    if (extras.replyMeanwhile) replyTo = extras.replyMeanwhile;
    await act(async () => {
      releaseView();
      await sending;
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const calls = fetchMock.mock.calls.map(([url, options]) => [
      options?.method ?? "GET",
      String(url).replace(/^.*\/v1/u, "/v1")
    ]);
    return Object.assign(calls, { messages, draft, attachments, replyTo });
  }

  it("sends a buyer's message to the shop, not to the guest model", async () => {
    const calls = await sendAsChatOpens("shop-chat", {
      conversation: { id: "shop-chat", kind: "storefront", activeShopId: "shop-1" },
      participants: [{ role: "account", accountId: "account-1" }],
      messages: []
    });
    expect(
      calls.filter(([method, path]) => method === "POST" && path === "/v1/messages")
    ).toHaveLength(1);
    expect(calls.some(([, path]) => path.startsWith("/v1/guest/"))).toBe(false);
    // No model task is started for it.
    expect(calls.some(([method, path]) => method === "POST" && path === "/v1/daemon/tasks")).toBe(
      false
    );
  });

  it("still sends a personal agent thread's message to the model", async () => {
    const calls = await sendAsChatOpens("agent-thread", {
      conversation: { id: "agent-thread", kind: "personal", activeShopId: null },
      participants: [{ role: "account", accountId: "account-1" }],
      messages: []
    });
    expect(calls.some(([method, path]) => method === "POST" && path === "/v1/messages")).toBe(
      false
    );
  });

  it("stops, and gives the text back, when the chat's view cannot be loaded", async () => {
    // A slow network is likely here (the chat was still opening): the route is unknown, so the
    // message must not be sent to the model in place of the shop.
    const sent = await sendAsChatOpens("shop-chat", null, 503);
    expect(sent.some(([method, path]) => method === "POST" && path === "/v1/messages")).toBe(false);
    expect(sent.some(([, path]) => path.startsWith("/v1/guest/"))).toBe(false);
    expect(sent.some(([method, path]) => method === "POST" && path === "/v1/daemon/tasks")).toBe(
      false
    );
    expect(sent.messages.map((message) => message.body)).not.toContain(
      "do you have maize flour 2kg"
    );
    expect(sent.draft).toBe("do you have maize flour 2kg");
  });

  it("keeps a help thread's question with the help agent", async () => {
    const sendTarget = await import("../apps/web/src/messaging/send-target");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              conversation: { id: "help-1", kind: "personal", helpTopic: "billing" },
              participants: [{ role: "account", accountId: "account-1" }],
              messages: []
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      )
    );
    const target = await sendTarget.loadSendTarget("help-1", false, session);
    expect("view" in target && target.view?.conversation.helpTopic).toBe("billing");
  });

  it("keeps model routing when the server has no view of the thread (404)", async () => {
    const sent = await sendAsChatOpens("local-thread", null, 404);
    expect(sent.some(([method, path]) => method === "POST" && path === "/v1/messages")).toBe(false);
    expect(sent.messages.map((message) => message.body)).toContain("do you have maize flour 2kg");
  });

  it("gives back the attachments and the reply target too when the send stops", async () => {
    const photo = { id: "att-1", name: "receipt.jpg", type: "image/jpeg", size: 1024 };
    const sent = await sendAsChatOpens("shop-chat", null, 503, {
      attachments: [photo],
      replyTo: "message-7"
    });
    expect(sent.some(([method, path]) => method === "POST" && path === "/v1/messages")).toBe(false);
    expect(sent.attachments).toEqual([photo]);
    expect(sent.replyTo).toBe("message-7");
  });

  it("routes a help thread's question to the help agent, not the guest model", async () => {
    const sent = await sendAsChatOpens("help-1", {
      conversation: { id: "help-1", kind: "personal", helpTopic: "billing" },
      participants: [{ role: "account", accountId: "account-1" }],
      messages: []
    });
    expect(sent.some(([, path]) => path.startsWith("/v1/guest/"))).toBe(false);
    expect(sent.some(([method, path]) => method === "POST" && path === "/v1/daemon/tasks")).toBe(
      false
    );
    expect(help.runHelpQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ message: "do you have maize flour 2kg" })
    );
  });

  it("does not carry the reply target into another chat opened while the send waited", async () => {
    const sent = await sendAsChatOpens("shop-chat", null, 503, {
      replyTo: "message-in-shop-chat",
      switchTo: "other-chat"
    });
    expect(sent.some(([method, path]) => method === "POST" && path === "/v1/messages")).toBe(false);
    // The other chat's composer must not be replying to a message of the first.
    expect(sent.replyTo).toBeNull();
  });

  it("keeps a reply target picked in the same chat while the send waited", async () => {
    const sent = await sendAsChatOpens("shop-chat", null, 503, {
      replyTo: "first-target",
      replyMeanwhile: "newer-target"
    });
    expect(sent.replyTo).toBe("newer-target");
  });
});
