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
    // The page's first refresh resends only what an earlier page left (this page's own sends may
    // be in flight); every later refresh runs the automatic pass. Never the first pass twice.
    expect(retryQueuedMessages.mock.calls).toEqual([
      [{ leftByEarlierPage: true }],
      [{ automatic: true }]
    ]);
  } finally {
    await act(async () => root.unmount());
  }
});

it("runs the outbox's automatic pass on refresh and after outbox changes, and a reconnect pass when back online", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  const root = createRoot(document.createElement("div"));
  const loadMessagingInbox = vi.fn(async () => undefined);
  const retryQueuedMessages = vi.fn(async () => undefined);
  function Harness() {
    useInboxRefresh({
      accountId: "owner",
      encryptionDeviceId: null,
      mode: "seller",
      activeConversationId: "chat",
      loadMessagingInbox,
      retryQueuedMessages,
      selectConversation: vi.fn(async () => undefined)
    });
    return null;
  }
  try {
    await act(async () => root.render(<Harness />));
    // The first refresh of a page load resends what an earlier page left (no wait, capped);
    // later refreshes run the automatic pass (backoff-respecting, capped).
    expect(retryQueuedMessages.mock.calls).toEqual([[{ leftByEarlierPage: true }]]);

    retryQueuedMessages.mockClear();
    await act(async () => {
      window.dispatchEvent(new Event("grogoni:messaging-outbox-change"));
      window.dispatchEvent(new Event("grogoni:messaging-outbox-change"));
      await vi.advanceTimersByTimeAsync(1_300);
    });
    // Debounced: two writes, one pass.
    expect(retryQueuedMessages.mock.calls).toEqual([[{ automatic: true }]]);

    retryQueuedMessages.mockClear();
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(retryQueuedMessages).toHaveBeenCalledWith({ reconnect: true });
    // Only a tap may pass the three-try cap.
    expect(retryQueuedMessages).not.toHaveBeenCalledWith();
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});

it("tries the page-load resend again when it could not run (another pass or another tab's)", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.createElement("div"));
  // The first attempt finds the resend lock taken; the next one runs.
  const retryQueuedMessages = vi
    .fn<(options?: object) => Promise<boolean>>()
    .mockResolvedValueOnce(false)
    .mockResolvedValue(true);
  function Harness({ encryptionDeviceId }: { encryptionDeviceId: string }) {
    useInboxRefresh({
      accountId: "owner",
      encryptionDeviceId,
      mode: "seller",
      activeConversationId: "chat",
      loadMessagingInbox: vi.fn(async () => undefined),
      retryQueuedMessages,
      selectConversation: vi.fn(async () => undefined)
    });
    return null;
  }
  try {
    for (const key of ["k1", "k2", "k3"])
      await act(async () => root.render(<Harness encryptionDeviceId={key} />));
    expect(retryQueuedMessages.mock.calls).toEqual([
      [{ leftByEarlierPage: true }],
      [{ leftByEarlierPage: true }],
      [{ automatic: true }]
    ]);
  } finally {
    await act(async () => root.unmount());
  }
});
