import type { ConversationMessageDeliveryStatus } from "@grogoni/shared-types";

import type { ChatMessage } from "./app-shell";

/** What the sender sees under their own message. A failure says whether it is being retried. */
export function messageDeliveryLabel(
  status: ConversationMessageDeliveryStatus,
  outboxState?: ChatMessage["outboxState"]
): { text: string; failed: boolean } {
  switch (status) {
    case "failed":
      // Says whether anything will send it: the outbox's automatic resends, the resend control
      // in the thread header once those are used up, or nothing (refused; the status says why).
      return {
        text:
          outboxState === "retrying"
            ? "Not sent yet · retrying"
            : outboxState === "stopped"
              ? "Not sent · tap Send waiting at the top to retry"
              : "Not sent",
        failed: true
      };
    case "draft":
      return { text: "Draft", failed: false };
    case "queued":
      // In the outbox behind an earlier message of the same conversation.
      if (outboxState !== undefined) return { text: "Waiting to send", failed: false };
      return { text: "Sending…", failed: false };
    case "pending":
    case "sending":
      return { text: "Sending…", failed: false };
    case "retrying":
      return { text: "Retrying…", failed: false };
    case "sent":
      return { text: "Sent", failed: false };
    case "delivered":
      return { text: "Delivered", failed: false };
    case "read":
      return { text: "Read", failed: false };
  }
}
