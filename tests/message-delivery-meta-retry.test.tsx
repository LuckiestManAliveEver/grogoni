// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../apps/web/src/app-shell";
import { MessageDeliveryMeta } from "../apps/web/src/MessageDeliveryMeta";

/** The per-message Retry control: shown only on the sender's own failed message, and wired to
 * resend by that message's clientMessageId (the outbox key the server deduplicates on). */
describe("per-message retry", () => {
  const attempts = {
    openMessageId: null,
    byMessage: {},
    loadingMessageId: null,
    error: null,
    toggle: vi.fn(async () => undefined)
  } as never;

  function render(message: Partial<ChatMessage>, onRetry?: () => void) {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() =>
      root.render(
        <MessageDeliveryMeta
          message={{ id: "client-1", author: "merchant", body: "hi", ...message } as ChatMessage}
          attempts={attempts}
          {...(onRetry ? { onRetry } : {})}
        />
      )
    );
    const retry = () =>
      Array.from(host.querySelectorAll("button")).find(
        (button) => button.textContent === "Retry message"
      );
    return { retry, unmount: () => act(() => root.unmount()) };
  }

  it("shows Retry only on the sender's failed message and calls back once per tap", () => {
    const onRetry = vi.fn();
    const failed = render({ status: "failed" }, onRetry);
    act(() => failed.retry()!.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    failed.unmount();

    for (const message of [
      { status: "sent" as const },
      { status: "queued" as const },
      { status: "failed" as const, author: "agent" as const }
    ]) {
      const view = render(message, onRetry);
      expect(view.retry()).toBeUndefined();
      view.unmount();
    }
  });

  it("is wired to the outbox by the message's clientMessageId", () => {
    const surface = readFileSync("apps/web/src/ChatSurface.tsx", "utf8");
    expect(surface).toContain(
      "onRetry={() => onRetryMessages(message.clientMessageId ?? message.id)}"
    );
    const application = readFileSync("apps/web/src/GrogoniApplication.tsx", "utf8");
    expect(application).toContain(
      "retryQueuedMessages({ ...(clientMessageId ? { clientMessageId } : {}) })"
    );
  });
});
