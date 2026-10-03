/**
 * Shop Hub (GET /businesses/:businessId/capabilities): the hub is a projection of the canonical
 * tool and module registries in @grogoni/tool-core, filtered by the caller's role, with each module's
 * setup state resolved from the same domain methods the app and agent use.
 */
import { describe, expect, it } from "vitest";
import type { BusinessRole, ShopCapabilitiesSummary } from "../packages/shared-types/src";
import {
  runtimeToolRegistry,
  shopModuleRegistry,
  type RuntimeToolDefinition,
  type RuntimeToolName
} from "../packages/tool-core/src";
import { permissionsForRole } from "../packages/business-core/src";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import {
  buildShopCapabilities,
  canonicalShopHubRegistries,
  getShopCapabilities
} from "../services/api/src/cp2/domains/shop-hub/capabilities";
import { addMember, createOwner, ok, request, signUp } from "./fixtures/fulfillment-test-helpers";

function setup() {
  const store = createCp2Store();
  const app = buildApi({ cp2: { store } });
  return { app, store };
}

const capabilitiesUrl = (businessId: string) => `/businesses/${businessId}/capabilities`;

function toolNames(summary: ShopCapabilitiesSummary): string[] {
  return summary.categories.flatMap((category) =>
    category.modules.flatMap((module) => module.tools.map((tool) => tool.name))
  );
}

function moduleIds(summary: ShopCapabilitiesSummary): string[] {
  return summary.categories.flatMap((category) => category.modules.map((module) => module.id));
}

function findModule(summary: ShopCapabilitiesSummary, id: string) {
  return summary.categories.flatMap((category) => category.modules).find((m) => m.id === id);
}

describe("shop hub registry metadata", () => {
  it("gives every registered tool an explicit hub choice pointing at a real module", () => {
    for (const tool of Object.values(runtimeToolRegistry)) {
      expect(tool.hub, tool.name).not.toBeUndefined();
      if (tool.hub === null) continue;
      expect(shopModuleRegistry[tool.hub.module], tool.name).toBeDefined();
      expect(tool.hub.label.en.trim(), tool.name).not.toBe("");
      expect(tool.hub.label.sw.trim(), tool.name).not.toBe("");
    }
  });

  it("keeps agent-internal and buyer-side tools out of the hub", () => {
    for (const name of ["unknown.clarify", "commerce.checkout", "computer.click"] as const) {
      expect(runtimeToolRegistry[name].hub).toBeNull();
    }
  });
});

