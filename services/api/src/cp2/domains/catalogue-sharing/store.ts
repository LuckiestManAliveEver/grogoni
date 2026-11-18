/**
 * Catalogue-sharing domain slice: lets a shop owner opt their catalogue in to being browsed and
 * duplicated by other shops (the opt-in flag itself lives on the existing `shopPresences`
 * collection in store.ts - see `ShopPresenceSummary.catalogueShareable` - rather than a new
 * collection, since it is one more fact about the same "how is my shop presented to other shops"
 * entity `setShopPresence`/`getShopPresence` already own).
 *
 * This domain owns no persisted state of its own: browsing reads live off `businesses`,
 * `quarantinedBusinessIds`, and the sales domain's product list; duplicating calls straight into
 * `SalesDomain.createProduct` so every product created this way gets the exact same validation,
 * normalization, eventing, and `product:write` permission check as one added by hand through
 * ProductManagementCard - deliberately not a parallel product-creation path.
 */
import type {
  BusinessSummary,
  ProductSummary,
  ShareableCatalogueProductSummary,
  ShareableCatalogueSummary,
  ShopPresenceSummary
} from "@grogoni/shared-types";
import {
  validateProductInput,
  type BusinessPermission,
  type ProductInput
} from "@grogoni/business-core";
import type { AuthenticatedActorView } from "@grogoni/shared-types";
import { assertValid, Cp2Error } from "../../cp2-error.js";
import {
  seedCatalogue,
  seedCatalogueSourceId,
  seedCatalogueSummary,
  seedCatalogueMatches
} from "./seed-catalogue.js";
import {
  isSystemShopBusinessId,
  systemShop,
  systemShopProductPlan
} from "../system-shop/catalogue.js";

export interface CatalogueSharingDomainDeps {
  requireAuthorizedSession: (
    sessionId: string | null,
    businessId: string,
    permission: BusinessPermission,
    now?: Date
  ) => AuthenticatedActorView;
  recordAuditEvent: (input: {
    type: string;
    aggregateType: string;
    aggregateId: string;
    actorId: string;
    occurredAt: string;
    payload: Record<string, unknown>;
  }) => void;
  businesses: Map<string, BusinessSummary>;
  quarantinedBusinessIds: Set<string>;
  shopPresenceForBusiness: (businessId: string) => ShopPresenceSummary;
  productsForBusiness: (businessId: string) => ProductSummary[];
  requireProduct: (businessId: string, productId: string) => ProductSummary;
  publicProductImage: (product: ProductSummary) => string | null;
  createProduct: (input: {
    sessionId: string | null;
    businessId: string;
    product: ProductInput;
    catalogueSource?: NonNullable<ProductSummary["catalogueSource"]>;
    now?: Date;
  }) => ProductSummary;
  /** Jane's Shop exists (loaded here, or known provisioned by the deployment). */
  systemShopListed?: () => boolean;
}

const maximumDuplicateProductsPerRequest = 50;

export class CatalogueSharingDomain {
  constructor(private readonly deps: CatalogueSharingDomainDeps) {}

  listShareableCatalogues(input: {
    sessionId: string | null;
    viewerBusinessId: string;
    search?: string;
    limit?: number;
    now?: Date;
  }): ShareableCatalogueSummary[] {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.viewerBusinessId,
      "product:read",
      input.now
    );
    const search = input.search?.trim().toLowerCase().slice(0, 120) ?? "";
    const limit = Math.min(50, Math.max(1, input.limit ?? 24));

