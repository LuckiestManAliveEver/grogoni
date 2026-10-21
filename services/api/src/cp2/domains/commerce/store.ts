/**
 * First slice of in-process domain modularization for the Cp2Store monolith (see
 * docs/architecture/domain-modularization-roadmap.md for the full picture and why this is
 * in-process modules, not literally separate deployable services). Owns the five entity Maps for
 * the photo-capture -> status-broadcast -> unified-checkout commerce cluster and every method that
 * reads/writes them. Everything it needs from the rest of the store (auth, product/business/
 * network/customer/user lookups, invoice building, public storefront search) is passed in
 * explicitly through CommerceDomainDeps at construction - no ambient `this.*` reach into Cp2Store.
 *
 * Cp2Store still owns this instance and delegates its public commerce methods to it 1:1 with
 * identical signatures, so this is a zero-behavior-change extraction - same tests, same public
 * API, moved implementation. Cp2Store's generic snapshot/restore/Postgres-persistence/account-
 * deletion sweeps read these five Maps via the `commerce` field's public map accessors, exactly
 * as they read every other entity Map.
 */
import { randomUUID } from "node:crypto";
import type { BusinessPermission, InvoiceInput, ProductInput } from "@grogoni/business-core";
import { queryCatalogueProducts } from "@grogoni/business-core";
import type {
  AuthenticatedActorView,
  BusinessSummary,
  BuyCheckoutItemInput,
  BuyFeedSummary,
  BuyOrderSummary,
  BuyResultSummary,
  ConversationMessageAuthor,
  ConversationMessageContent,
  CustomerSummary,
  InvoiceSummary,
  NetworkNodeSummary,
  ProductCaptureItemSummary,
  ProductCaptureJobSummary,
  ProductSummary,
  StatusBroadcastCandidateSummary,
  StatusBroadcastItemSummary,
  StatusBroadcastRecipientSummary,
  StatusBroadcastSummary,
  StatusOrderItemSummary,
  StatusOrderSummary,
  UnifiedCheckoutFailureSummary,
  UnifiedCheckoutHandoffSummary,
  UnifiedCheckoutSummary,
  UserSummary,
  MessageChannel,
  OrderSource
} from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import type { ProductMediaRecord, PublicStorefrontSummary } from "../../store.js";
import {
  captureField,
  firstProductCaptureTitle,
  normalizeOptionalBoundedText,
  normalizeRequiredBoundedText,
  productCaptureItemsFromFields,
  sellerCaptureField,
  visibleProductCapturePrice,
  buyTextRelevanceScore
} from "./shared.js";

export interface CommerceDomainDeps {
  requireAuthorizedSession: (
    sessionId: string | null,
    businessId: string,
    permission: BusinessPermission,
    now?: Date
  ) => AuthenticatedActorView;
  requirePinVerifiedSession: (sessionId: string | null, now: Date) => AuthenticatedActorView;
  requireProduct: (businessId: string, productId: string) => ProductSummary;
  createProduct: (input: {
    sessionId: string | null;
    businessId: string;
    product: ProductInput;
    now?: Date;
  }) => ProductSummary;
  updateProduct: (input: {
    sessionId: string | null;
    businessId: string;
    productId: string;
    product: ProductInput;
    now?: Date;
  }) => ProductSummary;
  listPublicStorefronts: (input?: { search?: string; limit?: number }) => PublicStorefrontSummary[];
  createConversationMessage: (input: {
    sessionId: string | null;
    conversationId: string;
    clientMessageId: string;
    content: ConversationMessageContent;
    author?: ConversationMessageAuthor;
    now?: Date;
  }) => unknown;
  buildStoredInvoice: (input: {
    businessId: string;
    invoiceId: string;
    invoiceNumber: string;
    input: InvoiceInput;
    status: "draft" | "confirmed";
    confirmedAt: string | null;
    now: Date;
    source?: OrderSource | null;
    sourceMessageChannel?: MessageChannel | null;
  }) => InvoiceSummary;
  nextInvoiceNumber: (businessId: string) => string;
  productMedia: Map<string, ProductMediaRecord>;
  products: Map<string, ProductSummary>;
  customers: Map<string, CustomerSummary>;
  networkNodes: Map<string, NetworkNodeSummary>;
  users: Map<string, UserSummary>;
  businesses: Map<string, BusinessSummary>;
  invoices: Map<string, InvoiceSummary>;
}

export class CommerceDomain {
  private readonly productCaptureJobs = new Map<string, ProductCaptureJobSummary>();
  private readonly statusBroadcasts = new Map<string, StatusBroadcastSummary>();
  private readonly buyOrders = new Map<string, BuyOrderSummary>();
  private readonly statusOrders = new Map<string, StatusOrderSummary>();
  private readonly unifiedCheckouts = new Map<string, UnifiedCheckoutSummary>();

  constructor(private readonly deps: CommerceDomainDeps) {}

  /**
   * Clears every entity Map this domain owns - used by Cp2Store.hydrateSnapshot before
   * repopulating from a snapshot, so a stale entry from before the hydration can never survive it.
   */
  clear(): void {
    this.productCaptureJobs.clear();
    this.statusBroadcasts.clear();
    this.buyOrders.clear();
    this.statusOrders.clear();
    this.unifiedCheckouts.clear();
  }

  // Exposed read-only for Cp2Store's generic snapshot/restore/Postgres-persistence/account-
  // deletion sweeps, which operate uniformly across every entity Map in the store regardless of
  // which domain owns it - see store.ts's snapshot()/restore()/deleteAccountData().
  get productCaptureJobsMap(): Map<string, ProductCaptureJobSummary> {
    return this.productCaptureJobs;
  }
  get statusBroadcastsMap(): Map<string, StatusBroadcastSummary> {
    return this.statusBroadcasts;
  }
  get buyOrdersMap(): Map<string, BuyOrderSummary> {
    return this.buyOrders;
  }
  get statusOrdersMap(): Map<string, StatusOrderSummary> {
    return this.statusOrders;
  }
  get unifiedCheckoutsMap(): Map<string, UnifiedCheckoutSummary> {
    return this.unifiedCheckouts;
  }

