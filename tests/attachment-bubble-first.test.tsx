// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatRuntimeState } from "../apps/web/src/hooks/useChatRuntimeState";

// A message with attachments to an agent appears at once, thumbnails included, before Luna has
// read the attachments; the reading shows as its own progress line. Every network call stalls.
describe("attachments after the bubble", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("renders the bubble with its attachments before extraction finishes", async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined))
    );
    const attachment = {
      id: "attachment-1",
      name: "receipt.jpg",
      contentType: "image/jpeg",
      url: "data:image/jpeg;base64,/9j/",
      size: 4
    };
    const session = {
      account: { id: "account-1" },
      user: { id: "user-1" },
      session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
    } as never;
    const conversation = {
      conversation: { id: "agent-chat", kind: "personal", activeShopId: "shop-1" },
      participants: [{ role: "account", accountId: "account-1" }],
      hasHumanRecipient: false
    } as never;
    let messages: Array<{ id: string; body: string; attachments?: unknown[]; status?: string }> =
      [];
    const statuses: string[] = [];
    let send: ((draft?: string) => Promise<void>) | null = null;
    function Harness() {
      const api = useChatRuntimeState({
        business: { id: "shop-1", name: "Shop", language: "en", role: "owner" } as never,
        mode: "seller",
        session,
        authBootstrapState: "authenticated",
        ensureAuthenticatedSession: async () => session,
        rejectDefinitiveAuthenticationFailure: () => false,
        agentSettings: { model: "m", role: "shopkeeper", instructions: "", name: "S" } as never,
        setStatusMessage: (message) => statuses.push(message),
        navigateToView: () => undefined,
        requireMessagingSignIn: () => undefined,
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
        setChatDraft: () => undefined,
        pendingAttachments: [attachment] as never,
        setPendingAttachments: () => undefined,
        runtimeSessionId: null,
        setRuntimeSessionId: () => undefined,
        replyToMessageId: null,
        setReplyToMessageId: () => undefined,
        activeConversationId: "agent-chat",
        activeConversation: conversation,
        loadMessagingInbox: async () => undefined,
        registerReset: () => undefined
      });
      send = api.sendChatDraft;
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Harness />));
    await act(async () => {
      await send!("What is on this receipt?");
    });
    // On screen at once, with its attachment, while every request is still waiting.
    const bubble = messages.find((message) => message.body === "What is on this receipt?");
    expect(bubble).toBeDefined();
    expect(bubble!.attachments).toEqual([attachment]);
    expect(bubble!.status).not.toBe("failed");
    await vi.waitFor(() => {
      expect(statuses).toContain("Luna is reading your attachments…");
    });
    act(() => root.unmount());
  });
});
