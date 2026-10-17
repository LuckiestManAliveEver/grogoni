// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChatComposerState } from "../apps/web/src/hooks/useChatComposerState";
import { useChatRuntimeState } from "../apps/web/src/hooks/useChatRuntimeState";
import type { ChatMessage } from "../apps/web/src/app-shell";

/**
 * Production journey: a message sent within 120 ms of typing stayed in the box after it was sent
 * (the parent's draft had not caught up, so the send's "clear the draft" changed nothing), inviting
 * a second send of the same text.
 */
describe("sending from the composer", () => {
  let host: HTMLDivElement;
  let root: Root;
  let composer: ReturnType<typeof useChatComposerState> | null = null;

  function Harness({ keepsDraft }: { keepsDraft: boolean }) {
    const [chatDraft, setChatDraft] = useState("");
    composer = useChatComposerState({
      activeConversationId: "conversation-1",
      channelEndpoints: [],
      chatDraft,
      initialEmailSubject: "",
      nearbyScope: null,
      smsDefaultCountry: "KE",
      onDraftChange: setChatDraft,
      onPlatformHandoff: () => undefined,
      // A send either clears the draft (sent) or leaves it ("Your draft is saved").
      onSend: () => {
        if (!keepsDraft) setChatDraft("");
      }
    });
    return null;
  }

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("empties the box when a send made right after typing goes out", () => {
    act(() => root.render(<Harness keepsDraft={false} />));
    act(() => composer!.updateLiveDraft("hello there"));
    act(() => composer!.sendLiveDraft());
    expect(composer!.liveDraft).toBe("");
  });

  it("keeps the text when the send keeps the draft", () => {
    act(() => root.render(<Harness keepsDraft />));
    act(() => composer!.updateLiveDraft("hello there"));
    act(() => composer!.sendLiveDraft());
    expect(composer!.liveDraft).toBe("hello there");
  });

  it("empties the box when the real send runs within 120 ms of the last keystroke", async () => {
    // The composer and the chat runtime together: the runtime's send starts from a render whose
    // draft is behind the composer's, so it must read the box as it is now before clearing it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      })
    );
    const session = {
      account: { id: "account-1" },
      user: { id: "user-1", accountId: "account-1", displayName: "G", language: "en" },
      session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
    } as never;
    const searchBuyFeed = vi.fn(async () => ({
      query: "sugar please",
      results: [],
      marketplaceConnectorAvailable: false
    }));
    function Parent() {
      const [chatDraft, setChatDraft] = useState("");
      const [messages, setMessages] = useState<ChatMessage[]>([]);
      const runtime = useChatRuntimeState({
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
        chatMessages: messages,
        setChatMessages: setMessages,
        chatDraft,
        setChatDraft,
        pendingAttachments: [],
        setPendingAttachments: () => undefined,
        runtimeSessionId: null,
        setRuntimeSessionId: () => undefined,
        replyToMessageId: null,
        setReplyToMessageId: () => undefined,
        activeConversationId: "agent-thread-1",
        activeConversation: null,
        loadMessagingInbox: async () => undefined,
        registerReset: () => undefined
      } as never);
      composer = useChatComposerState({
        activeConversationId: "agent-thread-1",
        channelEndpoints: [],
        chatDraft,
        initialEmailSubject: "",
        nearbyScope: null,
        smsDefaultCountry: "KE",
        onDraftChange: setChatDraft,
        onPlatformHandoff: () => undefined,
        onSend: (draft) => void runtime.sendChatDraft(draft)
      });
      return null;
    }
    try {
      await act(async () => root.render(<Parent />));
      act(() => composer!.updateLiveDraft("sugar"));
      act(() => void vi.advanceTimersByTime(200));
      act(() => composer!.updateLiveDraft("sugar please"));
      await act(async () => composer!.sendLiveDraft());
      vi.useRealTimers();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(searchBuyFeed).toHaveBeenCalledWith("sugar");
      expect(composer!.liveDraft).toBe("");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
