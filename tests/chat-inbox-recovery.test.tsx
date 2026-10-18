// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatInboxState } from "../apps/web/src/hooks/useChatInboxState";
import type { ChatMessage } from "../apps/web/src/app-shell";
import type { SessionResponse } from "../apps/web/src/grogoni-application-shared";

// Inbox refreshes must preserve the unbound assistant thread, and desktop visibility must not
// become an unsolicited modal when the viewport contracts.
describe("assistant inbox recovery", () => {
  let root: Root;
  let inbox: ReturnType<typeof useChatInboxState>;
  let messages: ChatMessage[];
  let media: EventTarget & { matches: boolean };
  beforeEach(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    media = Object.assign(new EventTarget(), { matches: true });
    vi.stubGlobal("matchMedia", () => media);
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ conversations: [] }), {
          headers: { "content-type": "application/json" }
        })
    );
    root = createRoot(document.createElement("div"));
    function Harness() {
      const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
        { id: "daemon:task:1", author: "grogoniclaw", body: "1,350 shillings" }
      ]);
      messages = chatMessages;
      inbox = useChatInboxState({
        business: null,
        session: { account: { id: "buyer" }, user: { id: "user" } } as SessionResponse,
        e2eeIdentity: null,
        mode: "marketplace",
        setStatusMessage: () => undefined,
        setView: () => undefined,
        applySessionContextForConversation: async () => null,
        requireMessagingSignIn: () => undefined,
        chatMessages,
        setChatMessages,
        setChatDraft: () => undefined,
        setReplyToMessageId: () => undefined,
        registerReset: () => undefined
      });
      return null;
    }
    await act(async () => root.render(<Harness />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });
  it("retains local assistant replies when refreshing an inbox with no selected conversation", async () => {
    await act(async () => inbox.loadMessagingInbox());
    expect(messages).toEqual([expect.objectContaining({ body: "1,350 shillings" })]);
  });
  it("clears an explicitly requested conversation that is no longer accessible", async () => {
    await act(async () => inbox.loadMessagingInbox("removed-conversation"));
    expect(messages).toEqual([]);
  });
  it("closes the inbox when transitioning from desktop to phone", async () => {
    expect(inbox.isMessagingInboxOpen).toBe(true);
    await act(async () =>
      media.dispatchEvent(Object.assign(new Event("change"), { matches: false }))
    );
    expect(inbox.isMessagingInboxOpen).toBe(false);
    await act(async () => inbox.setIsMessagingInboxOpen(true));
    expect(inbox.isMessagingInboxOpen).toBe(true);
  });
});
