import { Suspense, useState } from "react";

import {
  commerceAddressFromGrogoniId,
  type BuyFeedSummary,
  type BuyResultSummary
} from "@grogoni/shared-types";

import { routes } from "./routes";
import { StatusResultCard } from "./StatusResultCard";

import {
  type BuyCartItem,
  type PublicStorefrontSummary,
  UnifiedCartSummary
} from "./grogoni-application-shared";

export interface MarketplaceModeCardProps {
  businessName: string;
  hasBusiness: boolean;
  isAuthenticated: boolean;
  isIntro: boolean;
  isLoadingStorefronts: boolean;
  productCount: number;
  publicStorefronts: PublicStorefrontSummary[];
  grogoniId: string;
  buyFeed: BuyFeedSummary | null;
  isSearchingBuyFeed: boolean;
  buyCart: BuyCartItem[];
  isCheckingOut: boolean;
  onOpenStore: () => void;
  onCompleteIntro: () => void;
  onPrompt: (prompt: string) => void;
  onRefreshStorefronts: () => void;
  onSell: () => void;
  onSearchBuyFeed: (query: string) => void;
  onAddToCart: (result: BuyResultSummary) => void;
  onRemoveFromCart: (cartItemId: string) => void;
  onCheckout: () => void;
  onSignUp: () => void;
}

export function MarketplaceModeCard({
  businessName,
  hasBusiness,
  isAuthenticated,
  isIntro,
  isLoadingStorefronts,
  productCount,
  publicStorefronts,
  grogoniId,
  buyFeed,
  isSearchingBuyFeed,
  buyCart,
  isCheckingOut,
  onOpenStore,
  onCompleteIntro,
  onPrompt,
  onRefreshStorefronts,
  onSell,
  onSearchBuyFeed,
  onAddToCart,
  onRemoveFromCart,
  onCheckout,
  onSignUp
}: MarketplaceModeCardProps) {
  const [buyQueryDraft, setBuyQueryDraft] = useState("");
  return (
    <section className="generated-card-message mode-card" aria-label="Explore the marketplace">
      <div className="mode-card-heading">
        <span className="mode-badge">Buy</span>
        <h2>{isIntro ? "Buy on Grogoni" : "What are you looking for?"}</h2>
        <p>
          {isIntro
            ? "Find nearby shops, compare offers, and message sellers from this conversation."
            : "Ask naturally, or start with one of these suggestions."}
        </p>
      </div>
      {isIntro ? (
        <button type="button" onClick={onCompleteIntro}>
          Start exploring
        </button>
      ) : null}
      {!isAuthenticated ? (
        <div className="guest-browsing-note">
          <strong>Browsing as a guest</strong>
          <span>Open shops and explore their public catalogues without creating an account.</span>
          <button type="button" className="secondary" onClick={onSignUp}>
            Sign up to message sellers and check out
          </button>
        </div>
      ) : (
        <div className="marketplace-prompts" aria-label="Marketplace suggestions">
          <button type="button" onClick={() => onPrompt("Show me shops near me")}>
            Shops near me
          </button>
          <button type="button" onClick={() => onPrompt("Show me today's offers")}>
            Today&apos;s offers
          </button>
          <button type="button" onClick={() => onPrompt("Find affordable essentials")}>
            Affordable essentials
          </button>
        </div>
      )}
      <form
        className="buy-search-form"
        aria-label="Search to buy"
        onSubmit={(event) => {
          event.preventDefault();
          onSearchBuyFeed(buyQueryDraft);
        }}
      >
        <input
          type="search"
          placeholder="What are you looking for?"
          value={buyQueryDraft}
          onChange={(event) => setBuyQueryDraft(event.target.value)}
        />
        <button type="submit" disabled={isSearchingBuyFeed}>
          {isSearchingBuyFeed ? "Searching…" : "Search"}
        </button>
      </form>
      {buyFeed !== null ? (
        <div className="buy-feed" aria-label="Search results">
          {buyFeed.results.length === 0 ? (
            <p className="marketplace-directory-status">
              No results for &quot;{buyFeed.query}&quot;.
            </p>
          ) : (
            buyFeed.results.map((result) => (
              <StatusResultCard
                key={result.id}
                result={result}
                isAuthenticated={isAuthenticated}
                onAddToCart={onAddToCart}
                onSignUp={onSignUp}
              />
            ))
          )}
          {buyFeed.marketplaceConnectorAvailable ? null : (
            <p className="shell-note">
              External marketplace results aren&apos;t connected yet - showing your contacts and
              catalogue only.
            </p>
          )}
        </div>
      ) : null}
      {buyCart.length > 0 ? (
        <Suspense fallback={<div className="inline-loading-card">Opening cart…</div>}>
          <UnifiedCartSummary
            items={buyCart}
            isCheckingOut={isCheckingOut}
            onRemove={onRemoveFromCart}
            onCheckout={onCheckout}
          />
        </Suspense>
      ) : null}
      <div className="marketplace-directory-heading">
        <div>
          <span>Public marketplace</span>
          <h3>Explore shops</h3>
        </div>
        <button className="secondary" type="button" onClick={onRefreshStorefronts}>
          Refresh
        </button>
      </div>
      {isLoadingStorefronts ? (
        <p className="marketplace-directory-status" role="status">
          Loading public shops…
        </p>
      ) : publicStorefronts.length === 0 ? (
        <p className="marketplace-directory-status">No public shops are available yet.</p>
      ) : (
        <div className="marketplace-directory" aria-label="Public shops">
          {publicStorefronts.map((storefront) => (
            <a
              className="public-shop-card"
              href={routes.publicAgent(storefront.agentId)}
              key={storefront.agentId}
            >
              <span className={`presence-label ${storefront.presence.status}`}>
                {storefront.presence.status}
              </span>
              <strong>{storefront.businessName}</strong>
              <small>{storefront.commerceAddress}</small>
              <p>
                {storefront.products.length === 0
                  ? "No public catalogue items"
                  : storefront.products
                      .slice(0, 3)
                      .map((product) => product.name)
                      .join(" · ")}
              </p>
              <span>Open shop →</span>
            </a>
          ))}
        </div>
      )}
      {hasBusiness ? (
        <article className="shop-discovery-card">
          <button className="shop-discovery-identity" type="button" onClick={onOpenStore}>
            <span>Your shop</span>
            <h3>{businessName}</h3>
            <p>
              {commerceAddressFromGrogoniId(grogoniId)} · {productCount} catalogue{" "}
              {productCount === 1 ? "item" : "items"}
            </p>
          </button>
          <div className="compact-actions">
            <button type="button" onClick={onOpenStore}>
              Open store
            </button>
            <button className="secondary" type="button" onClick={onSell}>
              Manage
            </button>
          </div>
        </article>
      ) : (
        <article className="shop-discovery-card">
          <div>
            <span>Want to sell?</span>
            <h3>Set up your business</h3>
            <p>
              {isAuthenticated
                ? "Create your shop when you are ready."
                : "Keep browsing freely. Create an account only when you are ready to sell."}
            </p>
          </div>
          <div className="compact-actions">
            <button type="button" onClick={onSell}>
              Set up business
            </button>
          </div>
        </article>
      )}
    </section>
  );
}
