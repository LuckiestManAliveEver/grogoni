// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatComposer } from "../apps/web/src/ChatComposer";
import { useChatComposerState } from "../apps/web/src/hooks/useChatComposerState";

describe("mobile chat composer actions", () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    host.id = "root";
    document.body.append(host);
    window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
    window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("puts the message box on top, a bottom row with More/pills/mic/Send, moves Send via under the plus sign, and opens the accessible action sheet", async () => {
    function Harness() {
      const composer = useChatComposerState({
        activeConversationId: "conversation-1",
        channelEndpoints: [],
        chatDraft: "",
        initialEmailSubject: "",
        nearbyScope: null,
        smsDefaultCountry: "KE",
        onDraftChange: vi.fn(),
        onPlatformHandoff: vi.fn(),
        onSend: vi.fn()
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

    const root = createRoot(host);
    await act(async () => root.render(<Harness />));

    const composer = host.querySelector(".composer")!;
    const bottomRow = composer.querySelector(".composer-bottom-row")!;
    expect(bottomRow).not.toBeNull();
    // The message box is its own top row, above the bottom action row.
    const textarea = composer.querySelector('textarea[aria-label="Message"]')!;
    expect(textarea).not.toBeNull();
    expect(bottomRow.contains(textarea)).toBe(false);
    expect(bottomRow.querySelectorAll(".composer-icon-button")).toHaveLength(2); // "+" and mic
    expect(bottomRow.querySelector('[aria-label="Open message actions"]')).not.toBeNull();
    expect(bottomRow.querySelector('[aria-label="Record voice"]')).not.toBeNull();
    expect(bottomRow.querySelectorAll(".composer-bottom-row-trailing .send-button")).toHaveLength(
      1
    );
    // No business/agent in this harness, so the model/library pills stay hidden.
    expect(bottomRow.querySelectorAll(".composer-pill")).toHaveLength(0);
    expect(composer.textContent).toContain("Shopkeeper will answer");
    expect(host.querySelector('[aria-label="Voice input"]')).toBeNull();
    expect(host.querySelector('[aria-label="Attach file"]')).toBeNull();
    // "Send via" is no longer its own top-level icon button - it only lives in the "+" sheet.
    expect(host.querySelector('[aria-label="Choose how to send"]')).toBeNull();

    const more = host.querySelector<HTMLButtonElement>('[aria-label="Open message actions"]')!;
    await act(async () => more.click());
    await act(async () => {
      await import("../apps/web/src/ChatComposerActions");
    });

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-labelledby")).toBe("composer-message-actions-title");
    for (const label of [
      "Send via",
      "Take photo",
      "Photos",
      "Files",
      "Open command",
      "Send as SMS",
      "Share to apps"
    ]) {
      expect(dialog?.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
    }
    // Voice moved out of the action sheet into the always-visible mic button.
    expect(dialog?.querySelector('[aria-label="Record voice"]')).toBeNull();

    const sendVia = dialog!.querySelector<HTMLButtonElement>('[aria-label="Send via"]')!;
    vi.useFakeTimers();
    try {
      await act(async () => {
        sendVia.click();
        await vi.runAllTimersAsync();
      });
    } finally {
      vi.useRealTimers();
    }

    await act(async () => {
      await import("../apps/web/src/ChatChannelPicker");
    });
    const channelDialog = document.body.querySelector(
      '[aria-labelledby="composer-channel-picker-title"]'
    );
    expect(channelDialog).not.toBeNull();
    expect(channelDialog?.querySelector('[role="option"]')?.textContent).toContain(
      "Normal message"
    );
    expect(channelDialog?.textContent).toContain("Bluetooth");

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => root.unmount());
  });
});
