import { useRef } from "react";
import type {
  BuyFeedSummary,
  BuyResultSummary,
  UnifiedCheckoutSummary
} from "@grogoni/shared-types";

import { getJson, postJson } from "../api-helpers";
import type { ChatMessage } from "../app-shell";
import { getErrorMessage } from "../chat-message-plumbing";
import type { BuyCartItem } from "../grogoni-application-shared";

interface UseBuyCartStateDeps {
  runAction: <T>(key: string, action: () => Promise<T>) => Promise<T | undefined>;
  setStatusMessage: (message: string) => void;
  buyCart: BuyCartItem[];
  setBuyCart: (items: BuyCartItem[] | ((current: BuyCartItem[]) => BuyCartItem[])) => void;
  setBuyFeed: (feed: BuyFeedSummary | null) => void;
  setChatMessages: (messages: ChatMessage[] | ((current: ChatMessage[]) => ChatMessage[])) => void;
}

export function useBuyCartState(deps: UseBuyCartStateDeps) {
  const { runAction, setStatusMessage, buyCart, setBuyCart, setBuyFeed, setChatMessages } = deps;

  const checkoutInFlight = useRef(false);
  const checkoutAttempt = useRef<{ fingerprint: string; key: string } | null>(null);

  /** Runs the search and returns the feed, or null when the search failed. */
  async function handleSearchBuyFeed(query: string): Promise<BuyFeedSummary | null> {
    const search = async (): Promise<BuyFeedSummary | null> => {
      try {
        const result = await getJson<BuyFeedSummary>(
          `/buy/search?query=${encodeURIComponent(query)}`
        );
        setBuyFeed(result);
        return result;
      } catch (error) {
        setStatusMessage(getErrorMessage(error));
        return null;
      }
    };
    const feed = await runAction("buy-search", search);
    // undefined: another search (the marketplace sheet's) is running. That is not a failure, so
    // this one runs on its own rather than telling the buyer to check their connection.
    return feed === undefined ? search() : feed;
  }

  function handleAddToCart(result: BuyResultSummary) {
    setBuyCart((items) => [
      ...items,
      {
        cartItemId: `${result.id}-${Date.now()}`,
        sourceKind: result.sourceKind,
        sourceId: result.sourceId,
        sourceLabel: result.sourceLabel,
        title: result.title,
        price: result.price,
        quantity: 1,
        agentId: result.agentId,
        productId: result.productId,
        statusBroadcastId: result.statusBroadcastId,
        productCaptureItemId: result.productCaptureItemId
      }
    ]);
  }

  function handleRemoveFromCart(cartItemId: string) {
    setBuyCart((items) => items.filter((item) => item.cartItemId !== cartItemId));
  }

  async function handleCheckout() {
    if (buyCart.length === 0 || checkoutInFlight.current) return;
    const submittedCart = [...buyCart];
    const fingerprint = JSON.stringify(submittedCart);
    if (checkoutAttempt.current?.fingerprint !== fingerprint) {
      checkoutAttempt.current = { fingerprint, key: crypto.randomUUID() };
    }
    const idempotencyKey = checkoutAttempt.current.key;
    checkoutInFlight.current = true;
    try {
      await runAction("buy-checkout", async () => {
        try {
          const checkout = await postJson<UnifiedCheckoutSummary>(
            "/buy/checkout",
            {
              items: submittedCart.map((item) => ({
                sourceKind: item.sourceKind,
                sourceId: item.sourceId,
                sourceLabel: item.sourceLabel,
                title: item.title,
                quantity: item.quantity,
                agentId: item.agentId,
                productId: item.productId,
                statusBroadcastId: item.statusBroadcastId,
                productCaptureItemId: item.productCaptureItemId
              }))
            },
            { idempotencyKey }
          );
          const submittedIds = new Set(submittedCart.map((item) => item.cartItemId));
          setBuyCart((current) =>
            current.filter(
              (item) =>
                !submittedIds.has(item.cartItemId) ||
                checkout.failures.some((failure) =>
                  failure.checkoutItemIndex !== undefined
                    ? submittedCart[failure.checkoutItemIndex]?.cartItemId === item.cartItemId
                    : failure.sourceLabel === item.sourceLabel && failure.title === item.title
                )
            )
          );
          checkoutAttempt.current = null;
          setStatusMessage(
            checkout.failures.length > 0
              ? "Some items could not be ordered. Review the receipt; those items remain in your cart."
              : "Orders requested. Your unified receipt is in this chat."
          );
          setChatMessages((messages) => [
            ...messages,
            {
              id: `unified-checkout-${checkout.id}`,
              author: "merchant",
              body: "Orders requested",
              content: { type: "unified-checkout", unifiedCheckoutId: checkout.id },
              createdAt: new Date().toISOString()
            }
          ]);
        } catch (error) {
          setStatusMessage(getErrorMessage(error));
        }
      });
    } finally {
      checkoutInFlight.current = false;
    }
  }

  function handleStatusBroadcastPosted(statusBroadcastId: string) {
    setChatMessages((messages) => [
      ...messages,
      {
        id: `status-broadcast-${statusBroadcastId}`,
        author: "merchant",
        body: "Posted a status",
        statusBroadcastId,
        createdAt: new Date().toISOString()
      }
    ]);
  }

  return {
    handleSearchBuyFeed,
    handleAddToCart,
    handleRemoveFromCart,
    handleCheckout,
    handleStatusBroadcastPosted
  };
}
