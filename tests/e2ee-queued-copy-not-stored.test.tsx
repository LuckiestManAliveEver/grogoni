// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationView } from "@grogoni/shared-types";

import type * as Plumbing from "../apps/web/src/chat-message-plumbing";

vi.mock("../apps/web/src/chat-message-plumbing", async () => {
  const actual = await vi.importActual<typeof Plumbing>("../apps/web/src/chat-message-plumbing");
  return { ...actual, getConversationEncryptionDevices: vi.fn(async () => []) };
});
vi.mock("../apps/web/src/e2ee", () => ({
  encryptDirectMessage: vi.fn(async () => ({ type: "encrypted", ciphertext: "opaque" })),
  decryptDirectMessage: vi.fn()
}));

const { useChatRuntimeState } = await import("../apps/web/src/hooks/useChatRuntimeState");
const { readDeviceOnlyMessages } = await import("../apps/web/src/chat-device-only-messages");
const { readMessagingOutbox } = await import("../apps/web/src/messaging/outbox");

/**
 * A direct message to a person is end-to-end encrypted: the outbox keeps only ciphertext. Its
 * thread copy (the readable text) must stay in memory, never in localStorage, where it would
 * outlive the session on a shared phone.
 */
describe("a queued end-to-end encrypted message", () => {
  let host: HTMLDivElement;
  let root: Root;
  const session = {
    account: { id: "account-1" },
    user: { id: "user-1" },
    session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
  } as never;
  const direct = {
    conversation: { id: "dm-1", kind: "personal" },
    participants: [
      { role: "account", accountId: "account-1" },
      { role: "account", accountId: "friend-2" }
    ]
  } as unknown as ConversationView;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: "service_unavailable" }), {
            status: 503,
            headers: { "content-type": "application/json" }
          })
      )
    );
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("keeps its readable text out of storage while the ciphertext waits in the outbox", async () => {
    let messages: Array<{ body: string; deviceOnlyIn?: string | null }> = [];
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
        setChatDraft: () => undefined,
        pendingAttachments: [],
        setPendingAttachments: () => undefined,
        runtimeSessionId: null,
        setRuntimeSessionId: () => undefined,
        replyToMessageId: null,
        setReplyToMessageId: () => undefined,
        activeConversationId: "dm-1",
        activeConversation: direct,
        loadMessagingInbox: async () => undefined,
        registerReset: () => undefined
      });
      sendChatDraft = api.sendChatDraft;
      return null;
    }
    await act(async () => root.render(<Harness />));
    await act(async () => {
      await sendChatDraft!("meet me at the shop at six");
    });

    expect(messages).toContainEqual(
      expect.objectContaining({ body: "meet me at the shop at six", deviceOnlyIn: "dm-1" })
    );
    expect(readMessagingOutbox("account-1")).toHaveLength(1);
    // Held in page memory (a thread switch keeps it), never in storage.
    expect(readDeviceOnlyMessages("account-1").map((message) => message.body)).toEqual([
      "meet me at the shop at six"
    ]);
    expect(JSON.stringify({ ...localStorage })).not.toContain("meet me at the shop at six");
  });
});
