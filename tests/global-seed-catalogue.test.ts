import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import {
  seedCatalogue,
  seedCatalogueSourceId
} from "../services/api/src/cp2/domains/catalogue-sharing/seed-catalogue";
import { validateRuntimeToolInput, runtimeToolRegistry } from "../packages/tool-core/src/index";

function fixture(options: Parameters<typeof createCp2Store>[0] = {}) {
  const store = createCp2Store(options);
  const owner = store.signupWithPhonePin({ destination: "+254712346791", pin: "3927" });
  const business = store.createBusiness({
    sessionId: owner.session.id,
    name: "Seed test shop",
    language: "en"
  }).business;
  const context = { sessionId: owner.session.id, viewerBusinessId: business.id };
  return { store, owner, business, context };
}

describe("global starter catalogue", () => {
  it("bundles the canonical release without shop-owned state or sample prices", async () => {
    const source = JSON.parse(
      await readFile(new URL("../data/kenyan-commerce/v1/catalog.json", import.meta.url), "utf8")
    );
    expect(seedCatalogue.products).toHaveLength(713);
    expect(seedCatalogue.products.map((p) => [p.id, p.name])).toEqual(
      source.products.map((p: { id: string; name: string }) => [p.id, p.name])
    );
    expect(seedCatalogue.sourceWorkbookSha256).toBe(source.dataset.sourceWorkbookSha256);
  });

  it("discovers and searches all products independently of any source shop", () => {
    const { store, context } = fixture();
    expect(store.listShareableCatalogues({ ...context, search: "kenyan" })).toEqual([
      expect.objectContaining({
        businessId: seedCatalogueSourceId,
        sourceKind: "seed",
        productCount: 713
      })
    ]);
    expect(store.listShareableCatalogues({ ...context, search: "Colgate" })[0]?.businessId).toBe(
      seedCatalogueSourceId
    );
    const first = store.listShareableCatalogueProducts({
      ...context,
      sourceBusinessId: seedCatalogueSourceId,
      limit: 10
    });
    const next = store.listShareableCatalogueProducts({
      ...context,
      sourceBusinessId: seedCatalogueSourceId,
      offset: 10,
      limit: 10
    });
    expect(first).toHaveLength(10);
    expect(next).toHaveLength(10);
    expect(new Set([...first, ...next].map((p) => p.id)).size).toBe(20);
    const found = store.listShareableCatalogueProducts({
      ...context,
      sourceBusinessId: seedCatalogueSourceId,
      search: "colgate"
    });
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((p) => p.name.toLowerCase().includes("colgate"))).toBe(true);
    expect(
      store.listShareableCatalogueProducts({
        ...context,
        sourceBusinessId: seedCatalogueSourceId,
        search: "no-such-product-xyz"
      })
    ).toEqual([]);
  });

  it("imports with zero stock, unknown prices, durable provenance and repeat protection", () => {
    const { store, context, business } = fixture();
    const ids = seedCatalogue.products.slice(0, 2).map((p) => p.id);
    const created = store.duplicateCatalogueProducts({
      ...context,
      sourceBusinessId: seedCatalogueSourceId,
      productIds: ids
    });
    for (const [index, product] of created.entries())
      expect(product).toMatchObject({
        businessId: business.id,
        quantity: 0,
        buyingPrice: null,
        sellingPrice: null,
        catalogueSource: {
          datasetId: seedCatalogue.id,
          datasetVersion: seedCatalogue.version,
          sourceProductId: ids[index]
        }
      });
    store.updateProduct({
      sessionId: context.sessionId,
      businessId: business.id,
      productId: created[0]!.id,
      product: { name: "Owner-reviewed biscuits", unit: "packet", quantity: 12, sellingPrice: 150 }
    });
    const restored = createCp2Store();
    restored.hydrateSnapshot(store.snapshot());
    const repeated = restored.duplicateCatalogueProducts({
      ...context,
      sourceBusinessId: seedCatalogueSourceId,
      productIds: ids
    });
    expect(repeated.map((p) => p.id)).toEqual(created.map((p) => p.id));
    expect(repeated[0]).toMatchObject({
      name: "Owner-reviewed biscuits",
      unit: "packet",
      quantity: 12,
      sellingPrice: 150
    });
    expect(
      restored.listProducts({ sessionId: context.sessionId, businessId: business.id })
    ).toHaveLength(2);
    expect(
      restored.snapshot().auditEvents.some((e) => e.type === "catalogue.seed_products_imported")
    ).toBe(true);
    expect(seedCatalogue.products).toHaveLength(713);
  });

  it("validates the whole selection before writing and preserves tenant authorization", () => {
    const { store, context, business } = fixture();
    const stranger = store.signupWithPhonePin({ destination: "+254712346792", pin: "3927" });
    for (const productIds of [
      [],
      Array(51).fill(seedCatalogue.products[0]!.id),
      [seedCatalogue.products[0]!.id, "invented"]
    ])
      expect(() =>
        store.duplicateCatalogueProducts({
          ...context,
          sourceBusinessId: seedCatalogueSourceId,
          productIds
        })
      ).toThrow();
    expect(() =>
      store.listShareableCatalogueProducts({
        ...context,
        sessionId: stranger.session.id,
        sourceBusinessId: seedCatalogueSourceId
      })
    ).toThrow();
    expect(() =>
      store.duplicateCatalogueProducts({
        ...context,
        sessionId: stranger.session.id,
        sourceBusinessId: seedCatalogueSourceId,
        productIds: [seedCatalogue.products[0]!.id]
      })
    ).toThrow();
    expect(() => store.listShareableCatalogues({ ...context, sessionId: null })).toThrow();
    expect(
      store.listProducts({ sessionId: context.sessionId, businessId: business.id })
    ).toHaveLength(0);
  });

  it("exposes search and import through the existing authenticated HTTP surface", async () => {
    const { store, context, business } = fixture();
    const app = buildApi({ cp2: { store } });
    try {
      const headers = { cookie: `grogoni_session=${context.sessionId}` };
      const path = `/businesses/${business.id}/catalogue-marketplace/shops/${encodeURIComponent(seedCatalogueSourceId)}`;
      const found = await app.inject({
        method: "GET",
        url: path + "/products?search=colgate&limit=1",
        headers
      });
      expect(found.statusCode).toBe(200);
      expect(found.json()).toHaveLength(1);
      const imported = await app.inject({
        method: "POST",
        url: path + "/duplicate",
        headers,
        payload: { productIds: [found.json()[0].id] }
      });
      expect(imported.statusCode).toBe(200);
      expect(imported.json()[0]).toMatchObject({
        quantity: 0,
        buyingPrice: null,
        sellingPrice: null
      });
      const denied = await app.inject({
        method: "POST",
        url: path + "/duplicate",
        payload: { productIds: [found.json()[0].id] }
      });
      expect(denied.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("lets the store agent discover, read and import the dataset only after confirmation", async () => {
    let proposal: Record<string, unknown> = {
      type: "tool",
      toolName: "catalogue.marketplace.search",
      input: { search: "kenyan" },
      reason: "Find starter data"
    };
    const { store, context, business } = fixture({
      runtimeModelProvider: {
        name: "seed-catalogue-test",
        async complete() {
          return {
            provider: "seed-catalogue-test",
            status: "available",
            outputText: JSON.stringify(proposal),
            durationMs: 1,
            errorCode: null,
            metadata: {}
          };
        }
      }
    });
    const run = (message: string) =>
      store.createRuntimeTurn({ sessionId: context.sessionId, businessId: business.id, message });
    const search = await run("Find a shared starter catalogue for me");
    expect(search.turn.status, JSON.stringify(search.turn.verification)).toBe("completed");
    expect(search.turn.toolResult).toEqual([
      expect.objectContaining({ businessId: seedCatalogueSourceId })
    ]);
    proposal = {
      type: "tool",
      toolName: "catalogue.marketplace.products",
      input: { sourceBusinessId: seedCatalogueSourceId },
      reason: "Inspect starter data"
    };
    const read = await run("Inspect the starter catalogue selections");
    expect(read.turn.status, JSON.stringify(read.turn.verification)).toBe("completed");
    expect(read.turn.toolResult).toHaveLength(50);
    proposal = {
      type: "tool",
      toolName: "catalogue.marketplace.import",
      input: {
        sourceBusinessId: seedCatalogueSourceId,
        productIds: [seedCatalogue.products[0]!.id]
      },
      reason: "Import reviewed starter product"
    };
    const pending = await run("Prepopulate my inventory from that starter catalogue");
    expect(pending.turn.status, JSON.stringify(pending.turn.verification)).toBe(
      "needs_confirmation"
    );
    expect(
      store.listProducts({ sessionId: context.sessionId, businessId: business.id })
    ).toHaveLength(0);
    const confirmed = await store.createRuntimeTurn({
      sessionId: context.sessionId,
      businessId: business.id,
      runtimeSessionId: pending.session.id,
      confirmationToken: pending.turn.plan.confirmationToken!,
      message: "confirm"
    });
    expect(confirmed.turn.status, JSON.stringify(confirmed.turn.verification)).toBe("completed");
    expect(
      store.listProducts({ sessionId: context.sessionId, businessId: business.id })[0]
    ).toMatchObject({ quantity: 0, catalogueSource: { datasetId: seedCatalogue.id } });
  });

  it("bounds agent reads and retains confirmation for inventory imports", () => {
    expect(runtimeToolRegistry["catalogue.marketplace.import"].requiresConfirmation).toBe(true);
    for (const args of [
      { limit: 0 },
      { limit: 101 },
      { offset: -1 },
      { offset: 0.1 },
      { search: 42 }
    ])
      expect(
        validateRuntimeToolInput("catalogue.marketplace.products", {
          sourceBusinessId: seedCatalogueSourceId,
          ...args
        }).ok
      ).toBe(false);
    expect(
      validateRuntimeToolInput("catalogue.marketplace.products", {
        sourceBusinessId: seedCatalogueSourceId,
        search: "tea",
        limit: 50,
        offset: 50
      }).ok
    ).toBe(true);
  });
});