    const shops = [...this.deps.businesses.values()]
      .filter((business) => business.id !== input.viewerBusinessId)
      .filter((business) => !isSystemShopBusinessId(business.id))
      .filter((business) => !this.deps.quarantinedBusinessIds.has(business.id))
      .filter((business) => this.deps.shopPresenceForBusiness(business.id).catalogueShareable)
      .map((business) => this.shareableCatalogueSummary(business))
      .filter((summary) => {
        if (search.length === 0) return true;
        return [summary.businessName, summary.grogoniId].some((value) =>
          value.toLowerCase().includes(search)
        );
      })
      .sort((left, right) => left.businessName.localeCompare(right.businessName));
    // Jane's Shop leads the list, then the starter dataset, then other shops.
    const janeMatches =
      this.deps.systemShopListed?.() === true &&
      input.viewerBusinessId !== systemShop.businessId &&
      (search.length === 0 ||
        [systemShop.name, systemShop.grogoniId].some((value) =>
          value.toLowerCase().includes(search)
        ) ||
        seedCatalogueMatches(search));
    return [
      ...(janeMatches ? [systemShopCatalogueSummary()] : []),
      ...(seedCatalogueMatches(search) ? [seedCatalogueSummary()] : []),
      ...shops
    ].slice(0, limit);
  }

  listCatalogueProducts(input: {
    sessionId: string | null;
    viewerBusinessId: string;
    sourceBusinessId: string;
    search?: string;
    offset?: number;
    limit?: number;
    now?: Date;
  }): ShareableCatalogueProductSummary[] {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.viewerBusinessId,
      "product:read",
      input.now
    );
    if (input.sourceBusinessId === seedCatalogueSourceId) {
      const search = input.search?.trim().toLowerCase().slice(0, 120) ?? "";
      const offset = input.offset ?? 0;
      const limit = input.limit ?? seedCatalogue.products.length;
      if (
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > 10000 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 1000
      )
        throw new Cp2Error(400, "catalogue_page_invalid", "Choose a valid catalogue page.");
      return seedCatalogue.products
        .filter((product) =>
          [product.name, product.category ?? "", product.department].some((value) =>
            value.toLowerCase().includes(search)
          )
        )
        .slice(offset, offset + limit)
        .map((product) => ({
          id: product.id,
          name: product.name,
          unit: "unit",
          sellingPrice: null,
          image: null
        }));
    }
    if (isSystemShopBusinessId(input.sourceBusinessId)) {
      this.requireSystemShopListed();
      const search = input.search?.trim().toLowerCase().slice(0, 120) ?? "";
      const offset = input.offset ?? 0;
      const plan = systemShopProductPlan();
      const limit = input.limit ?? plan.length;
      if (
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > 10000 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 1000
      )
        throw new Cp2Error(400, "catalogue_page_invalid", "Choose a valid catalogue page.");
      // Demo prices are never shown here: copies do not carry them.
      return plan
        .filter((product) =>
          [product.name, product.category ?? "", product.department].some((value) =>
            value.toLowerCase().includes(search)
          )
        )
        .slice(offset, offset + limit)
        .map((product) => ({
          id: product.id,
          name: product.name,
          unit: "unit",
          sellingPrice: null,
          image: null
        }));
    }
    const business = this.requireShareableSourceBusiness(
      input.sourceBusinessId,
      input.viewerBusinessId
    );
    const search = input.search?.trim().toLowerCase().slice(0, 120) ?? "";
    const offset = input.offset ?? 0;
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > 10000 ||
      (input.limit !== undefined &&
        (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000))
    )
      throw new Cp2Error(400, "catalogue_page_invalid", "Choose a valid catalogue page.");
    return this.deps
      .productsForBusiness(business.id)
      .filter((product) => product.name.toLowerCase().includes(search))
      .slice(offset, input.limit === undefined ? undefined : offset + input.limit)
      .map((product) => ({
        id: product.id,
        name: product.name,
        unit: product.unit,
        sellingPrice: product.sellingPrice,
        image: this.deps.publicProductImage(product)
      }));
  }

  duplicateProducts(input: {
    sessionId: string | null;
    viewerBusinessId: string;
    sourceBusinessId: string;
    productIds: string[];
    now?: Date;
  }): ProductSummary[] {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.viewerBusinessId,
      "product:write",
      now
    );
    if (input.sourceBusinessId === seedCatalogueSourceId) {
      return this.importSeedProducts(input, session.user.id, now);
    }
    if (isSystemShopBusinessId(input.sourceBusinessId)) {
      this.requireSystemShopListed();
      if (input.viewerBusinessId === systemShop.businessId)
        throw new Cp2Error(400, "catalogue_self_duplicate", "You already own this catalogue.");
      return this.importSystemShopProducts(input, session.user.id, now);
    }
    const business = this.requireShareableSourceBusiness(
      input.sourceBusinessId,
      input.viewerBusinessId
    );

    const uniqueProductIds = [...new Set(input.productIds)];
    if (
      uniqueProductIds.length === 0 ||
      uniqueProductIds.length > maximumDuplicateProductsPerRequest
    ) {
      throw new Cp2Error(
        400,
        "duplicate_product_ids_invalid",
        `Select between 1 and ${maximumDuplicateProductsPerRequest} products.`
      );
    }

    const sourceProducts = uniqueProductIds.map((productId) =>
      this.deps.requireProduct(business.id, productId)
    );

    const drafts = sourceProducts.map((product): ProductInput => ({
      name: product.name,
      unit: product.unit,
      quantity: 0,
      buyingPrice: null,
      sellingPrice: product.sellingPrice,
      ...(product.aliases === undefined ? {} : { aliases: product.aliases })
    }));
    // Validate every draft before creating any of them - createProduct persists as it goes, so
    // validating the whole batch upfront (the same pre-check document-imports's confirm step does
    // before writing rows) keeps a bad product in the batch from leaving earlier ones already
    // committed to the buyer's catalogue with no rollback.
    for (const draft of drafts) {
      assertValid(validateProductInput(draft));
    }

    const created = drafts.map((draft) =>
      this.deps.createProduct({
        sessionId: input.sessionId,
        businessId: input.viewerBusinessId,
        product: draft,
        now
      })
    );

    this.deps.recordAuditEvent({
      type: "catalogue.products_duplicated",
      aggregateType: "business",
      aggregateId: input.viewerBusinessId,
      actorId: session.user.id,
      occurredAt: now.toISOString(),
      payload: {
        sourceBusinessId: business.id,
        productCount: created.length
      }
    });

    return created;
  }

  /**
   * Jane's Shop mirrors the seed catalogue at demo prices. Copying from it imports the matching
   * seed products, so the copy gets the seed path's guarantees: no demo price leaks into a real
   * shop, stock starts at zero, and a repeated copy reuses products instead of duplicating them.
   */
  private importSystemShopProducts(
    input: {
      sessionId: string | null;
      viewerBusinessId: string;
      sourceBusinessId: string;
      productIds: string[];
    },
    actorId: string,
    now: Date
  ): ProductSummary[] {
    const ids = [...new Set(input.productIds)];
    if (ids.length < 1 || ids.length > maximumDuplicateProductsPerRequest)
      throw new Cp2Error(
        400,
        "duplicate_product_ids_invalid",
        `Select between 1 and ${maximumDuplicateProductsPerRequest} products.`
      );
    // Jane's product IDs are derived from the seed plan, so they resolve without loading her
    // records (which an Edge catalogue request never does).
    const sourceById = new Map(systemShopProductPlan().map((p) => [p.id, p.sourceProductId]));
    const seedIds = ids.map((productId) => {
      const sourceProductId = sourceById.get(productId);
      if (sourceProductId === undefined)
        throw new Cp2Error(
          404,
          "system_shop_product_not_found",
          "Select products returned by Jane's Shop's catalogue."
        );
      return sourceProductId;
    });
    return this.importSeedProducts(
      { ...input, productIds: seedIds },
      actorId,
      now,
      input.sourceBusinessId
    );
  }

  private importSeedProducts(
    input: {
      sessionId: string | null;
      viewerBusinessId: string;
      productIds: string[];
    },
    actorId: string,
    now: Date,
    viaSourceBusinessId?: string
  ): ProductSummary[] {
    const ids = [...new Set(input.productIds)];
    if (ids.length < 1 || input.productIds.length > maximumDuplicateProductsPerRequest)
      throw new Cp2Error(400, "duplicate_product_ids_invalid", "Select between 1 and 50 products.");
    // Resolve the entire selection before making any writes.
    const selected = ids.map((id) => {
      const product = seedCatalogue.products.find((candidate) => candidate.id === id);
      if (!product)
        throw new Cp2Error(
          404,
          "seed_product_not_found",
          "Select products returned by the seed catalogue."
        );
      return product;
    });
    for (const source of selected)
      assertValid(
        validateProductInput({
          name: source.name,
          unit: "unit",
          quantity: 0,
          buyingPrice: null,
          sellingPrice: null
        })
      );
    const existing = this.deps.productsForBusiness(input.viewerBusinessId);
    let createdCount = 0;
    const result = selected.map((source) => {
      const previous = existing.find(
        (product) =>
          product.catalogueSource?.datasetId === seedCatalogue.id &&
          product.catalogueSource.sourceProductId === source.id
      );
      if (previous) return previous;
      const product = this.deps.createProduct({
        sessionId: input.sessionId,
        businessId: input.viewerBusinessId,
        now,
        product: {
          name: source.name,
          unit: "unit",
          quantity: 0,
          buyingPrice: null,
          sellingPrice: null
        },
        catalogueSource: {
          datasetId: seedCatalogue.id,
          datasetVersion: seedCatalogue.version,
          sourceProductId: source.id
        }
      });
      createdCount += 1;
      return product;
    });
    this.deps.recordAuditEvent({
      type: "catalogue.seed_products_imported",
      aggregateType: "business",
      aggregateId: input.viewerBusinessId,
      actorId,
      occurredAt: now.toISOString(),
      payload: {
        datasetId: seedCatalogue.id,
        datasetVersion: seedCatalogue.version,
        sourceWorkbookSha256: seedCatalogue.sourceWorkbookSha256,
        ...(viaSourceBusinessId === undefined ? {} : { viaSourceBusinessId }),
        createdCount,
        products: result.map((product, index) => ({
          productId: product.id,
          sourceProductId: selected[index]!.id
        }))
      }
    });
    return result;
  }

  private shareableCatalogueSummary(business: BusinessSummary): ShareableCatalogueSummary {
    const presence = this.deps.shopPresenceForBusiness(business.id);
    return {
      businessId: business.id,
      grogoniId: business.grogoniId,
      businessName: business.name,
      productCount: this.deps.productsForBusiness(business.id).length,
      updatedAt: presence.updatedAt
    };
  }

  /** Jane's Shop is browsable and copyable only once it exists (or is known to on Edge). */
  private requireSystemShopListed(): void {
    if (this.deps.systemShopListed?.() !== true)
      throw new Cp2Error(
        404,
        "shareable_catalogue_not_found",
        "This shop's catalogue isn't available to duplicate."
      );
  }

  private requireShareableSourceBusiness(
    sourceBusinessId: string,
    viewerBusinessId: string
  ): BusinessSummary {
    if (sourceBusinessId === viewerBusinessId) {
      throw new Cp2Error(400, "catalogue_self_duplicate", "You already own this catalogue.");
    }

    const business = this.deps.businesses.get(sourceBusinessId);
    if (
      business === undefined ||
      this.deps.quarantinedBusinessIds.has(sourceBusinessId) ||
      !this.deps.shopPresenceForBusiness(sourceBusinessId).catalogueShareable
    ) {
      throw new Cp2Error(
        404,
        "shareable_catalogue_not_found",
        "This shop's catalogue isn't available to duplicate."
      );
    }

    return business;
  }
}

/** Jane's Shop as a shared catalogue, from the seed plan alone (see listShareableCatalogues). */
function systemShopCatalogueSummary(): ShareableCatalogueSummary {
  return {
    businessId: systemShop.businessId,
    grogoniId: systemShop.grogoniId,
    businessName: systemShop.name,
    productCount: systemShopProductPlan().length,
    updatedAt: seedCatalogue.generatedAt,
    pinned: true,
    operatedBy: "marketplace_agent"
  };
}
