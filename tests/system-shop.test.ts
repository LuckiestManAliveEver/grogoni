import { describe, expect, it } from "vitest";
import { validateProductInput } from "../packages/business-core/src";
import type {
  BuyFeedSummary,
  ProductSummary,
  ShareableCatalogueProductSummary,
  ShareableCatalogueSummary,
  UnifiedCheckoutSummary
} from "../packages/shared-types/src";
import { buildApi } from "../services/api/src/app";
import { seedCatalogue } from "../services/api/src/cp2/domains/catalogue-sharing/seed-catalogue";
import {
  systemShop,
  systemShopDemoPriceKes,
  systemShopEntityId,
  systemShopProductId,
  systemShopProductPlan,
  systemShopStockPolicy
} from "../services/api/src/cp2/domains/system-shop/catalogue";
import { systemShopProvisioningEnabled } from "../services/api/src/cp2/domains/system-shop/provisioning";
import { systemShopScopedRoute } from "../services/api/src/cp2/edge-snapshot-scope";
import { createCp2Store, type PublicStorefrontSummary } from "../services/api/src/cp2/store";
import { SystemShopDomain } from "../services/api/src/cp2/domains/system-shop/store";
import {
  stripSystemShopPlanRecords,
  systemShopPlanRecordsFor
} from "../services/api/src/edge-domain-routes";
import { pinnedSystemShopBusinessId } from "../supabase/functions/api/public-routes";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("Jane's Shop catalogue plan (pure)", () => {
  it("derives stable, valid, distinct UUIDs", () => {
    expect(systemShopEntityId("business")).toBe(systemShop.businessId);
    const ids = [
      systemShop.businessId,
      systemShop.accountId,
      systemShop.userId,
      systemShop.membershipId
    ];
    for (const id of ids) expect(id).toMatch(uuidPattern);
    expect(new Set(ids).size).toBe(4);
  });

  it("plans one product per marketplace catalogue product with unique ids and skus", () => {
    const plan = systemShopProductPlan();
    expect(plan).toHaveLength(seedCatalogue.products.length);
    expect(new Set(plan.map((p) => p.id)).size).toBe(plan.length);
    expect(new Set(plan.map((p) => p.sku)).size).toBe(plan.length);
    expect(plan.map((p) => p.sourceProductId)).toEqual(seedCatalogue.products.map((p) => p.id));
    for (const product of plan) {
      expect(product.id).toMatch(uuidPattern);
      expect(product.id).toBe(systemShopProductId(product.sourceProductId));
      expect(
        validateProductInput({
          name: product.name,
          unit: "unit",
          quantity: systemShopStockPolicy.targetQuantity,
          buyingPrice: null,
          sellingPrice: product.sellingPrice
        })
      ).toEqual({ ok: true, errors: [] });
    }
  });

  it("prices every product deterministically inside its department band in 5 KES steps", () => {
    const bands: Record<string, [number, number]> = {
      food_and_grocery: [50, 600],
      household_and_cleaning: [80, 900],
      personal_care: [60, 700],
      lighting_and_electrical: [150, 2500],
      general_retail: [50, 1500]
    };
    for (const product of seedCatalogue.products) {
      const price = systemShopDemoPriceKes(product);
      expect(price).toBe(systemShopDemoPriceKes(product));
      const [min, max] = bands[product.department] ?? [50, 1500];
      expect(price).toBeGreaterThanOrEqual(min);
      expect(price).toBeLessThanOrEqual(max);
      expect(price % 5).toBe(0);
    }
    expect(systemShopDemoPriceKes({ id: "x", department: "unknown" })).toBeGreaterThanOrEqual(50);
    // Spread, not a constant: a hash that collapsed would price everything the same.
    expect(new Set(systemShopProductPlan().map((p) => p.sellingPrice)).size).toBeGreaterThan(100);
  });

  it("is enabled unless GROGONI_SYSTEM_SHOP=off", () => {
    expect(systemShopProvisioningEnabled({})).toBe(true);
    expect(systemShopProvisioningEnabled({ GROGONI_SYSTEM_SHOP: "on" })).toBe(true);
    expect(systemShopProvisioningEnabled({ GROGONI_SYSTEM_SHOP: " OFF " })).toBe(false);
  });

  it("loads Jane's Shop by itself on Edge only in its dedicated provisioning transaction", () => {
    expect(systemShopScopedRoute("POST", "/internal/system-shop/provision")).toBe(true);
    // Marketplace routes must not take Jane's tenant lock or hydrate her order history.
    for (const [method, path] of [
      ["GET", "/public/storefronts"],
      ["GET", "/buy/search"],
      ["POST", "/buy/assistant"],
      ["GET", "/businesses/abc/catalogue-marketplace/shops"],
      ["POST", "/businesses/abc/catalogue-marketplace/shops/x/duplicate"],
      ["POST", "/v1/messages"],
      ["GET", "/internal/system-shop/provision"]
    ] as const)
      expect(systemShopScopedRoute(method, path), `${method} ${path}`).toBe(false);
  });

  it("keeps the Edge public-route pinned ID in sync with the domain", () => {
    expect(pinnedSystemShopBusinessId).toBe(systemShop.businessId);
  });
});

