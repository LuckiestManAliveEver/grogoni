// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatRuntimeState } from "../apps/web/src/hooks/useChatRuntimeState";
import { readMessagingOutbox } from "../apps/web/src/messaging/outbox";

// A message that could not be sent waits in the device outbox. That stored entry, and anything
// the client logs along the way, must never contain the session cookie or a credential.
const SECRET = "SESSION-SECRET-7f3c9a";

describe("outbox and client logs carry no credentials", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("stores the waiting message without the session cookie or token", async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    document.cookie = `grogoni_session=${SECRET}`;
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(
          args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")
        );
      });
    // The connection drops: the message goes to the outbox to be resent.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
    const session = {
      account: { id: "account-1" },
      user: { id: "user-1" },
      session: { id: SECRET, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
    } as never;
    const conversation = {
      conversation: { id: "agent-chat", kind: "personal", activeShopId: "shop-1" },
      participants: [{ role: "account", accountId: "account-1" }],
      hasHumanRecipient: false
    } as never;
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
        createManagedRuntimeSession: async () => "r1",
        ensureRuntimeSession: async () => "r1",
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
      await send!("Add 5 bags of sugar to stock");
    });
    await vi.waitFor(() => {
      expect(readMessagingOutbox("account-1")).toHaveLength(1);
    });

    const stored = JSON.stringify(readMessagingOutbox("account-1"));
    expect(stored).toContain("Add 5 bags of sugar to stock");
    const everything = [
      stored,
      ...Object.keys(localStorage).map((key) => `${key}=${localStorage.getItem(key)}`),
      ...logged
    ].join("\n");
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toMatch(/grogoni_session|"cookie"|authorization|bearer /iu);
    act(() => root.unmount());
  });
});
