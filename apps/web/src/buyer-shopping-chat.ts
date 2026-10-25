import { parseMarketplaceBuyIntent } from "./chat-assistant-intents";
import type { Dispatch, SetStateAction } from "react";
import type { BuyerShoppingTurnResult } from "@grogoni/shared-types";
import type { ChatMessage } from "./app-shell";
import { postJson } from "./api-helpers";

export async function submitBuyerShoppingChat(input: {
  accountId: string;
  scope: string;
  message: string;
  conversationId: string | null;
  rememberedSessionIds: Map<string, string>;
  reply: (body: string) => Promise<void>;
  setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setStatusMessage: (message: string) => void;
}): Promise<void> {
  const {
    accountId,
    scope,
    message,
    conversationId,
    rememberedSessionIds,
    reply,
    setChatMessages,
    setStatusMessage
  } = input;
  const storageKey = `grogoni:buyer-shopping:${accountId}:${scope}`;
  let shoppingSessionId: string;
  try {
    shoppingSessionId = localStorage.getItem(storageKey) ?? crypto.randomUUID();
    localStorage.setItem(storageKey, shoppingSessionId);
  } catch {
    shoppingSessionId = rememberedSessionIds.get(storageKey) ?? crypto.randomUUID();
  }
  rememberedSessionIds.set(storageKey, shoppingSessionId);
  setStatusMessage("Looking up your shopping request…");
  const result = await postJson<BuyerShoppingTurnResult>(
    "/buy/assistant",
    {
      shoppingSessionId,
      requestId: crypto.randomUUID(),
      message
    },
    { timeoutMs: 60000 }
  );
  await reply(result.reply);
  if (result.checkoutId) {
    const checkoutMessage: ChatMessage = {
      id: `unified-checkout-${result.checkoutId}`,
      author: "grogoniclaw",
      body: "Your unified checkout summary",
      content: { type: "unified-checkout", unifiedCheckoutId: result.checkoutId },
      createdAt: new Date().toISOString(),
      status: "delivered"
    };
    if (conversationId)
      await postJson("/v1/messages", {
        conversationId: conversationId,
        clientMessageId: checkoutMessage.id,
        author: "agent",
        content: checkoutMessage.content,
        clientTimestamp: checkoutMessage.createdAt
      });
    setChatMessages((messages) => [...messages, checkoutMessage]);
  }
  setStatusMessage(
    result.pendingCheckout ? "Review the checkout in this chat." : "Shopping assistant replied."
  );
}

export function isBuyerShoppingRequest(message: string, hasSession: boolean): boolean {
  return (
    parseMarketplaceBuyIntent(message) !== null ||
    hasSession ||
    /^(confirm checkout|cancel checkout)$/iu.test(message.trim())
  );
}
