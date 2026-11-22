// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getJson = vi.fn();
const patchJson = vi.fn();
vi.mock("../apps/web/src/api-helpers", () => ({
  getJson: (...args: unknown[]) => getJson(...args),
  patchJson: (...args: unknown[]) => patchJson(...args)
}));

const { default: ShopDirectoryListingCard } =
  await import("../apps/web/src/ShopDirectoryListingCard");
const { ShopDirectoryFilters } = await import("../apps/web/src/ShopDirectoryFilters");
const { storefrontSearchPath, shopCategoryLabels, shopCategories } =
  await import("../apps/web/src/shop-directory");

// The owner's listing card and the buyer's filters for the shop directory.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype =
    element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? "change" : "input", {
      bubbles: true
    })
  );
}

const flush = () =>
  act(async () => {
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
  });

let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  getJson.mockReset();
  patchJson.mockReset();
});
afterEach(() => {
  host.remove();
});

describe("shop directory search path", () => {
  it("adds only the filters that are set", () => {
    expect(storefrontSearchPath()).toBe("/public/storefronts?limit=24");
    expect(storefrontSearchPath({ category: "pharmacy", place: "  Kisumu " })).toBe(
      "/public/storefronts?limit=24&category=pharmacy&place=Kisumu"
    );
    expect(storefrontSearchPath({ place: "   " })).toBe("/public/storefronts?limit=24");
  });

  it("has a label for every category", () => {
    for (const category of shopCategories) expect(shopCategoryLabels[category]).toBeTruthy();
  });
});

describe("buyer filters", () => {
  it("searches by what a shop sells and where it is", async () => {
    const onSearch = vi.fn();
    const root = createRoot(host);
    await act(async () => root.render(<ShopDirectoryFilters onSearch={onSearch} />));
    const select = host.querySelector("select")!;
    const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    act(() => setValue(select, "butchery"));
    act(() => setValue(input, " Thika "));
    act(() => host.querySelector("form")!.requestSubmit());
    expect(onSearch).toHaveBeenLastCalledWith({ category: "butchery", place: "Thika" });
    act(() => setValue(select, ""));
    act(() => setValue(input, ""));
    act(() => host.querySelector("form")!.requestSubmit());
    expect(onSearch).toHaveBeenLastCalledWith({});
    act(() => root.unmount());
  });
});

describe("owner listing card", () => {
  it("shows the saved listing and saves a change", async () => {
    getJson.mockResolvedValue({
      businessId: "shop-a",
      status: "online",
      catalogueShareable: false,
      category: "bakery",
      place: "Nakuru",
      updatedBy: "u",
      updatedAt: new Date(0).toISOString()
    });
    patchJson.mockImplementation(async (_path: string, body: Record<string, unknown>) => ({
      businessId: "shop-a",
      status: "online",
      catalogueShareable: false,
      ...body,
      updatedBy: "u",
      updatedAt: new Date(0).toISOString()
    }));
    const root = createRoot(host);
    await act(async () => root.render(<ShopDirectoryListingCard businessId="shop-a" />));
    await flush();
    expect(getJson).toHaveBeenCalledWith("/businesses/shop-a/presence");
    const select = host.querySelector("select")!;
    const input = host.querySelector("input")!;
    expect(select.value).toBe("bakery");
    expect(input.value).toBe("Nakuru");

    act(() => setValue(select, "restaurant"));
    act(() => setValue(input, "Nakuru town"));
    await act(async () => host.querySelector("form")!.requestSubmit());
    await flush();
    expect(patchJson).toHaveBeenCalledWith("/businesses/shop-a/directory-listing", {
      category: "restaurant",
      place: "Nakuru town"
    });
    expect(host.textContent).toMatch(/Buyers can now find your shop/u);

    act(() => setValue(select, ""));
    act(() => setValue(input, "  "));
    await act(async () => host.querySelector("form")!.requestSubmit());
    await flush();
    expect(patchJson).toHaveBeenLastCalledWith("/businesses/shop-a/directory-listing", {
      category: null,
      place: null
    });
    expect(host.textContent).toMatch(/listed by name only/u);
    act(() => root.unmount());
  });

  it("says why the listing could not load, and loads again on Try again", async () => {
    getJson.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({
      businessId: "shop-a",
      status: "online",
      catalogueShareable: false,
      updatedBy: "u",
      updatedAt: new Date(0).toISOString()
    });
    const root = createRoot(host);
    await act(async () => root.render(<ShopDirectoryListingCard businessId="shop-a" />));
    await flush();
    expect(host.querySelector("form")).toBeNull();
    expect(host.textContent).not.toMatch(/Loading/u);
    const retry = [...host.querySelectorAll("button")].find((b) => b.textContent === "Try again");
    await act(async () => retry!.click());
    await flush();
    expect(getJson).toHaveBeenCalledTimes(2);
    expect(host.querySelector("form")).not.toBeNull();
    act(() => root.unmount());
  });
});
