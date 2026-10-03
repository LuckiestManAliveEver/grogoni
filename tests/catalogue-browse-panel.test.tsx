// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ProductSummary,
  ShareableCatalogueProductSummary,
  ShareableCatalogueSummary
} from "@grogoni/shared-types";

const getJson = vi.fn();
const postJson = vi.fn();

vi.mock("../apps/web/src/api-helpers", () => ({
  getJson: (...args: unknown[]) => getJson(...args),
  postJson: (...args: unknown[]) => postJson(...args)
}));

const { default: CatalogueBrowsePanel } = await import("../apps/web/src/CatalogueBrowsePanel");

const shop: ShareableCatalogueSummary = {
  businessId: "shop-a",
  grogoniId: "grogoni.shop-a",
  businessName: "Amina's Fresh Produce",
  productCount: 1,
  updatedAt: new Date(0).toISOString()
};

const shareableProduct: ShareableCatalogueProductSummary = {
  id: "product-1",
  name: "Sukuma wiki bundle",
  unit: "bundle",
  sellingPrice: 30,
  image: null
};

const duplicatedProduct: ProductSummary = {
  id: "product-2",
  businessId: "shop-b",
  name: "Sukuma wiki bundle",
  sku: null,
  unit: "bundle",
  quantity: 0,
  buyingPrice: null,
  sellingPrice: 30,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString()
};

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("CatalogueBrowsePanel", () => {
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

  it("lists shareable shops, drills into one, and duplicates the selected product", async () => {
    getJson.mockImplementation((path: string) => {
      if (path === "/businesses/shop-b/catalogue-marketplace/shops") {
        return Promise.resolve([shop]);
      }
      if (path === "/businesses/shop-b/catalogue-marketplace/shops/shop-a/products") {
        return Promise.resolve([shareableProduct]);
      }
      throw new Error(`Unexpected getJson path: ${path}`);
    });
    postJson.mockResolvedValue([duplicatedProduct]);
    const onDuplicated = vi.fn();

    await act(async () => {
      root = createRoot(host);
      root.render(<CatalogueBrowsePanel businessId="shop-b" onDuplicated={onDuplicated} />);
    });
    await flush();

    expect(getJson).toHaveBeenCalledWith("/businesses/shop-b/catalogue-marketplace/shops");
    expect(host.textContent).toContain("Amina's Fresh Produce");
    // Displays the friendly public commerce address, not the raw internal grogoniId.
    expect(host.textContent).toContain("shop-a@grogoni.com");
    expect(host.textContent).not.toContain("grogoni.shop-a");

    const shopButton = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Amina's Fresh Produce")
    );
    expect(shopButton).toBeDefined();
    act(() => shopButton!.click());
    await flush();

    expect(getJson).toHaveBeenCalledWith(
      "/businesses/shop-b/catalogue-marketplace/shops/shop-a/products"
    );
    expect(host.textContent).toContain("Sukuma wiki bundle");

    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    act(() => checkbox!.click());

    const duplicateButton = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Add")
    );
    expect(duplicateButton).toBeDefined();
    await act(async () => {
      duplicateButton!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(postJson).toHaveBeenCalledWith(
      "/businesses/shop-b/catalogue-marketplace/shops/shop-a/duplicate",
      { productIds: ["product-1"] }
    );
    expect(onDuplicated).toHaveBeenCalledWith([duplicatedProduct]);
    expect(host.textContent).toContain("1 product added to your catalogue from");
  });

  it("shows an empty state when no shops have shared their catalogue", async () => {
    getJson.mockResolvedValue([]);

    await act(async () => {
      root = createRoot(host);
      root.render(<CatalogueBrowsePanel businessId="shop-b" />);
    });
    await flush();

    expect(host.textContent).toContain("No shops have shared their catalogue for duplication yet.");
  });
});