describe("Jane's Shop provisioning", () => {
  it("creates the shop, operator, presence, agent profile and full catalogue exactly once", () => {
    const store = createCp2Store();
    const first = store.provisionSystemShop(new Date("2026-11-17T08:00:00Z"));
    expect(first).toEqual({
      status: "provisioned",
      businessId: systemShop.businessId,
      grogoniId: "grogoni.janes-shop",
      productsCreated: seedCatalogue.products.length,
      productCount: seedCatalogue.products.length
    });
    expect(store.provisionSystemShop().status).toBe("unchanged");

    const snapshot = store.snapshot();
    expect(snapshot.businesses.filter((b) => b.id === systemShop.businessId)).toEqual([
      {
        id: systemShop.businessId,
        name: "Jane's Shop",
        language: "en",
        grogoniId: "grogoni.janes-shop"
      }
    ]);
    expect(snapshot.memberships).toEqual([
      expect.objectContaining({
        businessId: systemShop.businessId,
        userId: systemShop.userId,
        role: "owner"
      })
    ]);
    expect(snapshot.accounts).toEqual([
      expect.objectContaining({ id: systemShop.accountId, status: "suspended" })
    ]);
    expect(snapshot.shopPresences).toEqual([
      expect.objectContaining({ status: "online", catalogueShareable: true })
    ]);
    const products = snapshot.products.filter((p) => p.businessId === systemShop.businessId);
    expect(products).toHaveLength(seedCatalogue.products.length);
    expect(products.every((p) => p.quantity === systemShopStockPolicy.targetQuantity)).toBe(true);
    expect(products.every((p) => typeof p.sellingPrice === "number")).toBe(true);
    expect(
      (snapshot.auditEvents ?? []).filter((e) => e.type.startsWith("system_shop.provisioned"))
    ).toHaveLength(1);
  });

  it("survives a snapshot round trip without duplicating products or resetting stock", () => {
    const store = createCp2Store();
    store.provisionSystemShop();
    const snapshot = structuredClone(store.snapshot());
    const sold = snapshot.products.find((p) => p.businessId === systemShop.businessId)!;
    sold.quantity = 42;

    const restored = createCp2Store();
    restored.hydrateSnapshot(snapshot);
    expect(restored.provisionSystemShop().status).toBe("unchanged");
    const after = restored.snapshot();
    expect(after.products).toHaveLength(seedCatalogue.products.length);
    expect(after.products.find((p) => p.id === sold.id)?.quantity).toBe(42);
  });

  it("adds catalogue products the shop is missing (a seed version bump) without touching others", () => {
    const store = createCp2Store();
    store.provisionSystemShop();
    const snapshot = structuredClone(store.snapshot());
    const missing = systemShopProductPlan()[3]!;
    snapshot.products = snapshot.products.filter((p) => p.id !== missing.id);
    const restored = createCp2Store();
    restored.hydrateSnapshot(snapshot);
    expect(restored.provisionSystemShop()).toMatchObject({ status: "updated", productsCreated: 1 });
  });

  it("keeps names and demo prices equal to the plan and takes dropped products off sale", () => {
    const store = createCp2Store();
    store.provisionSystemShop();
    const snapshot = structuredClone(store.snapshot());
    const drifted = snapshot.products.find((p) => p.id === systemShopProductPlan()[0]!.id)!;
    drifted.name = "Old name";
    drifted.sellingPrice = 1;
    drifted.quantity = 37;
    drifted.catalogueSource = { ...drifted.catalogueSource!, datasetVersion: "0.9.0" };
    snapshot.products.push({
      ...drifted,
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sku: "janes-dropped",
      name: "Dropped from seed",
      quantity: 5
    });
    const restored = createCp2Store();
    restored.hydrateSnapshot(snapshot);
    expect(restored.provisionSystemShop()).toMatchObject({ status: "updated", productsCreated: 0 });
    const after = restored.snapshot().products;
    const planned = systemShopProductPlan()[0]!;
    expect(after.find((p) => p.id === planned.id)).toMatchObject({
      name: planned.name,
      sellingPrice: planned.sellingPrice,
      quantity: 37,
      catalogueSource: { datasetVersion: seedCatalogue.version }
    });
    expect(after.find((p) => p.sku === "janes-dropped")?.quantity).toBe(0);
    const synced = restored.snapshot();
    expect(synced.auditEvents).toContainEqual(
      expect.objectContaining({
        type: "system_shop.product_synced",
        aggregateId: planned.id,
        payload: expect.objectContaining({ previousPrice: 1, sellingPrice: planned.sellingPrice })
      })
    );
    expect(synced.offlineChanges).toContainEqual(
      expect.objectContaining({
        businessId: systemShop.businessId,
        collection: "products",
        entityId: planned.id,
        entity: expect.objectContaining({ name: planned.name, sellingPrice: planned.sellingPrice })
      })
    );
    expect(
      restored
        .snapshot()
        .inventoryMovements.filter((m) => m.productId === "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        .map((m) => [m.quantityBefore, m.quantityAfter, m.reason])
    ).toEqual([[5, 0, "Removed from the marketplace catalogue"]]);
    // Off sale for good: it is no longer on the storefront and never restocked.
    expect(
      restored.listPublicStorefronts()[0]!.products.some((p) => p.name === "Dropped from seed")
    ).toBe(false);
    expect(restored.provisionSystemShop().status).toBe("unchanged");
  });

  it("restocks a planned product a sync left empty", () => {
    const store = createCp2Store();
    store.provisionSystemShop();
    const snapshot = structuredClone(store.snapshot());
    const emptied = snapshot.products.find((p) => p.id === systemShopProductPlan()[5]!.id)!;
    emptied.quantity = 0;
    const restored = createCp2Store();
    restored.hydrateSnapshot(snapshot);
    expect(restored.provisionSystemShop().status).toBe("updated");
    const after = restored.snapshot();
    expect(after.products.find((p) => p.id === emptied.id)!.quantity).toBe(
      systemShopStockPolicy.targetQuantity
    );
    expect(
      after.inventoryMovements.filter((m) => m.productId === emptied.id).map((m) => m.actorId)
    ).toEqual([systemShop.userId]);
  });

  it("refuses to provision when another shop already holds the Grogoni ID", () => {
    const store = createCp2Store();
    const snapshot = structuredClone(store.snapshot());
    snapshot.businesses.push({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Squatter",
      language: "en",
      grogoniId: "grogoni.janes-shop"
    });
    store.hydrateSnapshot(snapshot);
    expect(store.provisionSystemShop()).toEqual({
      status: "blocked",
      reason: "grogoni_id_taken",
      grogoniId: "grogoni.janes-shop"
    });
    expect(store.snapshot().products).toEqual([]);
    expect(store.snapshot().accounts).toEqual([]);
  });

  it("still installs the agent profile when no catalogue model is available", () => {
    // Regression: the profile's model check made provisioning throw, which on Edge would fail
    // every marketplace request. Found by the PostgreSQL lane (tests/system-shop-postgres.test.ts).
    const seeded = createCp2Store();
    const snapshot = structuredClone(seeded.snapshot());
    snapshot.modelCatalog = (snapshot.modelCatalog ?? []).map((model) => ({
      ...model,
      available: false
    }));
    const store = createCp2Store();
    store.hydrateSnapshot(snapshot);
    expect(store.provisionSystemShop().status).toBe("provisioned");
    expect(
      store.snapshot().agentProfiles?.find((p) => p.businessId === systemShop.businessId)?.name
    ).toBe("Grogoni Marketplace Agent");
  });

  it("gives the Marketplace Agent a policy that needs no human approval", async () => {
    const store = createCp2Store();
    store.provisionSystemShop();
    const profile = store
      .snapshot()
      .agentProfiles?.find((p) => p.businessId === systemShop.businessId);
    expect(profile).toBeDefined();
    expect(profile!.name).toBe("Grogoni Marketplace Agent");
    expect(profile!.status).toBe("active");
    expect(profile!.instructionPolicy.ownerApprovalRequiredFor).toEqual([]);
    expect(profile!.instructionPolicy.restrictedActions).toEqual([]);
    expect(profile!.instructionPolicy.catalogueModificationAllowed).toBe(true);
    expect(profile!.skillBindings.length).toBeGreaterThan(0);
    expect(
      profile!.skillBindings.every((b) => b.enabled && b.requiredConfirmationLevel === "none")
    ).toBe(true);
    expect(profile!.publicIntroduction).toContain("demo prices");
  });
});

describe("Jane's Shop in the marketplace", () => {
  it("is pinned first in the public shop list and in buyer search", async () => {
    const { app, store } = setup();
    const aardvark = await createOwnerBusiness(app, "254700009101", "Aardvark Supplies");
    await postJson(
      app,
      `/businesses/${aardvark.business.id}/products`,
      { name: "Nuvita Wafers", unit: "pkt", quantity: 3, buyingPrice: 20, sellingPrice: 30 },
      aardvark.cookie
    );

    const { storefronts } = await getJson<{ storefronts: PublicStorefrontSummary[] }>(
      app,
      "/public/storefronts?limit=24"
    );
    expect(storefronts.map((s) => s.businessName)).toEqual(["Jane's Shop", "Aardvark Supplies"]);
    expect(storefronts[0]).toMatchObject({
      pinned: true,
      operatedBy: "marketplace_agent",
      commerceAddress: expect.stringContaining("janes-shop"),
      presence: { status: "online" }
    });
    expect(storefronts[0]!.products).toHaveLength(seedCatalogue.products.length);
    expect(storefronts[1]!.pinned).toBeUndefined();
    // limit 1 still returns the pinned shop.
    const single = await getJson<{ storefronts: PublicStorefrontSummary[] }>(
      app,
      "/public/storefronts?limit=1"
    );
    expect(single.storefronts.map((s) => s.businessName)).toEqual(["Jane's Shop"]);

    const feed = await getJson<BuyFeedSummary>(app, "/buy/search?query=nuvita");
    expect(feed.results.map((r) => r.sourceLabel)).toEqual(
      expect.arrayContaining(["Jane's Shop", "Aardvark Supplies"])
    );
    expect(store.provisionSystemShop().status).toBe("unchanged");
    await app.close();
  });

  it("accepts, completes and restocks a buyer's checkout with no human action", async () => {
    const { app, store } = setup();
    const buyer = await createOwnerBusiness(app, "254700009102", "Buyer Kiosk");
    const feed = await getJson<BuyFeedSummary>(app, "/buy/search?query=nuvita", buyer.cookie);
    const wafers = feed.results.find((r) => r.sourceLabel === "Jane's Shop")!;
    const price = wafers.price!;
    expect(price).toBeGreaterThan(0);

    const checkout = await postJson<UnifiedCheckoutSummary>(
      app,
      "/buy/checkout",
      {
        items: [
          {
            sourceKind: "catalogue",
            sourceId: wafers.sourceId,
            sourceLabel: wafers.sourceLabel,
            title: wafers.title,
            quantity: 95,
            agentId: wafers.agentId,
            productId: wafers.productId
          }
        ]
      },
      buyer.cookie
    );
    expect(checkout.failures).toEqual([]);
    expect(checkout.handoffs).toEqual([
      expect.objectContaining({
        kind: "catalogue",
        sourceLabel: "Jane's Shop",
        status: "completed"
      })
    ]);

    const snapshot = store.snapshot();
    const order = snapshot.buyOrders!.find((o) => o.id === checkout.handoffs[0]!.orderId)!;
    expect(order.status).toBe("completed");
    expect(snapshot.invoices.find((i) => i.id === order.invoiceId)).toMatchObject({
      status: "confirmed",
      businessId: systemShop.businessId
    });
    // 100 - 95 = 5, at or below the threshold of 10, so the agent restocked back to 100.
    expect(snapshot.products.find((p) => p.id === wafers.productId)!.quantity).toBe(100);
    const movements = snapshot.inventoryMovements.filter((m) => m.productId === wafers.productId);
    expect(movements.map((m) => [m.type, m.quantityBefore, m.quantityAfter, m.actorId])).toEqual([
      ["sale", 100, 5, systemShop.userId],
      ["manual_adjustment", 5, 100, systemShop.userId]
    ]);
    const auditTypes = (snapshot.auditEvents ?? []).map((e) => e.type);
    expect(auditTypes).toContain("system_shop.order_completed");

    const reread = await getJson<UnifiedCheckoutSummary>(
      app,
      `/buy/checkouts/${checkout.id}`,
      buyer.cookie
    );
    expect(reread.handoffs[0]!.status).toBe("completed");
    await app.close();
  });

  it("does not restock above the threshold and leaves other shops' orders untouched", async () => {
    const { app, store } = setup();
    const seller = await createOwnerBusiness(app, "254700009103", "Ordinary Shop");
    await postJson(
      app,
      `/businesses/${seller.business.id}/products`,
      { name: "Zebra pens", unit: "pc", quantity: 10, buyingPrice: 5, sellingPrice: 10 },
      seller.cookie
    );
    const buyer = await createOwnerBusiness(app, "254700009104", "Second Buyer");
    const feed = await getJson<BuyFeedSummary>(app, "/buy/search?query=", buyer.cookie);
    const jane = feed.results.find((r) => r.sourceLabel === "Jane's Shop")!;
    const pens = feed.results.find((r) => r.title === "Zebra pens")!;
    const checkout = await postJson<UnifiedCheckoutSummary>(
      app,
      "/buy/checkout",
      {
        items: [jane, pens].map((r) => ({
          sourceKind: "catalogue",
          sourceId: r.sourceId,
          sourceLabel: r.sourceLabel,
          title: r.title,
          quantity: 2,
          agentId: r.agentId,
          productId: r.productId
        }))
      },
      buyer.cookie
    );
    const statuses = Object.fromEntries(checkout.handoffs.map((h) => [h.sourceLabel, h.status]));
    expect(statuses).toEqual({ "Jane's Shop": "completed", "Ordinary Shop": "requested" });
    expect(store.snapshot().products.find((p) => p.id === jane.productId)!.quantity).toBe(98);
    await app.close();
  });

  it("completes a storefront visitor's order and answers chat through the shop agent", async () => {
    const provider = {
      name: "test-provider",
      complete: async () => ({
        provider: "test-provider",
        status: "available" as const,
        outputText: JSON.stringify({
          type: "response",
          message: "Yes, Nuvita Wafers are in stock at Jane's Shop."
        }),
        durationMs: 1,
        errorCode: null,
        metadata: {}
      })
    };
    const store = createCp2Store({ runtimeModelProvider: provider });
    store.provisionSystemShop();
    const app = buildApi({ cp2: { store } });
    const session = await postJson<{ conversationId: string; capabilityToken: string }>(
      app,
      "/public/storefronts/grogoni.janes-shop/sessions",
      { visitorId: "visitor-jane-1" }
    );
    const message = await postJson<{ agentReply: { author: string; body: string } | null }>(
      app,
      "/public/storefronts/grogoni.janes-shop/messages",
      { capabilityToken: session.capabilityToken, body: "Do you have wafers?", attachmentNames: [] }
    );
    expect(message.agentReply).toMatchObject({ author: "agent" });

    const productId = systemShopProductId("nuvita-wafers");
    const order = await postJson<{ status: string; invoiceId: string }>(
      app,
      "/public/storefronts/grogoni.janes-shop/orders",
      {
        capabilityToken: session.capabilityToken,
        customerName: "Visitor",
        phone: "+254700009105",
        note: null,
        items: [{ productId, quantity: 3 }]
      }
    );
    expect(order.status).toBe("completed");
    const snapshot = store.snapshot();
    expect(snapshot.invoices.find((i) => i.id === order.invoiceId)!.status).toBe("confirmed");
    expect(snapshot.products.find((p) => p.id === productId)!.quantity).toBe(97);
    await app.close();
  });
});

describe("copying Jane's Shop catalogue", () => {
  it("is listed first, shows no demo prices, and copies without prices, stock or duplicates", async () => {
    const { app, store } = setup();
    const owner = await createOwnerBusiness(app, "254700009106", "Copycat Duka");
    const base = `/businesses/${owner.business.id}/catalogue-marketplace/shops`;
    const shops = await getJson<ShareableCatalogueSummary[]>(app, base, owner.cookie);
    expect(shops[0]).toMatchObject({
      businessId: systemShop.businessId,
      businessName: "Jane's Shop",
      pinned: true,
      operatedBy: "marketplace_agent",
      productCount: seedCatalogue.products.length
    });
    expect(shops[1]?.sourceKind).toBe("seed");

    const products = await getJson<ShareableCatalogueProductSummary[]>(
      app,
      `${base}/${systemShop.businessId}/products`,
      owner.cookie
    );
    expect(products).toHaveLength(seedCatalogue.products.length);
    expect(products.every((p) => p.sellingPrice === null)).toBe(true);

    const firstBatch = products.slice(0, 50).map((p) => p.id);
    const copied = await postJson<ProductSummary[]>(
      app,
      `${base}/${systemShop.businessId}/duplicate`,
      { productIds: firstBatch },
      owner.cookie
    );
    expect(copied).toHaveLength(50);
    expect(copied.every((p) => p.businessId === owner.business.id)).toBe(true);
    expect(copied.every((p) => p.sellingPrice === null && p.quantity === 0)).toBe(true);
    expect(copied.every((p) => p.catalogueSource?.datasetId === seedCatalogue.id)).toBe(true);

    // The whole catalogue, in the UI's batches of 50, after a partial first copy.
    for (let index = 0; index < products.length; index += 50) {
      await postJson(
        app,
        `${base}/${systemShop.businessId}/duplicate`,
        { productIds: products.slice(index, index + 50).map((p) => p.id) },
        owner.cookie
      );
    }
    const own = store.snapshot().products.filter((p) => p.businessId === owner.business.id);
    expect(own).toHaveLength(seedCatalogue.products.length);
    // Copying the seed starter dataset afterwards reuses the same products.
    await postJson(
      app,
      `${base}/${encodeURIComponent(`dataset:${seedCatalogue.id}`)}/duplicate`,
      { productIds: [seedCatalogue.products[0]!.id] },
      owner.cookie
    );
    expect(
      store.snapshot().products.filter((p) => p.businessId === owner.business.id)
    ).toHaveLength(seedCatalogue.products.length);
    // Jane's Shop itself is unchanged by being copied.
    expect(
      store.snapshot().products.filter((p) => p.businessId === systemShop.businessId)
    ).toHaveLength(seedCatalogue.products.length);
    await app.close();
  });

  it("is listed and copyable from the seed plan even where the shop's records are not loaded", async () => {
    // Edge catalogue requests never load Jane's Shop; this store has none, but the deployment
    // knows it is provisioned (as Edge does after ensureSystemShop).
    const store = createCp2Store({ systemShopProvisioned: true });
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "254700009110", "Edge-like Duka");
    const base = `/businesses/${owner.business.id}/catalogue-marketplace/shops`;
    const shops = await getJson<ShareableCatalogueSummary[]>(app, base, owner.cookie);
    expect(shops[0]).toMatchObject({ businessId: systemShop.businessId, pinned: true });
    const page = await getJson<ShareableCatalogueProductSummary[]>(
      app,
      `${base}/${systemShop.businessId}/products?limit=2&offset=1`,
      owner.cookie
    );
    expect(page.map((p) => p.id)).toEqual(
      systemShopProductPlan()
        .slice(1, 3)
        .map((p) => p.id)
    );
    const copied = await postJson<ProductSummary[]>(
      app,
      `${base}/${systemShop.businessId}/duplicate`,
      { productIds: page.map((p) => p.id) },
      owner.cookie
    );
    expect(copied.map((p) => p.catalogueSource?.sourceProductId)).toEqual(
      systemShopProductPlan()
        .slice(1, 3)
        .map((p) => p.sourceProductId)
    );
    const unknown = await app.inject({
      method: "POST",
      url: `${base}/${systemShop.businessId}/duplicate`,
      headers: { "content-type": "application/json", cookie: owner.cookie },
      payload: JSON.stringify({ productIds: ["not-a-jane-product"] })
    });
    expect(unknown.statusCode).toBe(404);
    // A search for one of its products still finds the shop.
    const searched = await getJson<ShareableCatalogueSummary[]>(
      app,
      `${base}?search=nuvita`,
      owner.cookie
    );
    expect(searched[0]?.businessId).toBe(systemShop.businessId);
    await app.close();
  });

  it("rejects more than 50 products per request", async () => {
    const { app } = setup();
    const owner = await createOwnerBusiness(app, "254700009107", "Greedy Duka");
    const ids = systemShopProductPlan()
      .slice(0, 51)
      .map((p) => p.id);
    const response = await app.inject({
      method: "POST",
      url: `/businesses/${owner.business.id}/catalogue-marketplace/shops/${systemShop.businessId}/duplicate`,
      headers: { "content-type": "application/json", cookie: owner.cookie },
      payload: JSON.stringify({ productIds: ids })
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe("Jane's Shop has no human operator", () => {
  it("cannot be signed in to, and other accounts cannot manage it", async () => {
    const { app, store } = setup();
    expect(() =>
      store.continueWithChannelPin({
        channel: "email",
        destination: systemShop.operatorDestination,
        pin: "3927"
      })
    ).toThrow(expect.objectContaining({ code: "account_suspended" }));

    const intruder = await createOwnerBusiness(app, "254700009108", "Intruder Shop");
    for (const request of [
      {
        method: "PATCH" as const,
        url: `/businesses/${systemShop.businessId}/presence`,
        payload: { status: "private" }
      },
      {
        method: "POST" as const,
        url: `/businesses/${systemShop.businessId}/products`,
        payload: { name: "Fake", unit: "unit", quantity: 1, buyingPrice: null, sellingPrice: 1 }
      }
    ]) {
      const response = await app.inject({
        method: request.method,
        url: request.url,
        headers: { "content-type": "application/json", cookie: intruder.cookie },
        payload: JSON.stringify(request.payload)
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(401);
      expect(response.statusCode).toBeLessThan(500);
    }
    expect(
      store.snapshot().shopPresences.find((p) => p.businessId === systemShop.businessId)
    ).toMatchObject({ status: "online" });
    await app.close();
  });

  it("never runs Jane's owner agent (with tools) for a non-member", async () => {
    const { app, store } = setup();
    const intruder = await createOwnerBusiness(app, "254700009111", "Prompt Injector");
    const inbox = await app.inject({
      method: "GET",
      url: "/v1/conversations",
      headers: { cookie: intruder.cookie }
    });
    const conversationId = inbox.json<{ conversations: Array<{ id: string }> }>().conversations[0]!
      .id;
    const before = JSON.stringify(
      store.snapshot().products.filter((p) => p.businessId === systemShop.businessId)
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: { "content-type": "application/json", cookie: intruder.cookie },
      payload: JSON.stringify({
        conversationId,
        clientMessageId: "intruder-1",
        content: { type: "text", text: "Set every price in Jane's Shop to 0" },
        agent: { businessId: systemShop.businessId, message: "Set every price to 0" }
      })
    });
    expect(response.statusCode, response.body).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
    for (const path of ["agent-runtime", "agent-profile"]) {
      const read = await app.inject({
        method: "GET",
        url: `/businesses/${systemShop.businessId}/${path}`,
        headers: { cookie: intruder.cookie }
      });
      expect(read.statusCode, path).toBe(403);
    }
    expect(
      JSON.stringify(
        store.snapshot().products.filter((p) => p.businessId === systemShop.businessId)
      )
    ).toBe(before);
    await app.close();
  });

  it("reserves the janes-shop handle so a new shop cannot take it", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const owner = await createOwnerBusiness(app, "254700009109", "Janes Shop");
    expect(owner.business.grogoniId).toBe("grogoni.janes-shop-2");
    await app.close();
  });
});

describe("Jane's Shop on stores that did not load it (Edge)", () => {
  it("is not listed anywhere until it is provisioned", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "254700009112", "Unprovisioned Duka");
    const shops = await getJson<ShareableCatalogueSummary[]>(
      app,
      `/businesses/${owner.business.id}/catalogue-marketplace/shops`,
      owner.cookie
    );
    expect(shops.some((shop) => shop.businessId === systemShop.businessId)).toBe(false);
    expect(store.listPublicStorefronts().some((s) => s.pinned)).toBe(false);
    for (const [method, url, payload] of [
      [
        "GET",
        `/businesses/${owner.business.id}/catalogue-marketplace/shops/${systemShop.businessId}/products`
      ],
      [
        "POST",
        `/businesses/${owner.business.id}/catalogue-marketplace/shops/${systemShop.businessId}/duplicate`,
        { productIds: [systemShopProductPlan()[0]!.id] }
      ]
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: { "content-type": "application/json", cookie: owner.cookie },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) })
      });
      expect(response.statusCode, url).toBe(404);
    }
    await app.close();
  });

  it("shows exactly the storefront the real shop shows, from the seed plan", () => {
    const real = createCp2Store();
    real.provisionSystemShop();
    const virtual = createCp2Store({ systemShopProvisioned: true });
    const strip = (s: PublicStorefrontSummary) => ({
      ...s,
      presence: { status: s.presence.status }
    });
    expect(strip(virtual.listPublicStorefronts()[0]!)).toEqual(
      strip(real.listPublicStorefronts()[0]!)
    );
    // Search works on the plan too, and a loaded real shop is never listed twice.
    expect(virtual.listPublicStorefronts({ search: "nuvita" })[0]?.businessName).toBe(
      "Jane's Shop"
    );
    const both = createCp2Store({ systemShopProvisioned: true });
    both.provisionSystemShop();
    expect(both.listPublicStorefronts().filter((s) => s.pinned)).toHaveLength(1);
  });

  it("lets a buyer find and buy from the plan storefront", async () => {
    const store = createCp2Store({ systemShopProvisioned: true });
    const app = buildApi({ cp2: { store } });
    const buyer = await createOwnerBusiness(app, "254700009113", "Plan Buyer");
    const feed = await getJson<BuyFeedSummary>(app, "/buy/search?query=nuvita", buyer.cookie);
    const wafers = feed.results.find((r) => r.sourceLabel === "Jane's Shop")!;
    expect(wafers).toMatchObject({
      agentId: systemShop.grogoniId,
      productId: systemShopProductId("nuvita-wafers")
    });
    // On Edge the checkout request then loads the real shop by agent ID; here, provision it.
    store.provisionSystemShop();
    const checkout = await postJson<UnifiedCheckoutSummary>(
      app,
      "/buy/checkout",
      {
        items: [
          {
            sourceKind: "catalogue",
            sourceId: wafers.sourceId,
            sourceLabel: wafers.sourceLabel,
            title: wafers.title,
            quantity: 1,
            agentId: wafers.agentId,
            productId: wafers.productId
          }
        ]
      },
      buyer.cookie
    );
    expect(checkout.handoffs[0]?.status).toBe("completed");
    await app.close();
  });
});

