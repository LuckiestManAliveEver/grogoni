import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AccountShopSummary } from "../packages/shared-types/src";
import {
  decideStoredShop,
  resolveStoredShopAtLaunch,
  shopAfterLeaving
} from "../apps/web/src/stored-shop";

const shop = (id: string, role: AccountShopSummary["membership"]["role"]): AccountShopSummary => ({
  business: { id, name: `Shop ${id}`, language: "en", grogoniId: `grogoni.${id}` },
  membership: { id: `m-${id}`, businessId: id, userId: "me", role }
});
const stored = {
  id: "a",
  name: "Old name",
  language: "en",
  grogoniId: "grogoni.a",
  role: "owner"
} as const;

describe("stored shop on a device", () => {
  it("forgets a shop the account no longer belongs to (removed or left)", () => {
    expect(decideStoredShop(stored, [shop("b", "driver")])).toEqual({ action: "forget" });
    expect(decideStoredShop(stored, [])).toEqual({ action: "forget" });
  });

  it("opens a shop the account still has, with the server's current name and role", () => {
    expect(decideStoredShop(stored, [shop("a", "driver")])).toEqual({
      action: "open",
      business: { id: "a", name: "Shop a", language: "en", grogoniId: "grogoni.a", role: "driver" }
    });
  });

  it("after leaving, moves to another shop the account has, or none", () => {
    expect(shopAfterLeaving([shop("a", "driver"), shop("b", "cashier")], "a")?.business.id).toBe(
      "b"
    );
    expect(shopAfterLeaving([shop("a", "driver")], "a")).toBeNull();
  });

  it("at launch, forgets a shop the server says the account cannot use", async () => {
    const forbidden = Object.assign(new Error("Authentication is required."), { status: 401 });
    expect(await resolveStoredShopAtLaunch(stored, async () => Promise.reject(forbidden))).toEqual({
      action: "forget"
    });
    const denied = Object.assign(new Error("Permission denied."), { status: 403 });
    expect(await resolveStoredShopAtLaunch(stored, async () => Promise.reject(denied))).toEqual({
      action: "forget"
    });
    expect(await resolveStoredShopAtLaunch(stored, async () => [shop("b", "driver")])).toEqual({
      action: "forget"
    });
  });

  it("at launch, opens a shop the account still has, with its current role", async () => {
    expect(await resolveStoredShopAtLaunch(stored, async () => [shop("a", "cashier")])).toEqual({
      action: "open",
      business: { id: "a", name: "Shop a", language: "en", grogoniId: "grogoni.a", role: "cashier" }
    });
  });

  it("at launch, keeps the saved workspace only when the server could not answer", async () => {
    expect(
      await resolveStoredShopAtLaunch(stored, async () =>
        Promise.reject(new TypeError("Failed to fetch"))
      )
    ).toEqual({ action: "keep" });
    const outage = Object.assign(new Error("Service unavailable"), { status: 503 });
    expect(await resolveStoredShopAtLaunch(stored, async () => Promise.reject(outage))).toEqual({
      action: "keep"
    });
  });

  it("is what the app uses at launch and after leaving", () => {
    const launch = readFileSync("apps/web/src/hooks/useMarketplaceState.ts", "utf8");
    expect(launch).toContain("resolveStoredShopAtLaunch(storedBusiness");
    // Only after the server answered that this account is not the owner: a failing request in the
    // owner branch must never drop the owner's shop (regression caught by the e2e certification).
    expect(launch).toContain("if (ownerCheck !== null && !ownerCheck.allowed) {");
    expect(readFileSync("apps/web/src/AgentProfileSurface.tsx", "utf8")).toContain(
      "shopAfterLeaving(shops, business.id)"
    );
  });
});