describe("GET /businesses/:businessId/capabilities", () => {
  it("lists every shop-scoped registered tool for the owner, grouped by category", async () => {
    const { app } = setup();
    const owner = await createOwner(app, "Mama Wanjiru Duka");
    const hub = await ok<ShopCapabilitiesSummary>(
      app,
      "GET",
      capabilitiesUrl(owner.businessId),
      owner.cookie
    );

    // The owner holds every permission a hub tool needs, so every hub tool appears.
    const expected = Object.values(runtimeToolRegistry)
      .filter((tool) => tool.hub !== null)
      .map((tool) => tool.name)
      .sort();
    expect(toolNames(hub).sort()).toEqual(expected);
    const ownerPermissions: string[] = permissionsForRole("owner");
    for (const tool of Object.values(runtimeToolRegistry)) {
      expect(ownerPermissions, tool.name).toContain(tool.requiredPermission);
    }
    expect(hub.role).toBe("owner");
    expect(moduleIds(hub).sort()).toEqual(Object.keys(shopModuleRegistry).sort());
    for (const category of hub.categories) {
      for (const module of category.modules) {
        expect(shopModuleRegistry[module.id as keyof typeof shopModuleRegistry].category).toBe(
          category.id
        );
      }
    }
    expect(findModule(hub, "catalog")?.tools.map((tool) => tool.name)).toContain("product.create");
  });

  it("flags an empty catalogue as needing setup until a product exists", async () => {
    const { app } = setup();
    const owner = await createOwner(app, "Empty Shelves");
    const before = await ok<ShopCapabilitiesSummary>(
      app,
      "GET",
      capabilitiesUrl(owner.businessId),
      owner.cookie
    );
    expect(findModule(before, "catalog")?.setup.state).toBe("needs_setup");
    expect(before.needsAttention.map((item) => item.moduleId)).toContain("catalog");
    expect(before.needsAttention.find((item) => item.moduleId === "catalog")?.reason.sw).toBe(
      "Ongeza bidhaa yako ya kwanza ili wateja waweze kuagiza."
    );

    await ok(app, "POST", `/businesses/${owner.businessId}/products`, owner.cookie, {
      name: "Unga 2kg",
      unit: "packet",
      quantity: 10,
      buyingPrice: 150,
      sellingPrice: 180
    });
    const after = await ok<ShopCapabilitiesSummary>(
      app,
      "GET",
      capabilitiesUrl(owner.businessId),
      owner.cookie
    );
    expect(findModule(after, "catalog")?.setup).toEqual({ state: "ready", reason: null });
    expect(after.needsAttention.map((item) => item.moduleId)).not.toContain("catalog");
  });

  it("has no payments setup check and reports unavailable delivery planning without nagging", async () => {
    const { app } = setup();
    const owner = await createOwner(app);
    const hub = await ok<ShopCapabilitiesSummary>(
      app,
      "GET",
      capabilitiesUrl(owner.businessId),
      owner.cookie
    );
    expect(findModule(hub, "payments")?.setup).toEqual({ state: "ready", reason: null });
    // The in-memory store has no Postgres-backed delivery planning.
    expect(findModule(hub, "delivery")?.setup.state).toBe("unavailable");
    expect(hub.needsAttention.map((item) => item.moduleId)).not.toContain("delivery");
  });

  it("filters modules and tools by the caller's role", async () => {
    const { app, store } = setup();
    const owner = await createOwner(app);
    const hubFor = async (role: BusinessRole) => {
      const member = await signUp(app);
      addMember(store, owner.businessId, member.userId, role);
      return ok<ShopCapabilitiesSummary>(
        app,
        "GET",
        capabilitiesUrl(owner.businessId),
        member.cookie
      );
    };

    const cashier = await hubFor("cashier");
    expect(cashier.role).toBe("cashier");
    expect(toolNames(cashier)).toContain("payment.record");
    expect(toolNames(cashier)).not.toContain("product.create");
    expect(moduleIds(cashier)).not.toContain("suppliers");
    const cashierPermissions: string[] = permissionsForRole("cashier");
    for (const name of toolNames(cashier)) {
      expect(cashierPermissions, name).toContain(
        runtimeToolRegistry[name as RuntimeToolName].requiredPermission
      );
    }

    const viewOnly = await hubFor("view_only");
    expect(findModule(viewOnly, "catalog")?.tools.map((tool) => tool.name)).toEqual([
      "products.list"
    ]);
    expect(moduleIds(viewOnly)).not.toContain("payments");

    // `business:write` (network identity changes) belongs to the roles with authority only.
    const manager = await hubFor("manager");
    expect(toolNames(manager)).toContain("network.identity.confirm");
    for (const role of ["sales_agent", "cashier", "view_only"] as const) {
      expect(toolNames(await hubFor(role))).not.toContain("network.identity.confirm");
    }

    const driver = await hubFor("driver");
    expect(moduleIds(driver)).not.toContain("catalog");
    expect(toolNames(driver).every((name) => !name.startsWith("product"))).toBe(true);
  });

  it("refuses callers who are not members of the business", async () => {
    const { app } = setup();
    const owner = await createOwner(app);
    const stranger = await signUp(app);
    const response = await request(app, "GET", capabilitiesUrl(owner.businessId), stranger.cookie);
    expect(response.status).toBe(403);
    const anonymous = await request(app, "GET", capabilitiesUrl(owner.businessId), undefined);
    expect(anonymous.status).toBe(401);
  });
});

describe("shop hub projection", () => {
  it("shows a newly registered tool with no other change", () => {
    const testTool = {
      name: "product.create",
      hub: { module: "catalog", label: { en: "Print shelf labels", sw: "Chapisha lebo" } },
      description: "Test-only tool.",
      risk: "low",
      requiresConfirmation: false,
      readOnly: true,
      requiredPermission: "product:read",
      inputSchema: { type: "object", properties: {} },
      mcpExposable: false
    } satisfies RuntimeToolDefinition;
    const hub = buildShopCapabilities({
      businessId: "b1",
      role: "view_only",
      setupStates: {},
      now: new Date("2026-09-26T00:00:00Z"),
      registries: {
        ...canonicalShopHubRegistries,
        tools: { ...runtimeToolRegistry, "shelf.labels.print": testTool }
      }
    });
    expect(findModule(hub, "catalog")?.tools.map((tool) => tool.label.en)).toContain(
      "Print shelf labels"
    );
  });

  it("degrades a failing setup check to unavailable instead of failing the hub", async () => {
    const hub = await getShopCapabilities({
      businessId: "b1",
      role: "owner",
      now: new Date("2026-09-26T00:00:00Z"),
      checks: {
        catalog_products: async () => {
          throw new Error("catalogue offline");
        },
        channels_linked: async () => "needs_setup",
        agent_runtime: async () => "ready",
        delivery_corridors: async () => "ready"
      }
    });
    expect(findModule(hub, "catalog")?.setup.state).toBe("unavailable");
    expect(hub.needsAttention.map((item) => item.moduleId)).toEqual(["channels"]);
  });
});
