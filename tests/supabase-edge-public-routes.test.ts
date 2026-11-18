import { describe, expect, it, vi } from "vitest";
import {
  createPublicRoutes,
  pinnedSystemShopBusinessId
} from "../supabase/functions/api/public-routes";
import type { SqlClient, Transaction } from "../supabase/functions/api/session-routes";

function setup(query: SqlClient["query"] = vi.fn(async () => ({ rows: [] }))) {
  return {
    query,
    routes: createPublicRoutes((async (action) => action({ query })) as Transaction)
  };
}
describe("Edge public routes", () => {
  it("serves public storefronts without a session and derives public addresses", async () => {
    const { routes, query } = setup(
      vi.fn(async () => ({
        rows: [
          { business: { grogoniId: "grogoni.shop", name: "Shop" }, presence: null, products: [] }
        ]
      }))
    );
    const response = await routes(
      new Request("https://example.com/public/storefronts?search=shop&limit=2"),
      "/public/storefronts"
    );
    expect(await response!.json()).toMatchObject({
      storefronts: [{ commerceAddress: "shop@grogoni.com", presence: { status: "online" } }]
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("<> 'private'"), [
      "shop",
      2,
      pinnedSystemShopBusinessId
    ]);
  });
  it("pins and labels Jane's Shop first and provisions it before listing", async () => {
    const order: string[] = [];
    const query = vi.fn(async (sql: string) => {
      order.push("query");
      expect(sql).toContain("order by (b.entity_id = $3) desc, b.record->>'name'");
      return {
        rows: [
          {
            business: {
              id: pinnedSystemShopBusinessId,
              grogoniId: "grogoni.janes-shop",
              name: "Jane's Shop"
            },
            presence: { status: "online" },
            products: []
          },
          {
            business: { id: "other", grogoniId: "grogoni.a", name: "Aardvark" },
            presence: null,
            products: []
          }
        ]
      };
    });
    const routes = createPublicRoutes((async (action) => action({ query })) as Transaction, {
      ensureSystemShop: async () => {
        order.push("ensure");
        throw new Error("provisioning must never break the list");
      }
    });
    const response = await routes(
      new Request("https://example.com/public/storefronts?limit=1"),
      "/public/storefronts"
    );
    const body = await response!.json();
    expect(order).toEqual(["ensure", "query"]);
    expect(body.storefronts[0]).toMatchObject({
      businessName: "Jane's Shop",
      commerceAddress: "janes-shop@grogoni.com",
      pinned: true,
      operatedBy: "marketplace_agent"
    });
    expect(body.storefronts[1].pinned).toBeUndefined();
  });
  it("reports no OAuth providers when OAuth is not configured", async () => {
    const { routes, query } = setup();
    expect(
      await (await routes(
        new Request("https://example.com/auth/oauth/providers"),
        "/auth/oauth/providers"
      ))!.json()
    ).toEqual({ providers: [] });
    expect(query).not.toHaveBeenCalled();
  });
  it("rejects anonymous intro updates without accessing the database", async () => {
    const { routes, query } = setup();
    const response = await routes(
      new Request("https://example.com/v1/marketplace-intro/complete", {
        method: "POST",
        body: "{}"
      }),
      "/v1/marketplace-intro/complete"
    );
    expect(response!.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
  it("rejects malformed limits", async () => {
    const { routes, query } = setup();
    expect(
      (await routes(
        new Request("https://example.com/public/storefronts?limit=bad"),
        "/public/storefronts"
      ))!.status
    ).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});
