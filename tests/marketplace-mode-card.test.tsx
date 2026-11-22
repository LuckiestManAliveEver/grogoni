// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PublicStorefrontSummary } from "../apps/web/src/grogoni-application-shared";
import { MarketplaceModeCard } from "../apps/web/src/MarketplaceModeCard";

const otherShop: PublicStorefrontSummary = {
  agentId: "grogoni.amina-fresh",
  grogoniId: "grogoni.amina-fresh",
  commerceAddress: "amina-fresh@grogoni.com",
  businessName: "Amina Fresh",
  presence: { status: "online", updatedAt: new Date(0).toISOString() },
  products: []
};

const noop = () => {};

describe("MarketplaceModeCard", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("shows the public commerce address for both the owner's own shop and the directory listing", () => {
    act(() => {
      root = createRoot(host);
      root.render(
        <MarketplaceModeCard
          businessName="Mama Mboga"
          hasBusiness
          isAuthenticated
          isIntro={false}
          isLoadingStorefronts={false}
          productCount={3}
          publicStorefronts={[otherShop]}
          grogoniId="grogoni.mama-mboga"
          buyFeed={null}
          isSearchingBuyFeed={false}
          buyCart={[]}
          isCheckingOut={false}
          onOpenStore={noop}
          onCompleteIntro={noop}
          onPrompt={noop}
          onRefreshStorefronts={noop}
          onSell={noop}
          onSearchBuyFeed={noop}
          onAddToCart={noop}
          onRemoveFromCart={noop}
          onCheckout={noop}
          onSignUp={noop}
        />
      );
    });

    // "Your shop" line - derived client-side from the raw grogoniId prop.
    expect(host.textContent).toContain("mama-mboga@grogoni.com");
    // Directory listing of another merchant - carried on the resolved PublicStorefrontSummary.
    expect(host.textContent).toContain("amina-fresh@grogoni.com");
    expect(host.textContent).not.toContain("grogoni.mama-mboga");
    expect(host.textContent).not.toContain("grogoni.amina-fresh");
  });

  it("nudges the owner to add a directory listing until the shop has one", () => {
    const ownShop = (listing: Partial<PublicStorefrontSummary>): PublicStorefrontSummary => ({
      ...otherShop,
      agentId: "grogoni.mama-mboga",
      grogoniId: "grogoni.mama-mboga",
      commerceAddress: "mama-mboga@grogoni.com",
      businessName: "Mama Mboga",
      ...listing
    });
    root = createRoot(host);
    const render = (storefronts: PublicStorefrontSummary[]) =>
      act(() => {
        root.render(
          <MarketplaceModeCard
            businessName="Mama Mboga"
            hasBusiness
            isAuthenticated
            isIntro={false}
            isLoadingStorefronts={false}
            productCount={3}
            publicStorefronts={storefronts}
            grogoniId="grogoni.mama-mboga"
            buyFeed={null}
            isSearchingBuyFeed={false}
            buyCart={[]}
            isCheckingOut={false}
            onOpenStore={noop}
            onCompleteIntro={noop}
            onPrompt={noop}
            onRefreshStorefronts={noop}
            onSell={noop}
            onSearchBuyFeed={noop}
            onAddToCart={noop}
            onRemoveFromCart={noop}
            onCheckout={noop}
            onSignUp={noop}
          />
        );
      });
    const nudge = /Buyers can.t find Mama Mboga/u;
    render([otherShop, ownShop({})]);
    expect(host.textContent).toMatch(nudge);
    render([otherShop, ownShop({ category: "fresh_produce" })]);
    expect(host.textContent).not.toMatch(nudge);
    // A filtered list without the owner's shop says nothing either way.
    render([otherShop]);
    expect(host.textContent).not.toMatch(nudge);
    // Shown on each listed card: category label and place.
    render([ownShop({ category: "fresh_produce", place: "Westlands" })]);
    expect(host.textContent).toContain("Fruit and vegetables · Westlands");
  });
});