describe("Edge buyer assistant plan rows", () => {
  it("quotes from the plan at guaranteed stock and never persists those rows", () => {
    const planned = systemShopProductPlan()[0]!;
    const records = systemShopPlanRecordsFor([planned.id, "not-jane"]);
    expect(records.businesses.map((b) => b.id)).toEqual([systemShop.businessId]);
    expect(records.products).toEqual([
      expect.objectContaining({
        id: planned.id,
        sellingPrice: planned.sellingPrice,
        quantity: systemShopStockPolicy.restockThreshold + 1
      })
    ]);
    expect(systemShopPlanRecordsFor([])).toEqual({ businesses: [], products: [] });

    const base = createCp2Store().snapshot();
    const next = {
      ...base,
      businesses: [...base.businesses, ...records.businesses],
      products: [...base.products, ...records.products]
    };
    const stripped = stripSystemShopPlanRecords(next, base);
    expect(stripped.businesses).toEqual(base.businesses);
    expect(stripped.products).toEqual(base.products);
    // Rows that really were loaded are kept.
    const real = createCp2Store();
    real.provisionSystemShop();
    const loaded = real.snapshot();
    expect(stripSystemShopPlanRecords(loaded, loaded).products).toHaveLength(
      loaded.products.length
    );
  });
});

