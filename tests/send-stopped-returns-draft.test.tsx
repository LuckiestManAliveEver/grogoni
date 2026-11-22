// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment, ChatMessage } from "../apps/web/src/app-shell";
import { useChatRuntimeState } from "../apps/web/src/hooks/useChatRuntimeState";
import { unsentSendStatus } from "../apps/web/src/messaging/unsent-send-status";

// A send that stops before anything leaves the device must not strand the message. Seen on Home:
// a guest's device session could not be created (POST /auth/continue answered 503), the status
// said so, but the bubble sat on "Sending…" forever and the typed text was already gone from the
// box. Every such stop now takes the bubble back out and returns the text (and attachments) to
// the composer.

type Probe = {
  messages: ChatMessage[];
  draft: string;
  attachments: ChatAttachment[];
  status: string;
  send: (draft?: string) => Promise<void>;
};

const session = {
  account: { id: "account-1" },
  user: { id: "user-1" },
  session: { id: "s-1", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
} as never;

const agentConversation = {
  conversation: { id: "agent-chat", kind: "personal" },
  participants: [{ role: "account", accountId: "account-1" }],
  hasHumanRecipient: false
} as never;

async function mountHarness(options: {
  session: unknown;
  authBootstrapState: string;
  ensureAuthenticatedSession: () => Promise<unknown>;
  attachments?: ChatAttachment[];
}) {
  const probe = {} as Probe;
  function Harness() {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [draft, setDraft] = useState("");
    const [attachments, setAttachments] = useState<ChatAttachment[]>(options.attachments ?? []);
    const [status, setStatus] = useState("");
    const api = useChatRuntimeState({
      business: null,
      mode: "buyer",
      session: options.session,
      authBootstrapState: options.authBootstrapState,
      ensureAuthenticatedSession: options.ensureAuthenticatedSession,
      rejectDefinitiveAuthenticationFailure: () => false,
      agentSettings: { model: "m", role: "shopkeeper", instructions: "", name: "S" } as never,
      setStatusMessage: setStatus,
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
      chatMessages: messages,
      setChatMessages: setMessages,
      chatDraft: draft,
      setChatDraft: setDraft,
      pendingAttachments: attachments,
      setPendingAttachments: setAttachments,
      runtimeSessionId: null,
      setRuntimeSessionId: () => undefined,
      replyToMessageId: null,
      setReplyToMessageId: () => undefined,
      activeConversationId: "agent-chat",
      activeConversation: agentConversation,
      loadMessagingInbox: async () => undefined,
      registerReset: () => undefined
    } as never);
    Object.assign(probe, { messages, draft, attachments, status, send: api.sendChatDraft });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  return { probe, unmount: () => act(() => root.unmount()) };
}

describe("a send stopped before it leaves the device gives the message back", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  function setup() {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );
  }

  it("guest on Home: device session cannot be created", async () => {
    setup();
    const { probe, unmount } = await mountHarness({
      session: null,
      authBootstrapState: "anonymous",
      ensureAuthenticatedSession: async () => null
    });
    await act(async () => {
      await probe.send("hello do you have tomatoes");
    });
    await vi.waitFor(() => expect(probe.draft).toBe("hello do you have tomatoes"));
    expect(probe.messages.filter((m) => m.author === "merchant")).toEqual([]);
    expect(probe.status).toMatch(/not sent.*draft is saved/iu);
    unmount();
  });

  it("signed-in session fails its revalidation", async () => {
    setup();
    const { probe, unmount } = await mountHarness({
      session,
      authBootstrapState: "checking",
      ensureAuthenticatedSession: async () => null
    });
    await act(async () => {
      await probe.send("restock 5 bags of sugar");
    });
    await vi.waitFor(() => expect(probe.draft).toBe("restock 5 bags of sugar"));
    expect(probe.messages.filter((m) => m.author === "merchant")).toEqual([]);
    unmount();
  });

  it("offline with attachments: text and attachments go back to the composer", async () => {
    setup();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const attachment = {
      id: "a-1",
      name: "receipt.jpg",
      mimeType: "image/jpeg",
      size: 10
    } as unknown as ChatAttachment;
    const { probe, unmount } = await mountHarness({
      session,
      authBootstrapState: "authenticated",
      ensureAuthenticatedSession: async () => session,
      attachments: [attachment]
    });
    await act(async () => {
      await probe.send("read this receipt");
    });
    await vi.waitFor(() => expect(probe.draft).toBe("read this receipt"));
    expect(probe.attachments).toEqual([attachment]);
    expect(probe.messages.filter((m) => m.author === "merchant")).toEqual([]);
    expect(probe.status).toMatch(/needs a connection to Luna/u);
    unmount();
  });

  it("every unsent-send status tells the person their draft was kept", () => {
    // The text goes back to the box on each of these stops; the status must not imply it was lost.
    for (const status of Object.values(unsentSendStatus)) expect(status).toMatch(/draft is saved/u);
  });
});
