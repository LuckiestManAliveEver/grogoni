import { useSyncExternalStore } from "react";
import { countMessagingOutbox, messagingOutboxChangeEvent } from "../messaging/outbox";

function subscribe(onChange: () => void): () => void {
  window.addEventListener(messagingOutboxChangeEvent, onChange);
  // Another tab sending or retrying changes the same stored outbox.
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(messagingOutboxChangeEvent, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** How many of this account's messages in this conversation wait in the outbox to be resent. */
export function useMessagingOutboxCount(
  accountId: string | null,
  conversationId: string | null
): number {
  return useSyncExternalStore(
    subscribe,
    () => (accountId === null ? 0 : countMessagingOutbox(accountId, conversationId)),
    () => 0
  );
}