describe("Jane's Shop daily demo order cap", () => {
  it("refuses a buyer's 21st order in 24 hours and leaves other shops alone", () => {
    const store = createCp2Store();
    store.provisionSystemShop();
    const buyer = store.continueWithChannelPin({
      channel: "email",
      destination: "cap-buyer@example.invalid",
      pin: "3927"
    });
    const productId = systemShopProductId("nuvita-wafers");
    const order = (now: Date) =>
      store.createUnifiedCheckout({
        sessionId: buyer.session.id,
        now,
        items: [
          {
            sourceKind: "catalogue",
            sourceId: systemShop.grogoniId,
            sourceLabel: "Jane's Shop",
            title: "Nuvita Wafers",
            quantity: 1,
            agentId: systemShop.grogoniId,
            productId
          }
        ]
      });
    const start = new Date("2026-11-17T08:00:00Z");
    for (let i = 0; i < systemShopStockPolicy.dailyOrdersPerBuyer; i += 1)
      expect(order(new Date(start.getTime() + i * 1000)).handoffs[0]?.status).toBe("completed");
    const refused = order(new Date(start.getTime() + 60_000));
    expect(refused.handoffs).toEqual([]);
    expect(refused.failures[0]?.reason).toContain("demo orders per buyer each day");
  });

  it("counts a rolling 24-hour window and never refuses other shops", () => {
    const seen: Date[] = [];
    let count = 20;
    const domain = new SystemShopDomain({
      countRecentOrders: ({ since }) => {
        seen.push(since);
        return count;
      }
    } as unknown as ConstructorParameters<typeof SystemShopDomain>[0]);
    const now = new Date("2026-11-17T12:00:00Z");
    expect(
      domain.orderRefusal({ businessId: systemShop.businessId, buyerAccountId: "a", lines: 1, now })
    ).toContain("20 demo orders");
    expect(seen[0]!.toISOString()).toBe("2026-11-16T12:00:00.000Z");
    count = 19;
    expect(
      domain.orderRefusal({ businessId: systemShop.businessId, visitorId: "v", lines: 1, now })
    ).toBeNull();
    count = 1000;
    expect(
      domain.orderRefusal({ businessId: "ordinary-shop", buyerAccountId: "a", lines: 1, now })
    ).toBeNull();
  });

  it("caps the whole shop per day and the lines per order, whoever orders", () => {
    let everyone = 0;
    const domain = new SystemShopDomain({
      countRecentOrders: (input: { buyerAccountId?: string; visitorId?: string }) =>
        input.buyerAccountId === undefined && input.visitorId === undefined ? everyone : 0
    } as unknown as ConstructorParameters<typeof SystemShopDomain>[0]);
    const now = new Date();
    const ask = (lines: number) =>
      domain.orderRefusal({ businessId: systemShop.businessId, visitorId: "fresh-id", lines, now });
    expect(ask(systemShopStockPolicy.maximumOrderLines)).toBeNull();
    expect(ask(systemShopStockPolicy.maximumOrderLines + 1)).toContain("products per demo order");
    everyone = systemShopStockPolicy.dailyOrdersShopWide;
    // A brand-new visitor ID does not get around the shop-wide cap.
    expect(ask(1)).toContain("taken all its demo orders for today");
  });

  it("refuses an 11-line checkout as a per-item failure", () => {
    const store = createCp2Store();
    store.provisionSystemShop();
    const buyer = store.continueWithChannelPin({
      channel: "email",
      destination: "lines-buyer@example.invalid",
      pin: "3927"
    });
    const checkout = store.createUnifiedCheckout({
      sessionId: buyer.session.id,
      items: systemShopProductPlan()
        .slice(0, 11)
        .map((planned) => ({
          sourceKind: "catalogue" as const,
          sourceId: systemShop.grogoniId,
          sourceLabel: "Jane's Shop",
          title: planned.name,
          quantity: 1,
          agentId: systemShop.grogoniId,
          productId: planned.id
        }))
    });
    expect(checkout.handoffs).toEqual([]);
    expect(checkout.failures).toHaveLength(11);
    expect(checkout.failures[0]?.reason).toContain("10 products per demo order");
  });

  it("refuses a storefront visitor's 21st order with 429", async () => {
    const { app } = setup();
    const session = await postJson<{ capabilityToken: string }>(
      app,
      "/public/storefronts/grogoni.janes-shop/sessions",
      { visitorId: "visitor-cap" }
    );
    const place = () =>
      app.inject({
        method: "POST",
        url: "/public/storefronts/grogoni.janes-shop/orders",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          capabilityToken: session.capabilityToken,
          customerName: "Visitor",
          phone: "+254700009114",
          note: null,
          items: [{ productId: systemShopProductId("nuvita-wafers"), quantity: 1 }]
        })
      });
    for (let i = 0; i < systemShopStockPolicy.dailyOrdersPerBuyer; i += 1)
      expect((await place()).statusCode).toBe(200);
    const refused = await place();
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: "order_limit_reached" });
    await app.close();
  });
});

