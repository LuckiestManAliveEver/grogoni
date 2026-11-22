// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

const getJson = vi.fn();
vi.mock("../apps/web/src/api-helpers", () => ({
  getJson: (...args: unknown[]) => getJson(...args),
  postJson: vi.fn(),
  fetchFreshJson: vi.fn()
}));
const { useMarketplaceState } = await import("../apps/web/src/hooks/useMarketplaceState");

// The shop directory list: a plain Refresh keeps the buyer's filter (the form still shows it),
// and a slower answer to an older search never replaces a newer one.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function mount() {
  let api: ReturnType<typeof useMarketplaceState> | null = null;
  function Harness() {
    api = useMarketplaceState({
      session: null,
      setBusiness: () => undefined,
      setAgentSettings: () => undefined,
      setStatusMessage: () => undefined,
      getNavigationSetters: () => ({
        setIsMarketplaceShortcutOpen: () => undefined,
        setShopPresenceStatus: () => undefined
      }),
      registerReset: () => undefined
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  return { api: () => api!, unmount: () => act(() => root.unmount()) };
}

const shops = (name: string) => ({ storefronts: [{ businessName: name }] });

describe("shop directory loading", () => {
  it("keeps the active filter when the list is refreshed", async () => {
    getJson.mockReset().mockResolvedValue(shops("Duka"));
    const { api, unmount } = await mount();
    await act(async () => api().loadPublicStorefronts({ category: "pharmacy", place: "Kisumu" }));
    await act(async () => api().loadPublicStorefronts());
    expect(getJson.mock.calls.map(([path]) => path)).toEqual([
      "/public/storefronts?limit=24&category=pharmacy&place=Kisumu",
      "/public/storefronts?limit=24&category=pharmacy&place=Kisumu"
    ]);
    await act(async () => api().loadPublicStorefronts({}));
    expect(getJson).toHaveBeenLastCalledWith("/public/storefronts?limit=24");
    unmount();
  });

  it("ignores an older search that answers after a newer one", async () => {
    const older = deferred<unknown>();
    const newer = deferred<unknown>();
    getJson.mockReset().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const { api, unmount } = await mount();
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = api().loadPublicStorefronts({ category: "pharmacy" });
    });
    act(() => {
      second = api().loadPublicStorefronts({ category: "bakery" });
    });
    await act(async () => {
      newer.resolve(shops("Bakery"));
      await second;
    });
    expect(api().publicStorefronts.map((shop) => shop.businessName)).toEqual(["Bakery"]);
    expect(api().publicStorefrontsLoading).toBe(false);
    await act(async () => {
      older.resolve(shops("Pharmacy"));
      await first;
    });
    expect(api().publicStorefronts.map((shop) => shop.businessName)).toEqual(["Bakery"]);
    unmount();
  });
});
