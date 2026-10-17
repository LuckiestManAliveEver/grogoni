import { useState } from "react";

import type { MessageDeliveryAttemptSummary } from "@grogoni/shared-types";

import { getJson } from "./api-helpers";
import type { ChatMessage } from "./app-shell";
import { getErrorMessage } from "./chat-message-plumbing";
import { formatMessageTime } from "./formatters";
import { messageDeliveryLabel } from "./message-delivery-label";

export type DeliveryAttempts = ReturnType<typeof useDeliveryAttempts>;

/** The one open "Delivery attempts" panel in a conversation, and the attempts fetched so far. */
export function useDeliveryAttempts(activeConversationId: string | null) {
  const [openMessageId, setOpenMessageId] = useState<string | null>(null);
  const [byMessage, setByMessage] = useState<Record<string, MessageDeliveryAttemptSummary[]>>({});
  const [loadingMessageId, setLoadingMessageId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(messageId: string) {
    if (openMessageId === messageId) {
      setOpenMessageId(null);
      return;
    }
    setOpenMessageId(messageId);
    if (activeConversationId === null || byMessage[messageId] !== undefined) return;
    setLoadingMessageId(messageId);
    setError(null);
    try {
      const response = await getJson<{ attempts: MessageDeliveryAttemptSummary[] }>(
        `/v1/conversations/${encodeURIComponent(activeConversationId)}/messages/${encodeURIComponent(
          messageId
        )}/delivery-attempts`
      );
      setByMessage((current) => ({ ...current, [messageId]: response.attempts }));
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setLoadingMessageId(null);
    }
  }

  return { openMessageId, byMessage, loadingMessageId, error, toggle };
}

/** Time, edit mark, delivery status, and the delivery-attempts panel under one message. */
export function MessageDeliveryMeta({
  message,
  attempts
}: {
  message: ChatMessage;
  attempts: DeliveryAttempts;
}) {
  const label =
    message.author === "merchant" && message.status
      ? messageDeliveryLabel(message.status, message.outboxState)
      : null;
  const recorded = attempts.byMessage[message.id];
  return (
    <>
      <div className="message-meta">
        {message.createdAt ? (
          <time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time>
        ) : null}
        {message.editedAt ? <span>edited</span> : null}
        {label !== null ? (
          // No role="status" here: the message list is already a polite live region.
          <span className={label.failed ? "message-status-failed" : undefined}>{label.text}</span>
        ) : null}
        {message.author === "merchant" &&
        message.deviceOnlyIn === undefined &&
        !message.id.startsWith("welcome") ? (
          <button type="button" onClick={() => void attempts.toggle(message.id)}>
            {attempts.openMessageId === message.id ? "Hide delivery attempts" : "Delivery attempts"}
          </button>
        ) : null}
      </div>
      {attempts.openMessageId === message.id ? (
        <div className="message-context" aria-label="Delivery attempts">
          {attempts.loadingMessageId === message.id ? (
            <small>Loading delivery attempts…</small>
          ) : attempts.error !== null && recorded === undefined ? (
            <small>{attempts.error}</small>
          ) : (recorded ?? []).length === 0 ? (
            <small>No delivery attempts recorded for this message.</small>
          ) : (
            (recorded ?? []).map((attempt) => (
              <small key={attempt.id}>
                #{attempt.attemptNumber} · {attempt.channel} via {attempt.provider} ·{" "}
                {attempt.result.replace(/_/gu, " ")}
                {attempt.normalizedFailureCode ? ` (${attempt.normalizedFailureCode})` : ""} ·{" "}
                {formatMessageTime(attempt.requestedAt)}
              </small>
            ))
          )}
        </div>
      ) : null}
    </>
  );
}

/** Resends the outbox. Hidden when nothing is waiting, so it never offers a no-op. */
export function WaitingMessagesButton({ count, onSend }: { count: number; onSend: () => void }) {
  if (count === 0) return null;
  return (
    <button className="secondary" type="button" onClick={onSend}>
      {count === 1 ? "Send 1 waiting message" : `Send ${count} waiting messages`}
    </button>
  );
}
