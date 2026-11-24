// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuyResultSummary } from "../packages/shared-types/src";

const apiFetch = vi.fn();
const apiCloudFetch = vi.fn();
vi.mock("../apps/web/src/lib/api", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  apiCloudFetch: (...args: unknown[]) => apiCloudFetch(...args)
}));
const { StatusResultCard } = await import("../apps/web/src/StatusResultCard");
const { default: StatusBroadcastComposer } =
  await import("../apps/web/src/StatusBroadcastComposer");
const { NetworkPrivacyControls } = await import("../apps/web/src/NetworkPrivacyControls");
const { MarketplaceModeCard } = await import("../apps/web/src/MarketplaceModeCard");

// The buyer's "Stop updates", the shop's picker, and the place to turn updates back on.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const flush = () =>
  act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
const contactResult: BuyResultSummary = {
  id: "contact:s1:i1",
  title: "Sukuma wiki",
  price: 40,
  image: null,
  sourceKind: "contact",
  sourceLabel: "Mama Mboga",
  sourceId: "s1",
  agentId: null,
  productId: null,
  statusBroadcastId: "s1",
  productCaptureItemId: "i1",
  sourceBusinessId: "shop-1",
  sourceBusinessName: "Mama Mboga Fresh"
};

let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  apiFetch.mockReset();
  apiCloudFetch.mockReset();
});
afterEach(() => host.remove());

describe("Stop updates on a contact status", () => {
  it("is offered on a contact status with its shop, and names the shop", async () => {
    const onMuteShop = vi.fn();
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <StatusResultCard
          result={contactResult}
          isAuthenticated
          onAddToCart={() => undefined}
          onMuteShop={onMuteShop}
        />
      )
    );
    const button = host.querySelector<HTMLButtonElement>(
      '[aria-label="Stop updates from Mama Mboga Fresh"]'
    )!;
    act(() => button.click());
    expect(onMuteShop).toHaveBeenCalledWith("shop-1");
    act(() => root.unmount());
  });

  it("is not offered on a catalogue result or to a guest", async () => {
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <>
          <StatusResultCard
            result={{ ...contactResult, sourceKind: "catalogue", sourceBusinessId: null }}
            isAuthenticated
            onAddToCart={() => undefined}
            onMuteShop={() => undefined}
          />
          <StatusResultCard
            result={contactResult}
            isAuthenticated={false}
            onAddToCart={() => undefined}
            onMuteShop={() => undefined}
          />
        </>
      )
    );
    expect(host.textContent).not.toContain("Stop updates");
    act(() => root.unmount());
  });
});

describe("the shop's contact picker", () => {
  it("shows who turned updates off, and they cannot be chosen", async () => {
    apiFetch.mockResolvedValue({
      candidates: [
        {
          networkNodeId: "n1",
          displayName: "Amina",
          isGrogoniUser: true,
          isExistingCustomer: true,
          defaultSelected: false,
          optedOut: true
        },
        {
          networkNodeId: "n2",
          displayName: "Baraka",
          isGrogoniUser: true,
          isExistingCustomer: true,
          defaultSelected: true,
          optedOut: false
        }
      ]
    });
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <StatusBroadcastComposer
          businessId="shop-1"
          captureJobId="job-1"
          onPosted={() => undefined}
        />
      )
    );
    await flush();
    const boxes = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.map((box) => [box.disabled, box.checked])).toEqual([
      [true, false],
      [false, true]
    ]);
    expect(host.textContent).toContain("Turned off updates from your shop");
    act(() => root.unmount());
  });
});

describe("turning a shop's updates back on", () => {
  it("lists turned-off shops in contact privacy and turns one back on", async () => {
    apiCloudFetch.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (path === "/network/privacy") return { discoverable: true, blockedContacts: [] };
      if (path === "/v1/broadcast-preferences")
        return {
          mutedShops: [
            { businessId: "shop-1", businessName: "Mama Mboga", mutedAt: "2026-11-24T08:00:00Z" }
          ]
        };
      if (options?.method === "PUT") return { businessId: "shop-1", receive: true };
      throw new Error(`unexpected ${path}`);
    });
    const root = createRoot(host);
    await act(async () => root.render(<NetworkPrivacyControls />));
    const details = host.querySelector("details")!;
    details.open = true;
    await act(async () => details.dispatchEvent(new Event("toggle")));
    await flush();
    const button = [...host.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("Turn updates from Mama Mboga back on")
    )!;
    await act(async () => button.click());
    await flush();
    expect(apiCloudFetch).toHaveBeenCalledWith("/v1/broadcast-preferences/shop-1", {
      method: "PUT",
      body: { receive: true }
    });
    expect(host.textContent).not.toContain("Turn updates from Mama Mboga back on");
    expect(host.textContent).toContain("Updates from Mama Mboga are on again.");
    act(() => root.unmount());
  });
});

describe("the buy feed after Stop updates", () => {
  it("drops that shop's statuses at once and says where to turn them back on", async () => {
    apiFetch.mockResolvedValue({ businessId: "shop-1", receive: false });
    const noop = () => undefined;
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <MarketplaceModeCard
          businessName=""
          hasBusiness={false}
          isAuthenticated
          isIntro={false}
          isLoadingStorefronts={false}
          productCount={0}
          publicStorefronts={[]}
          grogoniId=""
          buyFeed={{
            query: "sukuma",
            results: [
              contactResult,
              {
                ...contactResult,
                id: "catalogue:1",
                sourceKind: "catalogue",
                sourceBusinessId: null
              }
            ],
            marketplaceConnectorAvailable: false
          }}
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
      )
    );
    expect(host.querySelectorAll(".buy-result-card")).toHaveLength(2);
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="Stop updates from Mama Mboga Fresh"]')!
        .click()
    );
    await flush();
    expect(apiFetch).toHaveBeenCalledWith("/v1/broadcast-preferences/shop-1", {
      method: "PUT",
      body: { receive: false }
    });
    expect(host.querySelectorAll(".buy-result-card")).toHaveLength(1);
    expect(host.textContent).toContain("You won't see updates from Mama Mboga Fresh");
    act(() => root.unmount());
  });
});
