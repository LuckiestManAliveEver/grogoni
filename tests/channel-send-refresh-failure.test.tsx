// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { ConversationView } from "@grogoni/shared-types";

import { useChatRuntimeState } from "../apps/web/src/hooks/useChatRuntimeState";

/**
 * A message to a connected channel (SMS, email) went out, then the inbox refresh after it failed.
 * The app treated that as a failed send: it removed the bubble and put the text back, and resending
 * used a new idempotency key, so the customer got the SMS twice.
 */
describe("a channel send whose follow-up refresh fails", () => {
  it("keeps the sent message and does not invite a second send", async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const posted: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input), "http://localhost").pathname;
        posted.push(path);
        if (path.endsWith("/channel-messages"))
          return new Response(
            JSON.stringify({
              message: {
                id: "sent-1",
                conversationId: "channel-1",
                clientMessageId: "x",
                author: "account",
                authorId: "user-1",
                content: { type: "text", text: "Your order is ready" },
                provider: "native_sms",
                status: "queued"
              }
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        throw new Error(`unexpected ${path}`);
      })
    );
    const session = {
      account: { id: "account-1" },
      user: { id: "user-1" },
      session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
    } as never;
    const conversation = {
      conversation: { id: "channel-1" },
      participants: [
        { role: "account", accountId: "account-1" },
        { role: "external", externalIdentityId: "customer-phone" }
      ]
    } as unknown as ConversationView;
    let messages: Array<{ id: string; body: string }> = [];
    const drafts: string[] = [];
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
        setChatDraft: (draft) => drafts.push(draft),
        pendingAttachments: [],
        setPendingAttachments: () => undefined,
        runtimeSessionId: null,
        setRuntimeSessionId: () => undefined,
        replyToMessageId: null,
        setReplyToMessageId: () => undefined,
        activeConversationId: "channel-1",
        activeConversation: conversation,
        // The refresh after the send fails (a dropped connection).
        loadMessagingInbox: async () => {
          throw new TypeError("network down");
        },
        registerReset: () => undefined
      });
      send = api.sendChatDraft;
      return null;
    }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Harness />));
    await act(async () => {
      await send!("Your order is ready");
    });
    expect(posted.filter((path) => path.endsWith("/channel-messages"))).toHaveLength(1);
    expect(messages.map((message) => message.id)).toContain("sent-1");
    expect(drafts.at(-1)).toBe("");
    expect(statuses.at(-1)).toMatch(/SMS queued/u);
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });
});
