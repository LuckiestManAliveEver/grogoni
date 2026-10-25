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
  } finally {
    await act(async () => root.unmount());
  }
});
