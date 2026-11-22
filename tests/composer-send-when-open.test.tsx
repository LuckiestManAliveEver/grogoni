// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatComposer } from "../apps/web/src/ChatComposer";
import { useChatComposerState } from "../apps/web/src/hooks/useChatComposerState";

// Enter pressed while the chat is still opening (a cold load) used to be dropped silently: the
// text stayed in the box and nothing was sent. It is now held and sent once the chat opens, and
// only to the conversation the URL named when Enter was pressed.
function Harness({
  isOpening,
  onSend,
  draft = "Typed while the chat opens",
  opened = "conversation-1"
}: {
  isOpening: boolean;
  onSend: () => void;
  draft?: string;
  opened?: string;
}) {
  const composer = useChatComposerState({
    activeConversationId: isOpening ? null : opened,
    channelEndpoints: [],
    chatDraft: draft,
    initialEmailSubject: "",
    nearbyScope: null,
    smsDefaultCountry: "KE",
    onDraftChange: vi.fn(),
    onPlatformHandoff: vi.fn(),
    onSend
  });
  return (
    <ChatComposer
      activeAgentName="Shopkeeper"
      agent={null}
      business={null}
      channelEndpoints={[]}
      composer={composer}
      invoices={[]}
      isAuthenticated
      isBrowserGenerating={false}
      isSending={false}
      isOpening={isOpening}
      activeConversationId={isOpening ? null : opened}
      mode="seller"
      pendingAttachments={[]}
      replyToMessageId={null}
      selectedConversationTitle=""
      selectedEmailCustomerId={null}
      onAgentChange={vi.fn()}
      onAttachmentChange={vi.fn()}
      onCancelGeneration={vi.fn()}
      onCancelReply={vi.fn()}
      onOpenAgentProfile={vi.fn()}
      onRemoveAttachment={vi.fn()}
      onRequireSignIn={vi.fn()}
      onSellerPhotoCapture={vi.fn()}
    />
  );
}

describe("Enter while the chat is still opening", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    window.history.replaceState(null, "", "/workspace/conversations/conversation-1");
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    window.history.replaceState(null, "", "/");
  });

  const pressEnter = async () =>
    act(async () => {
      host
        .querySelector("textarea")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

  it("holds the message, says so, and sends it once when the chat opens", async () => {
    const onSend = vi.fn();
    await act(async () => root.render(<Harness isOpening onSend={onSend} />));
    await pressEnter();
    expect(onSend).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Sends as soon as this chat opens.");
    await act(async () => root.render(<Harness isOpening={false} onSend={onSend} />));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain("Sends as soon as this chat opens.");
    await act(async () => root.render(<Harness isOpening={false} onSend={onSend} />));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("does not send to another conversation when the requested one could not be opened", async () => {
    const onSend = vi.fn();
    await act(async () => root.render(<Harness isOpening onSend={onSend} />));
    await pressEnter();
    window.history.replaceState(null, "", "/workspace/chat");
    await act(async () => root.render(<Harness isOpening={false} onSend={onSend} />));
    expect(onSend).not.toHaveBeenCalled();
    expect(host.querySelector("textarea")!.value).toBe("Typed while the chat opens");
  });

  it("does not promise to send an empty draft", async () => {
    const onSend = vi.fn();
    await act(async () => root.render(<Harness isOpening onSend={onSend} draft="" />));
    await pressEnter();
    expect(host.textContent).not.toContain("Sends as soon as this chat opens.");
  });

  it("does not send to a different chat that opened while the URL still names the first", async () => {
    // The URL's chat was not in the inbox (archived), so another became active; or the user
    // picked another chat before the URL changed.
    const onSend = vi.fn();
    await act(async () => root.render(<Harness isOpening onSend={onSend} />));
    await pressEnter();
    await act(async () =>
      root.render(<Harness isOpening={false} onSend={onSend} opened="agent-session" />)
    );
    expect(onSend).not.toHaveBeenCalled();
    expect(host.querySelector("textarea")!.value).toBe("Typed while the chat opens");
  });
});
