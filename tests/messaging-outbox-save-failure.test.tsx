// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  messagingOutboxSaveFailedEvent,
  messagingOutboxSaveFailureMessage
} from "../apps/web/src/messaging/outbox";
import { useMessagingOutboxSaveFailure } from "../apps/web/src/messaging/useMessagingOutboxSaveFailure";

/**
 * A waiting message whose outbox write failed (storage full) used to throw into the send handler.
 * The write now runs under a cross-tab lock after the caller returns, so the outbox announces the
 * failure and the chat shows it.
 */
describe("outbox save failure in the chat", () => {
  let root: Root | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
  });

  it("shows the failure for this account only", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const setStatusMessage = vi.fn();
    function Harness() {
      useMessagingOutboxSaveFailure("account-a", setStatusMessage);
      return null;
    }
    root = createRoot(document.createElement("div"));
    act(() => root!.render(<Harness />));
    const fail = (accountId: string) =>
      window.dispatchEvent(
        new CustomEvent(messagingOutboxSaveFailedEvent, {
          detail: { accountId, message: "Storage is full." }
        })
      );
    fail("account-b");
    expect(setStatusMessage).not.toHaveBeenCalled();
    fail("account-a");
    expect(setStatusMessage).toHaveBeenCalledWith(messagingOutboxSaveFailureMessage);
  });
});
