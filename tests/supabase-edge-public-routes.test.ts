import { describe, expect, it, vi } from "vitest";
import { createPublicRoutes } from "../supabase/functions/api/public-routes";
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
    expect(query).toHaveBeenCalledWith(expect.stringContaining("<> 'private'"), ["shop", 2]);
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
