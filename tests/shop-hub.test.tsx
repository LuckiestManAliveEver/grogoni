// @vitest-environment jsdom
import { readFileSync, readdirSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShopCapabilitiesSummary } from "@grogoni/shared-types";
import { runtimeToolRegistry, shopModuleRegistry } from "../packages/tool-core/src";
import { buildShopCapabilities } from "../services/api/src/cp2/domains/shop-hub/capabilities";

const getJson = vi.fn();

vi.mock("../apps/web/src/api-helpers", () => ({
  getJson: (...args: unknown[]) => getJson(...args)
}));

const { ShopHub, askAgentDraft } = await import("../apps/web/src/ShopHub");
const { ShopHubEntryCard } = await import("../apps/web/src/ShopHubEntryCard");
const { shopHubCopy } = await import("../apps/web/src/shop-hub-copy");
const { shopHubSurfaces } = await import("../apps/web/src/shop-hub-surfaces");

/** The hub the API would return: the real registry projection, not a hand-written fixture. */
function hubFixture(role: "owner" | "cashier" = "owner"): ShopCapabilitiesSummary {
  return buildShopCapabilities({
    businessId: "shop-a",
    role,
    setupStates: {
      catalog_products: "needs_setup",
      channels_linked: "ready",
      agent_runtime: "ready",
      delivery_corridors: "unavailable"
    },
    now: new Date("2026-09-26T00:00:00Z")
  });
}

