// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AccountShopSummary } from "@grogoni/shared-types";
import type { ActiveBusiness } from "../apps/web/src/grogoni-application-shared";
import { YourShopsPanel } from "../apps/web/src/YourShopsPanel";

const shops: AccountShopSummary[] = [
  {
    business: { id: "biz-1", name: "Mama Mboga", language: "en", grogoniId: "grogoni.mama-mboga" },
    membership: { id: "mem-1", businessId: "biz-1", userId: "user-1", role: "owner" }
  },
  {
    business: {
      id: "biz-2",
      name: "Second Shop",
      language: "en",
      grogoniId: "grogoni.second-shop"
    },
    membership: { id: "mem-2", businessId: "biz-2", userId: "user-1", role: "owner" }
  }
];

const activeBusiness = { id: "biz-1" } as ActiveBusiness;

describe("YourShopsPanel", () => {
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

  it("shows each shop's public commerce address, not the raw grogoniId", () => {
    act(() => {
      root = createRoot(host);
      root.render(
        <YourShopsPanel shops={shops} business={activeBusiness} onSwitchBusiness={() => {}} />
      );
    });

    expect(host.textContent).toContain("mama-mboga@grogoni.com");
    expect(host.textContent).toContain("second-shop@grogoni.com");
    expect(host.textContent).not.toContain("grogoni.mama-mboga");
    expect(host.textContent).not.toContain("grogoni.second-shop");
  });
});
