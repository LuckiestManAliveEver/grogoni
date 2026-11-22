// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ShopPresenceSummary } from "@grogoni/shared-types";

const getJson = vi.fn();
const patchJson = vi.fn();
// The owner check (useIsShopOwner): an owner unless a test says otherwise.
const postJson = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
  allowed: true,
  role: "owner"
}));

vi.mock("../apps/web/src/api-helpers", () => ({
  getJson: (...args: unknown[]) => getJson(...args),
  patchJson: (...args: unknown[]) => patchJson(...args),
  postJson: (...args: unknown[]) => postJson(...args)
}));

const { default: CatalogueShareSettingsCard } =
  await import("../apps/web/src/CatalogueShareSettingsCard");

const presence: ShopPresenceSummary = {
  businessId: "shop-a",
  status: "online",
  catalogueShareable: false,
  updatedBy: "user-1",
  updatedAt: new Date(0).toISOString()
};

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("CatalogueShareSettingsCard", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    getJson.mockReset();
    patchJson.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("loads the current opt-in state and toggles it via PATCH", async () => {
    getJson.mockResolvedValue(presence);
    patchJson.mockResolvedValue({ ...presence, catalogueShareable: true });

    await act(async () => {
      root = createRoot(host);
      root.render(<CatalogueShareSettingsCard businessId="shop-a" />);
    });
    await flush();

    expect(getJson).toHaveBeenCalledWith("/businesses/shop-a/presence");
    const checkbox = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    expect(checkbox!.checked).toBe(false);

    await act(async () => {
      checkbox!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(patchJson).toHaveBeenCalledWith("/businesses/shop-a/presence", {
      status: "online",
      catalogueShareable: true
    });
    expect(host.textContent).toContain("Other shops can now browse and duplicate your catalogue.");
  });
});