  createProductCaptureJob(input: {
    sessionId: string | null;
    businessId: string;
    sourceFileName: string;
    contentType: ProductMediaRecord["contentType"];
    /** Absent for a capture synced from offline mode: image bytes are never queued or synced
     *  (bandwidth-saving, same rule as receipt OCR) - the job is created with no product media,
     *  same as if the seller later chooses not to keep the photo. */
    contentBase64?: string | null;
    sourceChecksum?: string | null;
    extractedText: string;
    averageConfidence?: number | null;
    now?: Date;
  }): ProductCaptureJobSummary {
    const now = input.now ?? new Date();
    const auth = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "product:write",
      now
    );
    const confidence =
      input.averageConfidence === null || input.averageConfidence === undefined
        ? null
        : Math.min(1, Math.max(0, input.averageConfidence));
    const sourceFileName = normalizeRequiredBoundedText(input.sourceFileName, "fileName", 255);
    const mediaId = input.contentBase64 ? randomUUID() : null;
    if (mediaId !== null) {
      const byteLength = Buffer.from(input.contentBase64 as string, "base64").byteLength;
      this.deps.productMedia.set(mediaId, {
        id: mediaId,
        businessId: input.businessId,
        productId: null,
        contentType: input.contentType,
        fileName: sourceFileName,
        checksum: input.sourceChecksum ?? "",
        byteLength,
        publicUrl: `/public/product-media/${mediaId}`,
        createdBy: auth.user.id,
        createdAt: now.toISOString(),
        contentBase64: input.contentBase64 as string
      });
    }
    const text = input.extractedText.trim();
    const title = firstProductCaptureTitle(text);
    const visiblePrice = visibleProductCapturePrice(text);
    const historyStatuses = [
      "CAPTURED",
      "QUEUED",
      "VALIDATING",
      "PREPROCESSING",
      "EXTRACTION_RUNNING"
    ] as const;
    const statusHistory: ProductCaptureJobSummary["statusHistory"] = historyStatuses.map(
      (status) => ({ status, at: now.toISOString() })
    );
    if (text.length > 0) {
      statusHistory.push(
        { status: "FIELDS_EXTRACTED", at: now.toISOString() },
        { status: "DUPLICATE_CHECK", at: now.toISOString() },
        { status: "REVIEW_REQUIRED", at: now.toISOString() }
      );
    } else {
      statusHistory.push({ status: "EXTRACTION_FAILED", at: now.toISOString() });
    }
    const duplicates =
      title === null
        ? []
        : queryCatalogueProducts({
            businessId: input.businessId,
            products: [...this.deps.products.values()],
            query: title,
            limit: 5
          }).products.map((product) => product.productId);
    const fields = {
      title: captureField(title, confidence),
      category: captureField<string>(null, null),
      description: captureField(text.length > 0 ? text.slice(0, 1000) : null, confidence),
      visiblePrice: captureField(visiblePrice, visiblePrice === null ? null : confidence)
    };
    const job: ProductCaptureJobSummary = {
      id: randomUUID(),
      businessId: input.businessId,
      uploadedBy: auth.user.id,
      status: text.length > 0 ? "REVIEW_REQUIRED" : "EXTRACTION_FAILED",
      statusHistory,
      sourceFileName,
      contentType: input.contentType,
      sourceChecksum: input.sourceChecksum ?? "",
      temporaryMediaId: mediaId,
      fields,
      detectionAvailable: false,
      items: productCaptureItemsFromFields(fields),
      possibleDuplicateProductIds: duplicates,
      failureCode: text.length > 0 ? null : "product_capture_text_missing",
      failureMessage:
        text.length > 0
          ? null
          : "No reliable product text was extracted. Retry, enter details manually, or cancel.",
      retryCount: 0,
      publishedProductId: null,
      keepImageAsProductMedia: false,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      confirmedAt: null,
      publishedAt: null,
      cancelledAt: null
    };
    this.productCaptureJobs.set(job.id, job);
    return job;
  }

  getProductCaptureJob(input: {
    sessionId: string | null;
    businessId: string;
    captureJobId: string;
    now?: Date;
  }): ProductCaptureJobSummary {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "product:read",
      input.now
    );
    return this.requireProductCaptureJob(input.businessId, input.captureJobId);
  }

  reviewProductCaptureJob(input: {
    sessionId: string | null;
    businessId: string;
    captureJobId: string;
    title: string;
    category?: string | null;
    description?: string | null;
    visiblePrice?: number | null;
    keepImageAsProductMedia: boolean;
    now?: Date;
  }): ProductCaptureJobSummary {
    const now = input.now ?? new Date();
    this.deps.requireAuthorizedSession(input.sessionId, input.businessId, "product:write", now);
    const current = this.requireProductCaptureJob(input.businessId, input.captureJobId);
    if (!["REVIEW_REQUIRED", "EXTRACTION_FAILED"].includes(current.status)) {
      throw new Cp2Error(409, "product_capture_not_reviewable", "Capture is not reviewable.");
    }
    const title = normalizeRequiredBoundedText(input.title, "title", 160);
    const duplicates = queryCatalogueProducts({
      businessId: input.businessId,
      products: [...this.deps.products.values()],
      query: title,
      limit: 5
    }).products.map((product) => product.productId);
    const updated: ProductCaptureJobSummary = {
      ...current,
      status: "REVIEW_REQUIRED",
      statusHistory:
        current.status === "REVIEW_REQUIRED"
          ? current.statusHistory
          : [...current.statusHistory, { status: "REVIEW_REQUIRED", at: now.toISOString() }],
      fields: {
        title: sellerCaptureField(title),
        category: sellerCaptureField(normalizeOptionalBoundedText(input.category ?? null, 120)),
        description: sellerCaptureField(
          normalizeOptionalBoundedText(input.description ?? null, 2000)
        ),
        visiblePrice: sellerCaptureField(input.visiblePrice ?? null)
      },
      items: productCaptureItemsFromFields(
        {
          title: sellerCaptureField(title),
          category: sellerCaptureField(normalizeOptionalBoundedText(input.category ?? null, 120)),
          description: sellerCaptureField(
            normalizeOptionalBoundedText(input.description ?? null, 2000)
          ),
          visiblePrice: sellerCaptureField(input.visiblePrice ?? null)
        },
        current.items
      ),
      possibleDuplicateProductIds: duplicates,
      failureCode: null,
      failureMessage: null,
      keepImageAsProductMedia: input.keepImageAsProductMedia,
      updatedAt: now.toISOString()
    };
    this.productCaptureJobs.set(updated.id, updated);
    return updated;
  }

  retryProductCaptureJob(input: {
    sessionId: string | null;
    businessId: string;
    captureJobId: string;
    extractedText: string;
    averageConfidence?: number | null;
    now?: Date;
  }): ProductCaptureJobSummary {
    const now = input.now ?? new Date();
    this.deps.requireAuthorizedSession(input.sessionId, input.businessId, "product:write", now);
    const current = this.requireProductCaptureJob(input.businessId, input.captureJobId);
    if (current.status !== "EXTRACTION_FAILED") {
      throw new Cp2Error(409, "product_capture_retry_invalid", "Only failed captures can retry.");
    }
    const text = input.extractedText.trim();
    const title = firstProductCaptureTitle(text);
    const price = visibleProductCapturePrice(text);
    const confidence = input.averageConfidence ?? null;
    const finalStatus = text.length > 0 ? "REVIEW_REQUIRED" : "EXTRACTION_FAILED";
    const statusHistory: ProductCaptureJobSummary["statusHistory"] = [
      ...current.statusHistory,
      { status: "QUEUED", at: now.toISOString() },
      { status: "VALIDATING", at: now.toISOString() },
      { status: "PREPROCESSING", at: now.toISOString() },
      { status: "EXTRACTION_RUNNING", at: now.toISOString() }
    ];
    if (text.length > 0) {
      statusHistory.push(
        { status: "FIELDS_EXTRACTED", at: now.toISOString() },
        { status: "DUPLICATE_CHECK", at: now.toISOString() },
        { status: "REVIEW_REQUIRED", at: now.toISOString() }
      );
    } else statusHistory.push({ status: "EXTRACTION_FAILED", at: now.toISOString() });
    const retriedFields = {
      title: captureField(title, confidence),
      category: captureField<string>(null, null),
      description: captureField(text.length > 0 ? text.slice(0, 1000) : null, confidence),
      visiblePrice: captureField(price, price === null ? null : confidence)
    };
    const updated: ProductCaptureJobSummary = {
      ...current,
      status: finalStatus,
      statusHistory,
      fields: retriedFields,
      items: productCaptureItemsFromFields(retriedFields, current.items),
      possibleDuplicateProductIds:
        title === null
          ? []
          : queryCatalogueProducts({
              businessId: input.businessId,
              products: [...this.deps.products.values()],
              query: title,
              limit: 5
            }).products.map((product) => product.productId),
      failureCode: text.length > 0 ? null : "product_capture_text_missing",
      failureMessage:
        text.length > 0
          ? null
          : "No reliable product text was extracted. Retry, enter details manually, or cancel.",
      retryCount: current.retryCount + 1,
      updatedAt: now.toISOString()
    };
    this.productCaptureJobs.set(updated.id, updated);
    return updated;
  }

  cancelProductCaptureJob(input: {
    sessionId: string | null;
    businessId: string;
    captureJobId: string;
    now?: Date;
  }): ProductCaptureJobSummary {
    const now = input.now ?? new Date();
    this.deps.requireAuthorizedSession(input.sessionId, input.businessId, "product:write", now);
    const current = this.requireProductCaptureJob(input.businessId, input.captureJobId);
    if (["PUBLISHED", "CANCELLED"].includes(current.status)) return current;
    if (current.temporaryMediaId !== null) this.deps.productMedia.delete(current.temporaryMediaId);
    const updated: ProductCaptureJobSummary = {
      ...current,
      status: "CANCELLED",
      statusHistory: [...current.statusHistory, { status: "CANCELLED", at: now.toISOString() }],
      temporaryMediaId: null,
      updatedAt: now.toISOString(),
      cancelledAt: now.toISOString()
    };
    this.productCaptureJobs.set(updated.id, updated);
    return updated;
  }

  confirmProductCaptureJob(input: {
    sessionId: string | null;
    businessId: string;
    captureJobId: string;
    existingProductId?: string | null;
    unit?: string | null;
    quantity?: number;
    aliases?: string[];
    now?: Date;
  }): { job: ProductCaptureJobSummary; product: ProductSummary } {
    const now = input.now ?? new Date();
    this.deps.requireAuthorizedSession(input.sessionId, input.businessId, "product:write", now);
    const current = this.requireProductCaptureJob(input.businessId, input.captureJobId);
    if (current.status !== "REVIEW_REQUIRED") {
      throw new Cp2Error(409, "product_capture_confirmation_invalid", "Review is required first.");
    }
    const title = current.fields.title.value;
    if (title === null) {
      throw new Cp2Error(400, "product_capture_title_required", "A confirmed title is required.");
    }
    const existing =
      input.existingProductId === undefined || input.existingProductId === null
        ? null
        : this.deps.requireProduct(input.businessId, input.existingProductId);
    const productInput: ProductInput = {
      name: title,
      sku: existing?.sku ?? null,
      aliases: input.aliases ?? existing?.aliases ?? [],
      unit: input.unit ?? existing?.unit ?? "unit",
      quantity: input.quantity ?? existing?.quantity ?? 0,
      buyingPrice: existing?.buyingPrice ?? null,
      sellingPrice: current.fields.visiblePrice.value ?? existing?.sellingPrice ?? null
    };
    const product =
      existing === null
        ? this.deps.createProduct({
            sessionId: input.sessionId,
            businessId: input.businessId,
            product: productInput,
            now
          })
        : this.deps.updateProduct({
            sessionId: input.sessionId,
            businessId: input.businessId,
            productId: existing.id,
            product: productInput,
            now
          });
    let publishedProduct = product;
    if (current.temporaryMediaId !== null) {
      if (current.keepImageAsProductMedia) {
        const media = this.deps.productMedia.get(current.temporaryMediaId);
        if (media !== undefined) {
          this.deps.productMedia.set(media.id, { ...media, productId: product.id });
          publishedProduct = { ...product, primaryMediaId: media.id, updatedAt: now.toISOString() };
          this.deps.products.set(product.id, publishedProduct);
        }
      } else {
        this.deps.productMedia.delete(current.temporaryMediaId);
      }
    }
    const updated: ProductCaptureJobSummary = {
      ...current,
      status: "PUBLISHED",
      statusHistory: [
        ...current.statusHistory,
        { status: "CONFIRMED", at: now.toISOString() },
        { status: "PUBLISHED", at: now.toISOString() }
      ],
      temporaryMediaId: current.keepImageAsProductMedia ? current.temporaryMediaId : null,
      publishedProductId: publishedProduct.id,
      items: current.items.map((item, index) =>
        index === 0
          ? { ...item, status: "confirmed", confirmedProductId: publishedProduct.id }
          : item
      ),
      updatedAt: now.toISOString(),
      confirmedAt: now.toISOString(),
      publishedAt: now.toISOString()
    };
    this.productCaptureJobs.set(updated.id, updated);
    return { job: updated, product: publishedProduct };
  }

  /**
   * Confirms one item on a multi-item capture job, creating or updating a catalogue product for
   * it. Distinct from confirmProductCaptureJob (which confirms the whole job's single `fields`
   * blob) so the photo -> item cards -> status broadcast flow can resolve items one at a time.
   */
  confirmProductCaptureItem(input: {
    sessionId: string | null;
    businessId: string;
    captureJobId: string;
    itemId: string;
    title?: string;
    category?: string | null;
    description?: string | null;
    visiblePrice?: number | null;
    existingProductId?: string | null;
    unit?: string | null;
    quantity?: number;
    aliases?: string[];
    now?: Date;
  }): { job: ProductCaptureJobSummary; product: ProductSummary } {
    const now = input.now ?? new Date();
    this.deps.requireAuthorizedSession(input.sessionId, input.businessId, "product:write", now);
    const current = this.requireProductCaptureJob(input.businessId, input.captureJobId);
    const item = current.items.find((candidate) => candidate.id === input.itemId);
    if (item === undefined) {
      throw new Cp2Error(404, "product_capture_item_not_found", "Capture item was not found.");
    }
    if (item.status !== "pending_review") {
      throw new Cp2Error(409, "product_capture_item_resolved", "This item was already resolved.");
    }
    const title =
      input.title === undefined
        ? item.fields.title.value
        : normalizeRequiredBoundedText(input.title, "title", 160);
    if (title === null) {
      throw new Cp2Error(400, "product_capture_title_required", "A confirmed title is required.");
    }
    const category =
      input.category === undefined
        ? item.fields.category.value
        : normalizeOptionalBoundedText(input.category, 120);
    const description =
      input.description === undefined
        ? item.fields.description.value
        : normalizeOptionalBoundedText(input.description, 2000);
    const visiblePrice =
      input.visiblePrice === undefined ? item.fields.visiblePrice.value : input.visiblePrice;
    const reviewedItem: ProductCaptureItemSummary = {
      ...item,
      fields: {
        title: sellerCaptureField(title),
        category: sellerCaptureField(category),
        description: sellerCaptureField(description),
        visiblePrice: sellerCaptureField(visiblePrice)
      }
    };
    const existing =
      input.existingProductId === undefined || input.existingProductId === null
        ? null
        : this.deps.requireProduct(input.businessId, input.existingProductId);
    const productInput: ProductInput = {
      name: title,
      sku: existing?.sku ?? null,
      aliases: input.aliases ?? existing?.aliases ?? [],
      unit: input.unit ?? existing?.unit ?? "unit",
      quantity: input.quantity ?? existing?.quantity ?? 0,
      buyingPrice: existing?.buyingPrice ?? null,
      sellingPrice: visiblePrice ?? existing?.sellingPrice ?? null
    };
    const product =
      existing === null
        ? this.deps.createProduct({
            sessionId: input.sessionId,
            businessId: input.businessId,
            product: productInput,
            now
          })
        : this.deps.updateProduct({
            sessionId: input.sessionId,
            businessId: input.businessId,
            productId: existing.id,
            product: productInput,
            now
          });
    let publishedProduct = product;
    let remainingTemporaryMediaId = current.temporaryMediaId;
    if (current.temporaryMediaId !== null && current.keepImageAsProductMedia) {
      const media = this.deps.productMedia.get(current.temporaryMediaId);
      if (media !== undefined) {
        this.deps.productMedia.set(media.id, { ...media, productId: product.id });
        publishedProduct = { ...product, primaryMediaId: media.id, updatedAt: now.toISOString() };
        this.deps.products.set(product.id, publishedProduct);
        remainingTemporaryMediaId = null;
      }
    }
    const items = current.items.map((candidate) =>
      candidate.id === item.id
        ? { ...reviewedItem, status: "confirmed" as const, confirmedProductId: publishedProduct.id }
        : candidate
    );
    const updated = this.finishProductCaptureItemResolution(
      { ...current, temporaryMediaId: remainingTemporaryMediaId },
      items,
      now
    );
    return { job: updated, product: publishedProduct };
  }

  rejectProductCaptureItem(input: {
    sessionId: string | null;
    businessId: string;
    captureJobId: string;
    itemId: string;
    now?: Date;
  }): ProductCaptureJobSummary {
    const now = input.now ?? new Date();
    this.deps.requireAuthorizedSession(input.sessionId, input.businessId, "product:write", now);
    const current = this.requireProductCaptureJob(input.businessId, input.captureJobId);
    const item = current.items.find((candidate) => candidate.id === input.itemId);
    if (item === undefined) {
      throw new Cp2Error(404, "product_capture_item_not_found", "Capture item was not found.");
    }
    if (item.status !== "pending_review") {
      throw new Cp2Error(409, "product_capture_item_resolved", "This item was already resolved.");
    }
    const items = current.items.map((candidate) =>
      candidate.id === item.id ? { ...candidate, status: "rejected" as const } : candidate
    );
    return this.finishProductCaptureItemResolution(current, items, now);
  }

  private finishProductCaptureItemResolution(
    current: ProductCaptureJobSummary,
    items: ProductCaptureItemSummary[],
    now: Date
  ): ProductCaptureJobSummary {
    const allResolved = items.every((candidate) => candidate.status !== "pending_review");
    const anyConfirmed = items.some((candidate) => candidate.status === "confirmed");
    if (allResolved && current.temporaryMediaId !== null) {
      this.deps.productMedia.delete(current.temporaryMediaId);
    }
    const updated: ProductCaptureJobSummary = {
      ...current,
      items,
      temporaryMediaId: allResolved ? null : current.temporaryMediaId,
      status: allResolved ? (anyConfirmed ? "CONFIRMED" : "CANCELLED") : current.status,
      statusHistory: allResolved
        ? [
            ...current.statusHistory,
            { status: anyConfirmed ? "CONFIRMED" : "CANCELLED", at: now.toISOString() }
          ]
        : current.statusHistory,
      confirmedAt: allResolved && anyConfirmed ? now.toISOString() : current.confirmedAt,
      cancelledAt: allResolved && !anyConfirmed ? now.toISOString() : current.cancelledAt,
      updatedAt: now.toISOString()
    };
    this.productCaptureJobs.set(updated.id, updated);
    return updated;
  }

  private requireProductCaptureJob(
    businessId: string,
    captureJobId: string
  ): ProductCaptureJobSummary {
    const job = this.productCaptureJobs.get(captureJobId);
    if (job === undefined || job.businessId !== businessId) {
      throw new Cp2Error(404, "product_capture_not_found", "Product capture was not found.");
    }
    return job;
  }

  /**
   * Phone contacts eligible to receive a status broadcast. `defaultSelected` is only true for
   * contacts who are both a matched Grogoni account and an existing customer of this business - the
   * caller must never treat the full candidate list as the default selection.
   */
  listStatusBroadcastCandidates(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): StatusBroadcastCandidateSummary[] {
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "product:write",
      input.now
    );
    const existingCustomerAccountIds = new Set(
      [...this.deps.customers.values()]
        .filter(
          (customer) =>
            customer.businessId === input.businessId && customer.linkedAccountId !== null
        )
        .map((customer) => customer.linkedAccountId as string)
    );
    return [...this.deps.networkNodes.values()]
      .filter((node) => node.ownerUserId === session.user.id && node.sourceType === "phone_contact")
      .map((node) => {
        const recipientAccountId = this.accountIdForNetworkNode(node);
        const isGrogoniUser = recipientAccountId !== null;
        const isExistingCustomer =
          isGrogoniUser && existingCustomerAccountIds.has(recipientAccountId);
        return {
          networkNodeId: node.id,
          displayName: node.displayName,
          isGrogoniUser,
          isExistingCustomer,
          defaultSelected: isGrogoniUser && isExistingCustomer
        };
      });
  }

  /**
   * Posts a status broadcast from a capture job's confirmed items to the chosen contacts. A
   * status is a distinct trackable object, not a chat message, so recipients matched to a Grogoni
   * account ("in_app") do not receive it as a conversation message - conversations with two human
   * accounts must be end-to-end encrypted (validateConversationEncryption), and a server-composed
   * status card cannot honestly satisfy that. Instead "in_app" recipients discover it through
   * listStatusBroadcastsReceivedByViewer, queried from their own session. Unmatched phone contacts
   * are marked "share_sheet_pending" for the client to hand off through the OS share sheet
   * (shareMessageExternally) - delivery is never claimed for that path since it isn't tracked.
   */
  createStatusBroadcast(input: {
    sessionId: string | null;
    businessId: string;
    sourceCaptureJobId: string;
    recipientNodeIds: string[];
    sellerConversationId?: string | null;
    now?: Date;
  }): StatusBroadcastSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "product:write",
      now
    );
    if (input.recipientNodeIds.length === 0) {
      throw new Cp2Error(
        400,
        "status_broadcast_recipients_required",
        "Choose at least one contact to post this status to."
      );
    }
    const job = this.requireProductCaptureJob(input.businessId, input.sourceCaptureJobId);
    const confirmedItems = job.items.filter((item) => item.status === "confirmed");
    if (confirmedItems.length === 0) {
      throw new Cp2Error(
        409,
        "status_broadcast_no_confirmed_items",
        "Confirm at least one item before posting a status."
      );
    }

    const recipients: StatusBroadcastRecipientSummary[] = input.recipientNodeIds.map((nodeId) => {
      const node = this.deps.networkNodes.get(nodeId);
      if (node === undefined || node.ownerUserId !== session.user.id) {
        throw new Cp2Error(
          404,
          "status_broadcast_contact_not_found",
          "A selected contact was not found."
        );
      }
      return {
        networkNodeId: node.id,
        displayName: node.displayName,
        deliveryChannel: (this.accountIdForNetworkNode(node) === null
          ? "share_sheet_pending"
          : "in_app") as StatusBroadcastRecipientSummary["deliveryChannel"],
        viewedAt: null,
        repliedAt: null
      };
    });

    const items: StatusBroadcastItemSummary[] = confirmedItems.map((item) => {
      const product =
        item.confirmedProductId === null
          ? undefined
          : this.deps.products.get(item.confirmedProductId);
      return {
        productCaptureItemId: item.id,
        title: item.fields.title.value ?? product?.name ?? "Untitled item",
        visiblePrice: item.fields.visiblePrice.value ?? product?.sellingPrice ?? null,
        image:
          product?.primaryMediaId === undefined || product.primaryMediaId === null
            ? null
            : `/public/product-media/${product.primaryMediaId}`
      };
    });

    const status: StatusBroadcastSummary = {
      id: randomUUID(),
      businessId: input.businessId,
      postedBy: session.user.id,
      sourceCaptureJobId: job.id,
      items,
      recipients,
      state: "active",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      viewCount: 0,
      replyCount: 0,
      resultingOrderIds: []
    };
    this.statusBroadcasts.set(status.id, status);

    if (input.sellerConversationId) {
      this.deps.createConversationMessage({
        sessionId: input.sessionId,
        conversationId: input.sellerConversationId,
        clientMessageId: randomUUID(),
        content: { type: "status-broadcast", statusBroadcastId: status.id },
        author: "system",
        now
      });
    }

    return status;
  }

  getStatusBroadcast(input: {
    sessionId: string | null;
    businessId: string;
    statusBroadcastId: string;
    now?: Date;
  }): StatusBroadcastSummary {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "product:read",
      input.now
    );
    return this.requireStatusBroadcast(input.businessId, input.statusBroadcastId);
  }

  listStatusBroadcastsForBusiness(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): StatusBroadcastSummary[] {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "product:read",
      input.now
    );
    return [...this.statusBroadcasts.values()]
      .filter((status) => status.businessId === input.businessId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Recorded from the recipient's own session, not the business owner's - a contact who received
   * a status views/replies to it from their own account, so this deliberately does not go through
   * requireAuthorizedSession/businessId scoping like the seller-facing methods above. No frontend
   * viewer calls this yet (that is the buy-side flow); it exists so the object's counters are
   * genuinely trackable end-to-end rather than hardcoded at zero.
   */
  recordStatusBroadcastView(input: {
    sessionId: string | null;
    statusBroadcastId: string;
    now?: Date;
  }): StatusBroadcastSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const status = this.requireStatusBroadcastById(input.statusBroadcastId);
    const recipient = this.recipientForViewer(status, session.user.id);
    if (recipient === undefined || recipient.viewedAt !== null) return status;
    const updated: StatusBroadcastSummary = {
      ...status,
      viewCount: status.viewCount + 1,
      recipients: status.recipients.map((candidate) =>
        candidate.networkNodeId === recipient.networkNodeId
          ? { ...candidate, viewedAt: now.toISOString() }
          : candidate
      )
    };
    this.statusBroadcasts.set(updated.id, updated);
    return updated;
  }

  recordStatusBroadcastReply(input: {
    sessionId: string | null;
    statusBroadcastId: string;
    now?: Date;
  }): StatusBroadcastSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const status = this.requireStatusBroadcastById(input.statusBroadcastId);
    const recipient = this.recipientForViewer(status, session.user.id);
    if (recipient === undefined || recipient.repliedAt !== null) return status;
    const updated: StatusBroadcastSummary = {
      ...status,
      replyCount: status.replyCount + 1,
      recipients: status.recipients.map((candidate) =>
        candidate.networkNodeId === recipient.networkNodeId
          ? { ...candidate, repliedAt: now.toISOString() }
          : candidate
      )
    };
    this.statusBroadcasts.set(updated.id, updated);
    return updated;
  }

  /**
   * Statuses delivered "in_app" to the caller's own account - queried from the viewer's own
   * session, not a business owner's, since this is the recipient side of a broadcast posted by
   * someone else's business. No frontend viewer calls this yet (buy-side flow); it exists so
   * "in_app" delivery is something a recipient can genuinely retrieve.
   */
  listStatusBroadcastsReceivedByViewer(input: {
    sessionId: string | null;
    now?: Date;
  }): StatusBroadcastSummary[] {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    return [...this.statusBroadcasts.values()]
      .filter((status) => this.recipientForViewer(status, session.user.id) !== undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * One query, fanned out across the buyer's own/connected catalogue search
   * (listPublicStorefronts, already a real cross-business search - see its own doc) and their
   * contacts' active statuses (listStatusBroadcastsReceivedByViewer), merged and ranked here in
   * one place server-side. Contacts get a flat relevance bonus so they win at comparable
   * relevance, not unconditionally - a much stronger catalogue match can still outrank a barely
   * relevant contact result. marketplace_connector results never appear: none is integrated.
   */
  searchBuyFeed(input: { sessionId: string | null; query: string; now?: Date }): BuyFeedSummary {
    const now = input.now ?? new Date();
    const query = input.query.trim().slice(0, 120);

    const catalogueResults: BuyResultSummary[] = this.deps
      .listPublicStorefronts({ search: query, limit: 50 })
      .flatMap((storefront) =>
        storefront.products.map((product) => ({
          id: `catalogue:${storefront.agentId}:${product.id}`,
          title: product.name,
          price: product.sellingPrice,
          image: product.image,
          sourceKind: "catalogue" as const,
          sourceLabel: storefront.businessName,
          sourceId: storefront.agentId,
          agentId: storefront.agentId,
          productId: product.id,
          statusBroadcastId: null,
          productCaptureItemId: null
        }))
      );

    let contactResults: BuyResultSummary[] = [];
    const session = this.trySession(input.sessionId, now);
    if (session !== null) {
      contactResults = this.listStatusBroadcastsReceivedByViewer({
        sessionId: input.sessionId,
        now
      }).flatMap((status) => {
        const sourceLabel = this.contactLabelForStatus(status, session.user.id);
        return status.items.map((item) => ({
          id: `contact:${status.id}:${item.productCaptureItemId}`,
          title: item.title,
          price: item.visiblePrice,
          image: item.image,
          sourceKind: "contact" as const,
          sourceLabel,
          sourceId: status.id,
          agentId: null,
          productId: null,
          statusBroadcastId: status.id,
          productCaptureItemId: item.productCaptureItemId
        }));
      });
    }

    const scored = [...catalogueResults, ...contactResults].map((result) => ({
      result,
      score: buyTextRelevanceScore(result.title, query) + (result.sourceKind === "contact" ? 50 : 0)
    }));
    const results = scored
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((candidate) => candidate.result);

    return { query, results, marketplaceConnectorAvailable: false };
  }

  /**
   * Fans one checkout action out into one order per distinct source (business or contact status),
   * never one per item. Per-item failures (out of stock, status no longer active) are collected
   * into `failures` and surfaced to the buyer rather than silently dropped or cancelling sibling
   * sources. No payment is captured anywhere here - every created order starts in the same
   * "requested"/draft-invoice state the existing guest storefront checkout already uses.
   */
  quoteBuyerCheckout(input: { sessionId: string | null; items: BuyCheckoutItemInput[] }): {
    items: BuyCheckoutItemInput[];
    summary: string;
  } {
    const session = this.deps.requirePinVerifiedSession(input.sessionId, new Date());
    let total = 0;
    let incomplete = false;
    const quantities = new Map<string, number>();
    const lines: string[] = [];
    const items = input.items.map((item) => {
      if (item.sourceKind === "marketplace_connector") {
        const url = new URL(item.websiteUrl!);
        if (url.protocol !== "https:" || url.username || url.password) {
          throw new Cp2Error(
            400,
            "external_website_url_invalid",
            "Use a valid HTTPS retailer URL."
          );
        }
        incomplete = true;
        lines.push(
          `• ${item.title} × ${item.quantity} — ${url.hostname}: price unconfirmed, website checkout pending\n${url.href}`
        );
        return { ...item, sourceLabel: url.hostname, websiteUrl: url.href };
      }
      let title: string;
      let sourceLabel: string;
      let price: number | null;
      if (item.sourceKind === "catalogue") {
        const business = this.deps.businesses.get(this.businessIdForAgentId(item.sourceId) ?? "");
        const product = this.deps.products.get(item.productId ?? "");
        const quantity = item.quantity + (quantities.get(item.productId ?? "") ?? 0);
        if (
          !business ||
          !product ||
          product.businessId !== business.id ||
          quantity > product.quantity ||
          product.sellingPrice === null
        ) {
          throw new Cp2Error(
            409,
            "buyer_checkout_item_unavailable",
            "An item is unavailable. Search for it again."
          );
        }
        quantities.set(product.id, quantity);
        title = product.name;
        sourceLabel = business.name;
        price = product.sellingPrice;
      } else {
        const status = this.statusBroadcasts.get(item.sourceId);
        const source = status?.items.find(
          (candidate) => candidate.productCaptureItemId === item.productCaptureItemId
        );
        if (
          !status ||
          status.state !== "active" ||
          !source ||
          !this.recipientForViewer(status, session.user.id)
        ) {
          throw new Cp2Error(
            409,
            "buyer_checkout_item_unavailable",
            "A contact item is unavailable."
          );
        }
        title = source.title;
        sourceLabel = this.contactLabelForStatus(status, session.user.id);
        price = source.visiblePrice;
      }
      if (price === null) incomplete = true;
      else total += price * item.quantity;
      lines.push(
        `• ${title} × ${item.quantity} — ${sourceLabel}: ${price === null ? "price on request" : `KSh ${(price * item.quantity).toFixed(2)}`}`
      );
      return { ...item, title, sourceLabel };
    });
    return {
      items,
      summary: [...lines, `${incomplete ? "Known total" : "Total"}: KSh ${total.toFixed(2)}`].join(
        "\n"
      )
    };
  }

  createUnifiedCheckout(input: {
    sessionId: string | null;
    items: BuyCheckoutItemInput[];
    sellerConversationId?: string | null;
    /** Durable idempotency key (docs/architecture/durable-execution-plane.md "Idempotency"),
     *  scoped to the buyer account. A retry/resume that presents the same key reuses the
     *  already-created checkout (and its orders) instead of creating a second one - the same
     *  check-then-write discipline `RuntimeHandoffDomain.withIdempotency` already applies to every
     *  runtime-handoff mutation, applied here to the one non-idempotent, order-creating capability
     *  reachable from chat (`commerce.checkout`). Durable because it is stored on the
     *  already-persisted `UnifiedCheckoutSummary` row, not a separate in-memory-only cache. */
    idempotencyKey?: string;
    now?: Date;
  }): UnifiedCheckoutSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    if (input.idempotencyKey !== undefined) {
      const existing = [...this.unifiedCheckouts.values()].find(
        (checkout) =>
          checkout.buyerAccountId === session.account.id &&
          checkout.idempotencyKey === input.idempotencyKey
      );
      if (existing !== undefined) {
        return this.getUnifiedCheckout({
          sessionId: input.sessionId,
          unifiedCheckoutId: existing.id,
          now
        });
      }
    }
    if (input.items.length === 0 || input.items.length > 100) {
      throw new Cp2Error(
        400,
        "buy_checkout_items_invalid",
        "Checkout needs between 1 and 100 items."
      );
    }

    const handoffs: UnifiedCheckoutHandoffSummary[] = [];
    const failures: UnifiedCheckoutFailureSummary[] = [];
    const externalRequests: NonNullable<UnifiedCheckoutSummary["externalRequests"]> = [];

    const catalogueGroups = new Map<string, BuyCheckoutItemInput[]>();
    const contactGroups = new Map<string, BuyCheckoutItemInput[]>();
    for (const item of input.items) {
      if (item.sourceKind === "catalogue") {
        const group = catalogueGroups.get(item.sourceId) ?? [];
        group.push(item);
        catalogueGroups.set(item.sourceId, group);
      } else if (item.sourceKind === "contact") {
        const group = contactGroups.get(item.sourceId) ?? [];
        group.push(item);
        contactGroups.set(item.sourceId, group);
      } else if (
        item.sourceKind === "marketplace_connector" &&
        item.websiteUrl &&
        Number.isInteger(item.quantity) &&
        item.quantity > 0
      ) {
        let url: URL;
        try {
          url = new URL(item.websiteUrl);
        } catch {
          throw new Cp2Error(
            400,
            "external_website_url_invalid",
            "Use a valid HTTPS retailer URL."
          );
        }
        if (url.protocol !== "https:" || url.username || url.password) {
          throw new Cp2Error(
            400,
            "external_website_url_invalid",
            "Use a valid HTTPS retailer URL without credentials."
          );
        }
        externalRequests.push({
          websiteUrl: url.href,
          sourceLabel: url.hostname,
          title: item.title,
          quantity: item.quantity
        });
      } else {
        failures.push({
          checkoutItemIndex: input.items.indexOf(item),
          sourceLabel: item.sourceLabel,
          title: item.title,
          reason: "No marketplace connector is available for this item."
        });
      }
    }

    for (const [agentId, items] of catalogueGroups) {
      const business = this.deps.businesses.get(this.businessIdForAgentId(agentId) ?? "");
      if (business === undefined) {
        for (const item of items) {
          failures.push({
            checkoutItemIndex: input.items.indexOf(item),
            sourceLabel: item.sourceLabel,
            title: item.title,
            reason: "Shop unavailable."
          });
        }
        continue;
      }
      const resolved: Array<{ item: BuyCheckoutItemInput; product: ProductSummary }> = [];
      const requestedQuantities = new Map<string, number>();
      for (const item of items) {
        const product =
          item.productId === null ? undefined : this.deps.products.get(item.productId);
        if (product === undefined || product.businessId !== business.id || product.quantity <= 0) {
          failures.push({
            checkoutItemIndex: input.items.indexOf(item),
            sourceLabel: item.sourceLabel,
            title: item.title,
            reason: "No longer available."
          });
          continue;
        }
        if (
          !Number.isInteger(item.quantity) ||
          item.quantity < 1 ||
          item.quantity + (requestedQuantities.get(product.id) ?? 0) > product.quantity
        ) {
          failures.push({
            checkoutItemIndex: input.items.indexOf(item),
            sourceLabel: item.sourceLabel,
            title: item.title,
            reason: "Not enough stock."
          });
          continue;
        }
        if (product.sellingPrice === null) {
          failures.push({
            checkoutItemIndex: input.items.indexOf(item),
            sourceLabel: item.sourceLabel,
            title: item.title,
            reason: "Price unavailable."
          });
          continue;
        }
        requestedQuantities.set(
          product.id,
          (requestedQuantities.get(product.id) ?? 0) + item.quantity
        );
        resolved.push({ item, product });
      }
      if (resolved.length === 0) continue;

      const invoiceId = randomUUID();
      const invoice = this.deps.buildStoredInvoice({
        businessId: business.id,
        invoiceId,
        invoiceNumber: this.deps.nextInvoiceNumber(business.id),
        input: {
          customerId: null,
          customerName: session.user.displayName,
          taxRate: 0,
          items: resolved.map(({ item, product }) => ({
            productId: product.id,
            quantity: item.quantity,
            unitPrice: product.sellingPrice as number
          }))
        },
        status: "draft",
        confirmedAt: null,
        now,
        // Marketplace checkout by a Grogoni buyer account (web or the commerce.checkout capability).
        source: "GROGONI_CHAT",
        sourceMessageChannel: "grogoni"
      });
      this.deps.invoices.set(invoice.id, invoice);

      const order: BuyOrderSummary = {
        id: randomUUID(),
        businessId: business.id,
        buyerAccountId: session.account.id,
        invoiceId: invoice.id,
        items: resolved.map(({ item, product }) => ({
          productId: product.id,
          productName: product.name,
          unit: product.unit,
          quantity: item.quantity,
          unitPrice: product.sellingPrice as number
        })),
        status: "requested",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      };
      this.buyOrders.set(order.id, order);
      handoffs.push({
        kind: "catalogue",
        sourceLabel: business.name,
        orderId: order.id,
        status: order.status,
        items: order.items.map((item) => ({
          title: item.productName,
          quantity: item.quantity,
          unitPrice: item.unitPrice
        }))
      });
    }

    for (const [statusBroadcastId, items] of contactGroups) {
      const status = this.statusBroadcasts.get(statusBroadcastId);
      if (
        status === undefined ||
        status.state !== "active" ||
        this.recipientForViewer(status, session.user.id) === undefined
      ) {
        for (const item of items) {
          failures.push({
            checkoutItemIndex: input.items.indexOf(item),
            sourceLabel: item.sourceLabel,
            title: item.title,
            reason: "This status is no longer active."
          });
        }
        continue;
      }
      const resolved: StatusOrderItemSummary[] = [];
      for (const item of items) {
        const sourceItem = status.items.find(
          (candidate) => candidate.productCaptureItemId === item.productCaptureItemId
        );
        if (sourceItem === undefined) {
          failures.push({
            checkoutItemIndex: input.items.indexOf(item),
            sourceLabel: item.sourceLabel,
            title: item.title,
            reason: "This item is no longer part of the status."
          });
          continue;
        }
        if (!Number.isInteger(item.quantity) || item.quantity < 1) {
          failures.push({
            checkoutItemIndex: input.items.indexOf(item),
            sourceLabel: item.sourceLabel,
            title: item.title,
            reason: "Invalid quantity."
          });
          continue;
        }
        resolved.push({
          productCaptureItemId: sourceItem.productCaptureItemId,
          title: sourceItem.title,
          price: sourceItem.visiblePrice,
          quantity: item.quantity
        });
      }
      if (resolved.length === 0) continue;

      const order: StatusOrderSummary = {
        id: randomUUID(),
        statusBroadcastId,
        buyerAccountId: session.account.id,
        items: resolved,
        status: "requested",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString()
      };
      this.statusOrders.set(order.id, order);
      this.statusBroadcasts.set(status.id, {
        ...status,
        resultingOrderIds: [...status.resultingOrderIds, order.id]
      });
      handoffs.push({
        kind: "contact",
        sourceLabel: this.contactLabelForStatus(status, session.user.id),
        orderId: order.id,
        status: order.status,
        items: order.items.map((item) => ({
          title: item.title,
          quantity: item.quantity,
          unitPrice: item.price
        }))
      });
    }

    const checkout: UnifiedCheckoutSummary = {
      id: randomUUID(),
      buyerAccountId: session.account.id,
      handoffs,
      failures,
      externalRequests,
      createdAt: now.toISOString(),
      idempotencyKey: input.idempotencyKey ?? null
    };
    this.unifiedCheckouts.set(checkout.id, checkout);

    if (input.sellerConversationId) {
      this.deps.createConversationMessage({
        sessionId: input.sessionId,
        conversationId: input.sellerConversationId,
        clientMessageId: randomUUID(),
        content: { type: "unified-checkout", unifiedCheckoutId: checkout.id },
        author: "system",
        now
      });
    }

    return checkout;
  }

  getUnifiedCheckout(input: {
    sessionId: string | null;
    unifiedCheckoutId: string;
    now?: Date;
  }): UnifiedCheckoutSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const checkout = this.unifiedCheckouts.get(input.unifiedCheckoutId);
    if (checkout === undefined || checkout.buyerAccountId !== session.account.id) {
      throw new Cp2Error(404, "unified_checkout_not_found", "Checkout was not found.");
    }
    const handoffs = checkout.handoffs.map((handoff) => {
      if (handoff.kind === "catalogue") {
        const order = this.buyOrders.get(handoff.orderId);
        return order === undefined
          ? handoff
          : {
              ...handoff,
              status: order.status,
              items:
                handoff.items ??
                order.items.map((item) => ({
                  title: item.productName,
                  quantity: item.quantity,
                  unitPrice: item.unitPrice
                }))
            };
      }
      const order = this.statusOrders.get(handoff.orderId);
      return order === undefined
        ? handoff
        : {
            ...handoff,
            status: order.status,
            items:
              handoff.items ??
              order.items.map((item) => ({
                title: item.title,
                quantity: item.quantity,
                unitPrice: item.price
              }))
          };
    });
    return { ...checkout, handoffs };
  }

  private recipientForViewer(
    status: StatusBroadcastSummary,
    viewerUserId: string
  ): StatusBroadcastRecipientSummary | undefined {
    return status.recipients.find((candidate) => {
      const node = this.deps.networkNodes.get(candidate.networkNodeId);
      return node?.grogoniUserId === viewerUserId;
    });
  }

  private accountIdForNetworkNode(node: NetworkNodeSummary): string | null {
    if (node.grogoniUserId === null) return null;
    return this.deps.users.get(node.grogoniUserId)?.accountId ?? null;
  }

  private requireStatusBroadcastById(statusBroadcastId: string): StatusBroadcastSummary {
    const status = this.statusBroadcasts.get(statusBroadcastId);
    if (status === undefined) {
      throw new Cp2Error(404, "status_broadcast_not_found", "Status was not found.");
    }
    return status;
  }

  private requireStatusBroadcast(
    businessId: string,
    statusBroadcastId: string
  ): StatusBroadcastSummary {
    const status = this.requireStatusBroadcastById(statusBroadcastId);
    if (status.businessId !== businessId) {
      throw new Cp2Error(404, "status_broadcast_not_found", "Status was not found.");
    }
    return status;
  }

  /**
   * A status is posted by a business, but the buyer thinks of it as coming from a contact. This
   * looks up how the *buyer's own* phone contacts name the seller (not, as it's easy to get
   * backwards, how the seller's contacts name the buyer) - falling back to the business name when
   * the buyer's own contact graph doesn't have the reverse relationship synced.
   */
  private contactLabelForStatus(status: StatusBroadcastSummary, viewerUserId: string): string {
    const contactNode = [...this.deps.networkNodes.values()].find(
      (node) => node.ownerUserId === viewerUserId && node.grogoniUserId === status.postedBy
    );
    return (
      contactNode?.displayName ?? this.deps.businesses.get(status.businessId)?.name ?? "Contact"
    );
  }

  private trySession(sessionId: string | null, now: Date): AuthenticatedActorView | null {
    try {
      return this.deps.requirePinVerifiedSession(sessionId, now);
    } catch (error) {
      if (error instanceof Cp2Error) return null;
      throw error;
    }
  }

  private businessIdForAgentId(agentId: string): string | undefined {
    return [...this.deps.businesses.values()].find((business) => business.grogoniId === agentId)
      ?.id;
  }
}
