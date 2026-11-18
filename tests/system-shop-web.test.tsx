// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ProductSummary,
  ShareableCatalogueProductSummary,
  ShareableCatalogueSummary
} from "@grogoni/shared-types";
import type { PublicStorefrontSummary } from "../apps/web/src/grogoni-application-shared";

const getJson = vi.fn();
const postJson = vi.fn();
vi.mock("../apps/web/src/api-helpers", () => ({
  getJson: (...args: unknown[]) => getJson(...args),
  postJson: (...args: unknown[]) => postJson(...args)
}));

const { default: CatalogueBrowsePanel } = await import("../apps/web/src/CatalogueBrowsePanel");
const { MarketplaceModeCard } = await import("../apps/web/src/MarketplaceModeCard");

const jane: ShareableCatalogueSummary = {
  businessId: "jane",
  grogoniId: "grogoni.janes-shop",
  businessName: "Jane's Shop",
  productCount: 120,
  updatedAt: new Date(0).toISOString(),
  pinned: true,
  operatedBy: "marketplace_agent"
};
const janeProducts: ShareableCatalogueProductSummary[] = Array.from({ length: 120 }, (_, i) => ({
  id: `p-${i}`,
  name: `Product ${i}`,
  unit: "unit",
  sellingPrice: null,
  image: null
}));

async function flush() {
  for (let i = 0; i < 6; i += 1)
    await act(async () => {
      await Promise.resolve();
    });
}

function buttonByText(host: HTMLElement, text: string): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!button) throw new Error(`No button containing "${text}"`);
  return button;
}

describe("Jane's Shop in the web app", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    getJson.mockReset();
    postJson.mockReset();
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("copies the whole pinned catalogue in batches of 50", async () => {
    getJson.mockImplementation((path: string) =>
      Promise.resolve(path.endsWith("/products") ? janeProducts : [jane])
    );
    postJson.mockImplementation((_path: string, body: { productIds: string[] }) =>
      Promise.resolve(body.productIds.map((id) => ({ id: `copy-${id}` }) as ProductSummary))
    );
    const onDuplicated = vi.fn();
    act(() => {
      root = createRoot(host);
      root.render(<CatalogueBrowsePanel businessId="mine" onDuplicated={onDuplicated} />);
    });
    await flush();
    expect(host.textContent).toContain("Pinned");
    expect(host.textContent).toContain("Run by the Marketplace Agent");
    act(() => buttonByText(host, "Jane's Shop").click());
    await flush();

    act(() => buttonByText(host, "Copy whole catalogue (120 products)").click());
    await flush();
    expect(
      postJson.mock.calls.map(([, body]) => (body as { productIds: string[] }).productIds.length)
    ).toEqual([50, 50, 20]);
    expect(postJson.mock.calls[0]![0]).toBe(
      "/businesses/mine/catalogue-marketplace/shops/jane/duplicate"
    );
    expect(onDuplicated).toHaveBeenCalledWith(expect.arrayContaining([{ id: "copy-p-119" }]));
    expect(host.textContent).toContain("All 120 products from Jane's Shop are in your catalogue");
  });

  it("shows no copy-all button for an ordinary shared shop", async () => {
    const ordinary = {
      ...jane,
      businessId: "amina",
      businessName: "Amina",
      pinned: undefined,
      operatedBy: undefined
    };
    getJson.mockImplementation((path: string) =>
      Promise.resolve(path.endsWith("/products") ? janeProducts.slice(0, 2) : [ordinary])
    );
    act(() => {
      root = createRoot(host);
      root.render(<CatalogueBrowsePanel businessId="mine" />);
    });
    await flush();
    act(() => buttonByText(host, "Amina").click());
    await flush();
    expect(host.textContent).not.toContain("Copy whole catalogue");
    expect(host.textContent).not.toContain("Pinned");
  });

  it("labels Jane's Shop as a pinned demo shop in the marketplace directory", () => {
    const storefront: PublicStorefrontSummary = {
      agentId: "grogoni.janes-shop",
      grogoniId: "grogoni.janes-shop",
      commerceAddress: "janes-shop@grogoni.com",
      businessName: "Jane's Shop",
      pinned: true,
      operatedBy: "marketplace_agent",
      presence: { status: "online", updatedAt: new Date(0).toISOString() },
      products: []
    };
    const noop = () => {};
    act(() => {
      root = createRoot(host);
      root.render(
        <MarketplaceModeCard
          businessName=""
          hasBusiness={false}
          isAuthenticated={false}
          isIntro={false}
          isLoadingStorefronts={false}
          productCount={0}
          publicStorefronts={[storefront]}
          grogoniId=""
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
    const card = host.querySelector(".public-shop-card.pinned-shop-card");
    expect(card?.textContent).toContain("Pinned");
    expect(card?.textContent).toContain("Demo shop run by the Marketplace Agent");
  });
});
