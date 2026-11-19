import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collectEdgeRouteInventory } from "../services/api/src/edge-route-inventory";
import { edgeRouteInventory } from "../services/api/src/edge-route-inventory.generated";
import { renderEdgeRouteInventory } from "../scripts/generate-edge-route-inventory";

describe("build-time Edge route inventory", () => {
  it("matches the live CP2 and MCP route registration, in registration order", async () => {
    const live = await collectEdgeRouteInventory();
    expect(live.length).toBeGreaterThan(100);
    // Order matters: Edge route matching takes the first pattern that fits.
    expect(edgeRouteInventory).toEqual(live);
  });

  it("is committed exactly as the generator writes it (run `pnpm generate:edge-routes`)", async () => {
    const committed = readFileSync(
      new URL("../services/api/src/edge-route-inventory.generated.ts", import.meta.url),
      "utf8"
    );
    expect(committed).toBe(await renderEdgeRouteInventory(await collectEdgeRouteInventory()));
  });
});
