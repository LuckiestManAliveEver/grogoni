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
    now?: Date;
  }) => ProductSummary;
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

    return [...this.deps.businesses.values()]
      .filter((business) => business.id !== input.viewerBusinessId)
      .filter((business) => !this.deps.quarantinedBusinessIds.has(business.id))
      .filter((business) => this.deps.shopPresenceForBusiness(business.id).catalogueShareable)
      .map((business) => this.shareableCatalogueSummary(business))
      .filter((summary) => {
        if (search.length === 0) return true;
        return [summary.businessName, summary.grogoniId].some((value) =>
          value.toLowerCase().includes(search)
        );
      })
      .sort((left, right) => left.businessName.localeCompare(right.businessName))
      .slice(0, limit);
  }

  listCatalogueProducts(input: {
    sessionId: string | null;
    viewerBusinessId: string;
    sourceBusinessId: string;
    now?: Date;
  }): ShareableCatalogueProductSummary[] {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.viewerBusinessId,
      "product:read",
      input.now
    );
    const business = this.requireShareableSourceBusiness(
      input.sourceBusinessId,
      input.viewerBusinessId
    );
    return this.deps.productsForBusiness(business.id).map((product) => ({
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
