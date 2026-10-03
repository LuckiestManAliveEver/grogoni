import type { BuyFeedSummary, BuyResultSummary, UnifiedCheckoutSummary } from "@grogoni/shared-types";

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

  async function handleSearchBuyFeed(query: string) {
    await runAction("buy-search", async () => {
      try {
        const feed = await getJson<BuyFeedSummary>(
          `/buy/search?query=${encodeURIComponent(query)}`
        );
        setBuyFeed(feed);
      } catch (error) {
        setStatusMessage(getErrorMessage(error));
      }
    });
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
    if (buyCart.length === 0) return;
    await runAction("buy-checkout", async () => {
      try {
        const checkout = await postJson<UnifiedCheckoutSummary>("/buy/checkout", {
          items: buyCart.map((item) => ({
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
        });
        setBuyCart([]);
        setChatMessages((messages) => [
          ...messages,
          {
            id: `unified-checkout-${checkout.id}`,
            author: "merchant",
            body: "Checked out",
            unifiedCheckoutId: checkout.id,
            createdAt: new Date().toISOString()
          }
        ]);
      } catch (error) {
        setStatusMessage(getErrorMessage(error));
      }
    });
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
