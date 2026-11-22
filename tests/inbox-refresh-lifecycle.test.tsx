// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useInboxRefresh } from "../apps/web/src/hooks/useInboxRefresh";

it("loads signed-in assistant conversations before encryption registration and refreshes when keys arrive", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.createElement("div"));
  const loadMessagingInbox = vi.fn(async () => undefined);
  const retryQueuedMessages = vi.fn(async () => undefined);
  const selectConversation = vi.fn(async () => undefined);
  function Harness({
    accountId,
    encryptionDeviceId
  }: {
    accountId: string | null;
    encryptionDeviceId: string | null;
  }) {
    useInboxRefresh({
      accountId,
      encryptionDeviceId,
      mode: "seller",
      activeConversationId: "receipt-chat",
      loadMessagingInbox,
      retryQueuedMessages,
      selectConversation
    });
    return null;
  }
  try {
    await act(async () => root.render(<Harness accountId={null} encryptionDeviceId={null} />));
    expect(loadMessagingInbox).not.toHaveBeenCalled();
    await act(async () => root.render(<Harness accountId="owner" encryptionDeviceId={null} />));
    expect(loadMessagingInbox).toHaveBeenLastCalledWith("receipt-chat");
    const before = loadMessagingInbox.mock.calls.length;
    await act(async () => root.render(<Harness accountId="owner" encryptionDeviceId="ready" />));
    expect(loadMessagingInbox.mock.calls.length).toBe(before + 1);
    // Messages an earlier page left waiting are resent once after the inbox loads, not on every
    // effect run.
    expect(retryQueuedMessages).toHaveBeenCalledTimes(1);
    // Only what an earlier page left: this page's own sends may be in flight.
    expect(retryQueuedMessages).toHaveBeenLastCalledWith({ leftByEarlierPage: true });
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(retryQueuedMessages.mock.calls.slice(1)).toEqual([
      [{ reconnect: true }],
      [{ automatic: true }]
    ]);
  } finally {
    await act(async () => root.unmount());
  }
});
