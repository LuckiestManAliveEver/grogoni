// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { MessageDeliveryMeta } from "../apps/web/src/MessageDeliveryMeta";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const attempts = {
  openMessageId: null,
  byMessage: {},
  loadingMessageId: null,
  error: null,
  toggle: () => {}
};

async function render(message: Record<string, unknown>, onRetry?: () => void) {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <MessageDeliveryMeta
        message={
          { id: "m1", body: "Hello", createdAt: "2026-11-20T08:00:00.000Z", ...message } as never
        }
        attempts={attempts as never}
        {...(onRetry ? { onRetry } : {})}
      />
    )
  );
  return host;
}

describe("per-message retry", () => {
  it("offers Retry message on the user's own failed message", async () => {
    const onRetry = vi.fn();
    const host = await render({ author: "merchant", status: "failed" }, onRetry);
    const button = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Retry message"
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("offers nothing on sent messages or on replies", async () => {
    for (const message of [
      { author: "merchant", status: "sent" },
      { author: "merchant", status: "delivered" },
      { author: "grogoniclaw", status: "failed" }
    ]) {
      const host = await render(message, vi.fn());
      expect(
        [...host.querySelectorAll("button")].some((b) => b.textContent === "Retry message")
      ).toBe(false);
    }
  });
});
