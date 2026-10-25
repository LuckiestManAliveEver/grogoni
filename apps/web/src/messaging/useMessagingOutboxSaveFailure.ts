import { useEffect, useRef } from "react";
import {
  messagingOutboxSaveFailedEvent,
  messagingOutboxSaveFailureMessage,
  type MessagingOutboxSaveFailure
} from "./outbox";

/**
 * Tells the user when a waiting message could not be saved on this device (storage full or
 * blocked). The outbox keeps it in this tab and keeps trying (messaging/outbox.ts); before the
 * outbox lock, the same failure reached the send handler as a thrown error.
 */
export function useMessagingOutboxSaveFailure(
  accountId: string | null,
  setStatusMessage: (message: string) => void
): void {
  const notify = useRef(setStatusMessage);
  notify.current = setStatusMessage;
  useEffect(() => {
    if (accountId === null) return;
    const onFailure = (event: Event) => {
      const detail = (event as CustomEvent<MessagingOutboxSaveFailure>).detail;
      if (detail?.accountId === accountId) notify.current(messagingOutboxSaveFailureMessage);
    };
    window.addEventListener(messagingOutboxSaveFailedEvent, onFailure);
    return () => window.removeEventListener(messagingOutboxSaveFailedEvent, onFailure);
  }, [accountId]);
}