describe("ShopHub", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    getJson.mockReset();
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  async function render(
    overrides: Partial<Parameters<typeof ShopHub>[0]> = {}
  ): Promise<{ onOpenSurface: ReturnType<typeof vi.fn>; onAskAgent: ReturnType<typeof vi.fn> }> {
    const onOpenSurface = vi.fn();
    const onAskAgent = vi.fn();
    await act(async () => {
      root = createRoot(host);
      root.render(
        <ShopHub
          businessId="shop-a"
          businessName="Mama Wanjiru Duka"
          grogoniId="grogoni.mama-wanjiru"
          language="en"
          onOpenSurface={onOpenSurface}
          onAskAgent={onAskAgent}
          {...overrides}
        />
      );
    });
    return { onOpenSurface, onAskAgent };
  }

  function buttonNamed(name: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll("button")).find(
      (candidate) =>
        candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name
    );
    expect(button, name).toBeDefined();
    return button!;
  }

  it("renders every category and module the endpoint returns, in order", async () => {
    const hub = hubFixture();
    getJson.mockResolvedValue(hub);
    await render();

    expect(getJson).toHaveBeenCalledWith("/businesses/shop-a/capabilities", expect.any(Function));
    const sections = Array.from(host.querySelectorAll(".shop-hub-section h4")).map(
      (heading) => heading.textContent
    );
    expect(sections).toEqual(hub.categories.map((category) => category.label.en));
    const tiles = Array.from(host.querySelectorAll<HTMLElement>(".shop-hub-tile")).map(
      (tile) => tile.dataset.moduleId
    );
    expect(tiles).toEqual(
      hub.categories.flatMap((category) => category.modules.map((module) => module.id))
    );
    expect(host.querySelector(".shop-hub-slug")?.textContent).toMatch(
      /\/agent\/grogoni\.mama-wanjiru$/u
    );
  });

  it("puts needs-setup modules in the attention strip with a one-tap fix", async () => {
    getJson.mockResolvedValue(hubFixture());
    const { onOpenSurface } = await render();

    const strip = host.querySelector(".shop-hub-attention")!;
    expect(strip.textContent).toContain("Add your first product so customers can order.");
    // Unavailable (delivery here) is shown on its tile, never as something to fix.
    expect(strip.textContent).not.toContain("Delivery planning");
    act(() => buttonNamed("Fix: Catalogue").click());
    expect(onOpenSurface).toHaveBeenCalledWith(shopHubSurfaces.catalog[0]);
  });

  it("opens a tile as a drawer module and asks the agent with that tool's command", async () => {
    getJson.mockResolvedValue(hubFixture());
    const { onAskAgent, onOpenSurface } = await render();

    act(() => host.querySelector<HTMLButtonElement>('[data-module-id="catalog"]')!.click());
    const detail = host.querySelector(".shop-hub-detail");
    expect(detail?.getAttribute("data-module-id")).toBe("catalog");
    expect(document.activeElement?.textContent).toContain("Back");
    act(() => buttonNamed("← Back").click());
    expect(host.querySelector(".shop-hub-detail")).toBeNull();
    expect(document.activeElement?.getAttribute("data-module-id")).toBe("catalog");

    act(() => host.querySelector<HTMLButtonElement>('[data-module-id="catalog"]')!.click());
    act(() => buttonNamed("Ask the agent: Add a product").click());
    expect(onAskAgent).toHaveBeenCalledWith("#product.create ");

    act(() => host.querySelector<HTMLButtonElement>('[data-module-id="orders"]')!.click());
    act(() => buttonNamed("Today's dashboard").click());
    expect(onOpenSurface).toHaveBeenCalledWith({
      kind: "workspace",
      view: "businessDashboard",
      label: "businessDashboard"
    });
  });

  it("only offers the tools the caller's role can run", async () => {
    getJson.mockResolvedValue(hubFixture("cashier"));
    await render();
    expect(host.querySelector('[data-module-id="suppliers"]')).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('[data-module-id="payments"]')!.click());
    const drawerText = document.querySelector(".shop-hub-detail")!.textContent;
    expect(drawerText).toContain("Record a payment");
  });

  it("renders in Swahili from the same payload", async () => {
    getJson.mockResolvedValue(hubFixture());
    await render({ language: "sw" });
    const sw = shopHubCopy("sw");
    expect(host.textContent).toContain(sw.needsAttention);
    expect(host.textContent).toContain("Ongeza bidhaa yako ya kwanza ili wateja waweze kuagiza.");
    expect(host.textContent).toContain("Njia za mauzo");
    expect(host.querySelector(".shop-hub")?.getAttribute("lang")).toBe("sw");
  });

  it("shows skeletons while loading and an offline state with retry", async () => {
    let reject: (error: unknown) => void = () => undefined;
    getJson.mockReturnValueOnce(
      new Promise((_, fail) => {
        reject = fail;
      })
    );
    await render();
    expect(host.querySelectorAll(".shop-hub-skeleton-tile").length).toBeGreaterThan(0);

    vi.stubGlobal("navigator", { ...navigator, onLine: false });
    await act(async () => reject(new Error("offline")));
    expect(host.textContent).toContain(shopHubCopy("en").offline);

    getJson.mockResolvedValueOnce(hubFixture());
    await act(async () => buttonNamed("Try again").click());
    expect(host.querySelectorAll(".shop-hub-tile").length).toBeGreaterThan(0);
  });

  it("gives the chat's owner-controls message a single entry into the hub", async () => {
    const onOpen = vi.fn();
    await act(async () => {
      root = createRoot(host);
      root.render(<ShopHubEntryCard language="en" onOpen={onOpen} />);
    });
    act(() => host.querySelector<HTMLButtonElement>(".shop-hub-entry-button")!.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe("Shop Hub stays registry-driven", () => {
  it("keeps tool names and module copy out of the web app", () => {
    const hubSources = readdirSync("apps/web/src")
      .filter((file) => /^(ShopHub|shop-hub)/u.test(file))
      .map((file) => readFileSync(`apps/web/src/${file}`, "utf8"))
      .join("\n");
    expect(hubSources.length).toBeGreaterThan(0);
    for (const name of Object.keys(runtimeToolRegistry)) {
      expect(hubSources, name).not.toContain(`"${name}"`);
    }
    for (const module of Object.values(shopModuleRegistry)) {
      expect(hubSources, module.id).not.toContain(module.description.en);
    }
    expect(askAgentDraft("payment.record")).toBe("#payment.record ");
  });

  it("routes Go to my shop to the hub", () => {
    const application = readFileSync("apps/web/src/GrogoniApplication.tsx", "utf8");
    const onGoToShop = application.slice(application.indexOf("onGoToShop={() => {"));
    expect(onGoToShop.slice(0, 200)).toContain("openShopHub();");
    const navigation = readFileSync("apps/web/src/hooks/useNavigationState.ts", "utf8");
    expect(navigation).toContain(
      'navigateToOwnerRoute({ mode: "seller", view: "chat", panel: "shop-hub" })'
    );
  });
});
