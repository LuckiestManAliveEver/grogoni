import type { BuyFeedSummary } from "@grogoni/shared-types";
import { createClientMessageId } from "./chat-message-plumbing";
import type { ChatMessage } from "./app-shell";
import { deviceOnlyAnchor, saveDeviceOnlyMessages } from "./chat-device-only-messages";
import { classifyGuestMessage } from "./guest-intent-client";
import { beginGuestReply } from "./guest-reply-pending";
import { describeMarketplaceSearch } from "./marketplace-search-reply";

/**
 * A guest's message (someone without a shop, outside a conversation with a person). The guest's
 * own bubble appears at once; the thread shows a typing indicator while the classifier decides
 * (up to its 5s budget) and the search runs; then only the reply is appended. Both messages are
 * device-only, anchored after the same server message, so a refresh or a trip to another thread
 * keeps them in order. If another thread is open when a message is ready, it waits in storage for
 * its own thread instead of flashing into the open one.
 */
export async function sendGuestMessage(input: {
  message: string;
  accountId: string;
  mode: string;
  activeConversationId: string | null;
  chatMessages: ChatMessage[];
  setChatMessages: (update: (messages: ChatMessage[]) => ChatMessage[]) => void;
  /** Whether `activeConversationId` is still the open thread. */
  isOpen: () => boolean;
  searchBuyFeed: (query: string) => Promise<BuyFeedSummary | null | undefined>;
  /** The composer, attachments and reply target are cleared once the bubble is shown. */
  afterBubble: () => void;
  navigateToMarketplace: () => void;
  setStatusMessage: (status: string) => void;
}): Promise<void> {
  // Leaving buy mode navigates to the marketplace root, outside any thread.
  const thread = input.mode === "marketplace" ? input.activeConversationId : null;
  const deviceOnlyAfter = deviceOnlyAnchor(input.chatMessages);
  const place = (message: Omit<ChatMessage, "deviceOnlyIn" | "deviceOnlyAfter">) => {
    const placed: ChatMessage = { ...message, deviceOnlyIn: thread, deviceOnlyAfter };
    saveDeviceOnlyMessages(input.accountId, [placed]);
    if (input.isOpen()) input.setChatMessages((messages) => [...messages, placed]);
  };
  place({
    id: createClientMessageId("buyer"),
    author: "merchant",
    body: input.message,
    createdAt: new Date().toISOString()
  });
  input.afterBubble();
  const endTyping = beginGuestReply(input.activeConversationId);
  let answer: { reply: string; status: string };
  try {
    const { route } = await classifyGuestMessage(input.message);
    answer =
      route.kind === "reply"
        ? { reply: route.reply, status: route.status }
        : describeMarketplaceSearch(
            route.query,
            // A failed search is answered as one ("couldn't search"), never left without a reply.
            await input.searchBuyFeed(route.query).catch(() => null)
          );
  } finally {
    endTyping();
  }
  place({
    id: createClientMessageId("agent"),
    author: "grogoniclaw",
    body: answer.reply,
    createdAt: new Date().toISOString()
  });
  // Already buying: stay in this thread.
  if (input.mode !== "marketplace") input.navigateToMarketplace();
  input.setStatusMessage(answer.status);
}