describe("Jane's Shop history retention", () => {
  it("keeps storefront journal entries and audit events flat over several days", () => {
    const store = createCp2Store();
    const start = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    store.provisionSystemShop(start);
    const counts: Array<[number, number]> = [];
    for (let day = 0; day < 7; day += 1) {
      const now = new Date(start.getTime() + day * 24 * 60 * 60 * 1000);
      const session = store.createPublicStorefrontSession({
        agentId: systemShop.grogoniId,
        visitorId: "retention-visitor",
        now
      });
      for (let n = 0; n < 4; n += 1) {
        store.createPublicOrder({
          agentId: systemShop.grogoniId,
          capabilityToken: session.capabilityToken,
          customerName: `Visitor day ${day}`,
          phone: "+254700009114",
          note: null,
          items: [{ productId: systemShopProductId("nuvita-wafers"), quantity: 1 }],
          now
        });
      }
      const snapshot = store.snapshot();
      counts.push([
        (snapshot.offlineChanges ?? []).filter(
          (c) => c.businessId === systemShop.businessId && c.collection === "orders"
        ).length,
        snapshot.auditEvents.filter(
          (e) => e.actorId === systemShop.userId || e.payload.businessId === systemShop.businessId
        ).length
      ]);
      if (day >= 2) {
        expect(JSON.stringify(snapshot.offlineChanges)).not.toContain(`Visitor day ${day - 2}`);
      }
    }
    expect(counts.slice(3).map(([orders]) => orders)).toEqual([8, 8, 8, 8]);
    expect(
      Math.max(...counts.slice(3).map(([, events]) => events)) -
        Math.min(...counts.slice(3).map(([, events]) => events))
    ).toBeLessThanOrEqual(4);
  });

  it("deletes settled demo orders older than the window and keeps everything else", () => {
    const store = createCp2Store();
    store.provisionSystemShop();
    const ordinary = store.continueWithChannelPin({
      channel: "email",
      destination: "retention-owner@example.invalid",
      pin: "3927"
    });
    const buyer = store.continueWithChannelPin({
      channel: "email",
      destination: "retention-buyer@example.invalid",
      pin: "3927"
    });
    const wafers = systemShopProductId("nuvita-wafers");
    const order = (now: Date, quantity = 1) =>
      store.createUnifiedCheckout({
        sessionId: buyer.session.id,
        now,
        items: [
          {
            sourceKind: "catalogue",
            sourceId: systemShop.grogoniId,
            sourceLabel: "Jane's Shop",
            title: "Nuvita Wafers",
            quantity,
            agentId: systemShop.grogoniId,
            productId: wafers
          }
        ]
      });
    const t0 = new Date(Date.now() - 30 * 60 * 60 * 1000);
    const old = order(t0, 95); // sale + restock movements
    const oldOrderId = old.handoffs[0]!.orderId;
    const oldInvoiceId = store.snapshot().buyOrders!.find((o) => o.id === oldOrderId)!.invoiceId;
    void ordinary;

    const fresh = order(new Date());
    const snapshot = store.snapshot();
    expect(snapshot.buyOrders!.map((o) => o.id)).toEqual([fresh.handoffs[0]!.orderId]);
    expect(snapshot.invoices.some((i) => i.id === oldInvoiceId)).toBe(false);
    const movements = snapshot.inventoryMovements.filter((m) => m.productId === wafers);
    expect(movements.map((m) => m.type)).toEqual(["sale"]);
    // The shop has no devices: one offline change per product survives, none for pruned invoices.
    const changes = (snapshot.offlineChanges ?? []).filter(
      (c) => c.businessId === systemShop.businessId
    );
    expect(changes.filter((c) => c.entityId === wafers)).toHaveLength(1);
    expect(changes.some((c) => c.entityId === oldInvoiceId)).toBe(false);
    expect((snapshot.auditEvents ?? []).some((e) => e.type === "system_shop.history_pruned")).toBe(
      true
    );
    // The buyer's own checkout record still shows the pruned order as completed.
    expect(
      store.getUnifiedCheckout({ sessionId: buyer.session.id, unifiedCheckoutId: old.id })
        .handoffs[0]?.status
    ).toBe("completed");
    // Stock is unaffected by retention.
    expect(snapshot.products.find((p) => p.id === wafers)!.quantity).toBe(99);
  });
});

