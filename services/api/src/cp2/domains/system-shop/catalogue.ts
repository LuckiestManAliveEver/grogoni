/**
 * Jane's Shop: the marketplace's built-in demo shop. Everything in this file is pure and
 * deterministic (same seed catalogue in, same records out), so provisioning can run on every
 * Node boot and on every Edge marketplace request without ever producing a second copy, and a
 * concurrent first provisioning on two Edge isolates writes byte-identical rows.
 *
 * The shop mirrors the bundled marketplace catalogue (`seed-catalogue-data.generated.json`).
 * That source workbook carries no retail prices, so the shop sells at clearly labelled demo
 * prices derived from a hash of each product ID. Demo prices never leave the shop: copying the
 * catalogue goes through the seed import path, which creates products with no price and no stock.
 */
import { createHash } from "node:crypto";
import { seedCatalogue } from "../catalogue-sharing/seed-catalogue.js";

/** Stable namespace for every deterministic ID below. Changing it would orphan provisioned rows. */
const systemShopIdNamespace = "grogoni.system-shop.janes-shop.v1";

/** RFC 4122 version-5-shaped UUID from a SHA-256 of the namespaced name (valid for `uuid` columns). */
export function systemShopEntityId(name: string): string {
  const bytes = createHash("sha256").update(`${systemShopIdNamespace}:${name}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export const systemShop = {
  businessId: systemShopEntityId("business"),
  accountId: systemShopEntityId("account"),
  userId: systemShopEntityId("user"),
  membershipId: systemShopEntityId("owner-membership"),
  name: "Jane's Shop",
  /** Reserved in `reservedGrogoniHandles`, so no merchant can claim it first. */
  grogoniId: "grogoni.janes-shop",
  language: "en" as const,
  operatorDisplayName: "Grogoni Marketplace Agent",
  /**
   * `.invalid` is reserved by RFC 2606 and can never receive mail, so no OTP or recovery code can
   * reach this address. The account is also `suspended`, which every sign-in path refuses.
   */
  operatorDestination: "marketplace-agent@system.grogoni.invalid",
  currency: "KES",
  /**
   * Its shop directory category (a general duka). No place: it is a demo shop with no address,
   * and a made-up town would send buyers looking for it.
   */
  directoryCategory: "groceries"
} as const;

/** Stock the Marketplace Agent keeps on every product. */
export const systemShopStockPolicy = {
  /** Quantity each product is provisioned with and restocked back up to. */
  targetQuantity: 100,
  /** A sale that leaves a product at or below this level triggers an immediate restock. */
  restockThreshold: 10,
  /** Demo orders one buyer account or storefront visitor may place per rolling 24 hours. */
  dailyOrdersPerBuyer: 20,
  /**
   * Demo orders the whole shop accepts per rolling 24 hours, from everyone. Storefront visitor IDs
   * are client-chosen, so only this shop-wide cap bounds how fast the shop's (permanent) invoice
   * and movement history can grow: at most this many orders a day, each of at most
   * `maximumOrderLines` lines. Nothing archives that history yet (see README "Limits").
   */
  dailyOrdersShopWide: 300,
  maximumOrderLines: 10,
  /**
   * Completed demo orders (invoice, order, stock movements) older than this are deleted, so the
   * history Jane's own Edge requests hydrate stays bounded: at most about one day of capped
   * orders. Slightly over 24 hours so the rolling daily caps always count complete data.
   */
  historyRetentionMs: 25 * 60 * 60 * 1000,
  /** Records of each kind one retention pass deletes, bounding the work per request. */
  historyPruneBatch: 1000
} as const;

/** The product records Jane's Shop holds for a planned product, minus stock and timestamps. */
export function systemShopPlannedProductFields(planned: SystemShopProductPlan) {
  return {
    name: planned.name,
    sku: planned.sku,
    unit: "unit",
    sellingPrice: planned.sellingPrice,
    catalogueSource: {
      datasetId: seedCatalogue.id,
      datasetVersion: seedCatalogue.version,
      sourceProductId: planned.sourceProductId
    }
  };
}

/** KES demo price bands per catalogue department, inclusive, in whole 5-shilling steps. */
const demoPriceBandsKes: Record<string, { min: number; max: number }> = {
  food_and_grocery: { min: 50, max: 600 },
  household_and_cleaning: { min: 80, max: 900 },
  personal_care: { min: 60, max: 700 },
  lighting_and_electrical: { min: 150, max: 2500 },
  general_retail: { min: 50, max: 1500 }
};
const fallbackDemoPriceBandKes = { min: 50, max: 1500 };

export function systemShopDemoPriceKes(product: { id: string; department: string }): number {
  const band = demoPriceBandsKes[product.department] ?? fallbackDemoPriceBandKes;
  const steps = Math.floor((band.max - band.min) / 5) + 1;
  const digest = createHash("sha256")
    .update(`${systemShopIdNamespace}:price:${product.id}`)
    .digest();
  return band.min + (digest.readUInt32BE(0) % steps) * 5;
}

export interface SystemShopProductPlan {
  id: string;
  sku: string;
  sourceProductId: string;
  name: string;
  category: string | null;
  department: string;
  sellingPrice: number;
}

export function systemShopProductId(sourceProductId: string): string {
  return systemShopEntityId(`product:${seedCatalogue.id}:${sourceProductId}`);
}

let cachedPlan: readonly SystemShopProductPlan[] | null = null;

/** One planned product per seed catalogue product, in catalogue order. Computed once. */
export function systemShopProductPlan(): readonly SystemShopProductPlan[] {
  cachedPlan ??= Object.freeze(
    seedCatalogue.products.map((product) =>
      Object.freeze({
        id: systemShopProductId(product.id),
        sku: `janes-${product.id}`.slice(0, 120),
        sourceProductId: product.id,
        name: product.name,
        category: product.category,
        department: product.department,
        sellingPrice: systemShopDemoPriceKes(product)
      })
    )
  );
  return cachedPlan;
}

export function isSystemShopBusinessId(businessId: string): boolean {
  return businessId === systemShop.businessId;
}

export const systemShopAgentIntroduction =
  "Welcome to Jane's Shop, the Grogoni marketplace demo shop. The Grogoni Marketplace Agent runs " +
  "this shop on its own: it answers questions, accepts and completes every order, and restocks " +
  "automatically. Prices are demo prices and no money changes hands. Any shop can copy this " +
  "catalogue from Shared catalogues.";
