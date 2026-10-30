import type { BuyFeedSummary } from "@grogoni/shared-types";
import { createClientMessageId } from "./chat-message-plumbing";
import type { ChatMessage } from "./app-shell";
import { deviceOnlyAnchor, saveDeviceOnlyMessages } from "./chat-device-only-messages";
import { classifyGuestMessage } from "./guest-intent-client";
import { beginGuestReply } from "./guest-reply-pending";
import { describeMarketplaceSearch } from "./marketplace-search-reply";

/**
 * A guest's message (someone without a shop, outside a conversation with a person). The guest's
 * own bubble appears at once; the thread shows a typing indicator while the answer is worked out;
 * then only the reply is appended. Both messages are device-only, anchored after the same server
 * message, so a refresh or a trip to another thread keeps them in order. If another thread is
 * open when a message is ready, it waits in storage for its own thread instead of flashing into
 * the open one.
 *
 * How it is answered: a product search runs against the catalogue (the one thing a marketplace
 * chat answers itself). Everything else - a greeting, thanks, a request for help, an order
 * question, an explanation, a follow-up - is the conversational model's, asked through `askModel`.
 * A guest's chat is a conversation with the model, not a form of fixed replies; the only limit is
 * that a model outage is reported explicitly.
 */
export async function sendGuestMessage(input: {
  message: string;
  accountId: string;
  mode: string;
  /** Told when the conversational model has been asked and will answer in the thread. */
  onModelAsked?: (note: string) => void;
  activeConversationId: string | null;
  chatMessages: ChatMessage[];
  setChatMessages: (update: (messages: ChatMessage[]) => ChatMessage[]) => void;
  /** Whether `activeConversationId` is still the open thread. */
  isOpen: () => boolean;
  searchBuyFeed: (query: string) => Promise<BuyFeedSummary | null | undefined>;
  /**
   * Asks the conversational model about this message. Its words, or a note when the answer will
   * arrive in the thread later (a queued model turn), or null when it cannot be asked at all - the
   * guest then sees an availability notice.
   */
  askModel: (
    message: string,
    clientMessageId: string
  ) => Promise<{ text: string } | { note: string } | null>;
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
  const clientMessageId = createClientMessageId("buyer");
  place({
    id: clientMessageId,
    author: "merchant",
    body: input.message,
    createdAt: new Date().toISOString()
  });
  input.afterBubble();
  const endTyping = beginGuestReply(input.activeConversationId);
  let answer: { reply: string; status: string };
  try {
    const classified = await classifyGuestMessage(input.message);
    if (classified.route.kind === "search") {
      // A marketplace chat answers a product lookup itself - that is the one thing it does without
      // the model. The classifier's query is used when a model decided it (it was validated
      // against the message). A rules answer may only search the bare product name it is sure of:
      // a sentence that merely mentions a product ("Explain why a rainbow forms") is an
      // explanation, and an explanation is the model's to give.
      const searchable =
        classified.source !== "rules" || isBareProductName(classified.route.query)
          ? classified.route.query
          : null;
      if (searchable !== null) {
        answer = describeMarketplaceSearch(
          searchable,
          await input.searchBuyFeed(searchable).catch(() => null)
        );
      } else {
        const modelAnswer = await askConversationalModel(input, clientMessageId);
        endTyping();
        if ("note" in modelAnswer) {
          input.onModelAsked?.(modelAnswer.note);
          input.setStatusMessage(modelAnswer.note);
          return;
        }
        answer = modelAnswer;
      }
    } else {
      const modelAnswer = await askConversationalModel(input, clientMessageId);
      if ("note" in modelAnswer) {
        // The model's answer arrives in the thread through the daemon result poll.
        endTyping();
        input.onModelAsked?.(modelAnswer.note);
        input.setStatusMessage(modelAnswer.note);
        return;
      }
      answer = modelAnswer;
    }
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

/**
 * Whether a search query is just a product's name ("sugar", "2kg maize flour", "cooking oil 5
 * litre"), short and with no question or sentence around it. Only such a query is searched on the
 * rules' word alone; anything longer could be a sentence that merely mentions a product.
 */
function isBareProductName(query: string): boolean {
  const text = query.trim().replace(/[.!?]+$/u, "");
  return (
    text.length > 0 &&
    !/[?!]/u.test(text) &&
    text.split(/\s+/u).length <= 5 &&
    !/^(?:i|we|you|he|she|it|they|why|how|what|when|where|who|which|explain|does|do|can|could|is|are|was|were|will|would|should|tell|give|show|help)\b/iu.test(
      text
    )
  );
}

/**
 * Keep model failures explicit instead of substituting a scripted conversational answer.
 */
async function askConversationalModel(
  input: Parameters<typeof sendGuestMessage>[0],
  clientMessageId: string
): Promise<{ note: string } | { reply: string; status: string }> {
  let asked: Awaited<ReturnType<typeof input.askModel>> = null;
  try {
    asked = await input.askModel(input.message, clientMessageId);
  } catch {
    asked = null;
  }
  if (asked !== null && "note" in asked) return asked;
  const text = asked !== null && "text" in asked ? asked.text.trim() : "";
  return text.length > 0
    ? { reply: text, status: "Assistant replied." }
    : {
        reply: "I couldn't reach the assistant. Please try again.",
        status: "Assistant unavailable. Please try again."
      };
}