describe("Jane's Shop order outcomes", () => {
  function domainWith(confirm: () => void, status: () => string | undefined) {
    const orders: Array<{ status: string }> = [];
    const events: string[] = [];
    const domain = new SystemShopDomain({
      businesses: new Map(),
      products: new Map(),
      productsForBusiness: () => [],
      grogoniIdTakenByAnotherShop: () => false,
      installOperator: () => {},
      storedShopPresence: () => undefined,
      setShopPresence: () => {},
      hasAgentProfile: () => true,
      installAgentProfile: () => {},
      confirmInvoice: confirm,
      invoiceStatus: status,
      countRecentOrders: () => 0,
      restockProduct: () => {},
      setBuyOrder: (order) => orders.push(order),
      pruneHistory: () => 0,
      setPublicOrderStatus: () => {
        throw new Error("unused");
      },
      recordAuditEvent: (event) => events.push(event.type)
    });
    const outcomes = domain.completeBuyOrders(
      [
        {
          id: "order-1",
          businessId: systemShop.businessId,
          buyerAccountId: "buyer",
          invoiceId: "invoice-1",
          items: [],
          status: "requested",
          createdAt: "",
          updatedAt: ""
        },
        {
          id: "order-2",
          businessId: "someone-else",
          buyerAccountId: "buyer",
          invoiceId: "invoice-2",
          items: [],
          status: "requested",
          createdAt: "",
          updatedAt: ""
        }
      ],
      new Date()
    );
    return { outcomes, orders, events };
  }

  it("completes an order whose invoice confirmed even if a later hook threw", () => {
    let status = "draft";
    const { outcomes, events } = domainWith(
      () => {
        status = "confirmed";
        throw new Error("fulfillment intake listener failed");
      },
      () => status
    );
    expect(outcomes).toEqual([
      { orderId: "order-1", status: "completed", restockedProductIds: [] }
    ]);
    expect(events).toEqual(["system_shop.order_completed"]);
  });

  it("rejects an order whose invoice could not be confirmed, and ignores other shops", () => {
    const { outcomes, orders, events } = domainWith(
      () => {
        throw Object.assign(new Error("stock"), { code: "stock_insufficient" });
      },
      () => "draft"
    );
    expect(outcomes).toEqual([
      { orderId: "order-1", status: "rejected", reason: "invoice_confirmation_failed" }
    ]);
    expect(orders.map((o) => o.status)).toEqual(["rejected"]);
    expect(events).toEqual(["system_shop.order_rejected"]);
  });
});

function setup() {
  const store = createCp2Store();
  store.provisionSystemShop();
  return { store, app: buildApi({ cp2: { store } }) };
}

async function createOwnerBusiness(
  app: ReturnType<typeof buildApi>,
  destination: string,
  name: string
) {
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ method: "phone", contact: destination, pin: "3927" })
  });
  expect(signup.statusCode, signup.body).toBe(200);
  const header = signup.headers["set-cookie"];
  const cookie = String(Array.isArray(header) ? header[0] : header).split(";")[0] ?? "";
  const result = await postJson<{ business: { id: string; grogoniId: string } }>(
    app,
    "/businesses",
    { name, language: "en" },
    cookie
  );
  return { business: result.business, cookie };
}

async function postJson<T>(
  app: ReturnType<typeof buildApi>,
  url: string,
  payload: unknown,
  cookie?: string
): Promise<T> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    payload: JSON.stringify(payload)
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}

async function getJson<T>(
  app: ReturnType<typeof buildApi>,
  url: string,
  cookie?: string
): Promise<T> {
  const response = await app.inject({ method: "GET", url, headers: cookie ? { cookie } : {} });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}
