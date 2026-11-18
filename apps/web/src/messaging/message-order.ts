import type { ConversationMessageSummary } from "@grogoni/shared-types";

/** Retained pre-journal messages precede sequenced records; each group has a total order. */
export function compareConversationMessages(
  left: ConversationMessageSummary,
  right: ConversationMessageSummary
): number {
  return (
    (left.serverSequence ?? -Infinity) - (right.serverSequence ?? -Infinity) ||
    (left.clientTimestamp ?? left.createdAt).localeCompare(
      right.clientTimestamp ?? right.createdAt
    ) ||
    (left.clientMessageId ?? left.id).localeCompare(right.clientMessageId ?? right.id)
  );
}
