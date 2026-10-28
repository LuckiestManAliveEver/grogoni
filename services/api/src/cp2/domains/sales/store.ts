import { randomUUID } from "node:crypto";
import type {
  AccountSummary,
  AuthenticatedActorView,
  BusinessSummary,
  CatalogueQueryResult,
  ChannelProvider,
  CustomerDebtSummary,
  CustomerSummary,
  InventoryMovementSummary,
  InvoiceItemSummary,
  InvoicePaymentSummary,
  InvoicePreview,
  InvoiceSummary,
  PaymentSummary,
  PlatformIdentitySummary,
  ProductFieldDefinition,
  ProductFieldSchemaSummary,
  ProductSummary,
  PublicCustomerCareRequestSummary,
  PublicCustomerCareRequestType,
  PublicOrderSummary,
  PublicStorefrontMessageSummary,
  MessageChannel,
  OrderSource,
  CommerceOfferOrderSnapshot
} from "@grogoni/shared-types";
import {
  createInvoicePaymentSummary,
  createInvoicePreview,
  customerCreatedEvent,
  customerUpdatedEvent,
  invoiceConfirmedEvent,
  invoiceCreatedEvent,
  invoiceUpdatedEvent,
  normalizeContactRecordInput,
  normalizeInvoiceInput,
  normalizePaymentInput,
  normalizeProductInput,
  snapshotInvoiceLineWeight,
  normalizeStockAdjustmentInput,
  paymentRecordedEvent,
  productCreatedEvent,
  productDeletedEvent,
  productUpdatedEvent,
  queryCatalogueProducts,
  stockAdjustedEvent,
  validateContactRecordInput,
  validateInvoiceInput,
  validatePaymentInput,
  validateProductInput,
  validateStockAdjustmentInput,
  type BusinessPermission,
  type ContactRecordInput,
  type InvoiceInput,
  type PaymentInput,
  type ProductInput,
  type StockAdjustmentInput
} from "@grogoni/business-core";
import type { BusinessEvent } from "@grogoni/event-core";
import { assertValid, Cp2Error } from "../../cp2-error.js";
import { roundMoney } from "../../money.js";
import {
  normalizeOptionalBoundedText,
  normalizeRequiredBoundedText
} from "../../text-normalization.js";
import { normalizeEmailIdentity } from "../../email-identity.js";
import { requirePublicStorefrontBusiness } from "../../storefront-access.js";
import type { CustomerRuntimeCapabilityRecord } from "../../domain-contracts.js";
import {
  defaultProductFieldDefinitions,
  normalizeProductFieldDefinitions,
  type ProductMediaRecord
} from "./shared.js";
import type { Cp2Snapshot } from "../../store.js";

export interface SalesDomainDeps {
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
  appendBusinessEvent: (event: BusinessEvent) => void;
  requireAccount: (accountId: string) => AccountSummary;
  requireCustomerCapability: (
    token: string,
    businessId: string,
    now: Date
  ) => CustomerRuntimeCapabilityRecord;
  findPlatformIdentity: (platformIdentityId: string) => PlatformIdentitySummary | undefined;
  relinkPlatformIdentitiesForCustomer: (
    businessId: string,
    customerId: string,
    accountId: string,
    now: Date
  ) => void;
  businesses: Map<string, BusinessSummary>;
  quarantinedBusinessIds: Set<string>;
  /** Called after an invoice is confirmed, on every confirmation path (fulfillment intake). */
  onInvoiceConfirmed?: (invoice: InvoiceSummary, actorId: string) => void;
  recordPurchasePriceMutation?: (input: {
    businessId: string;
    product: ProductSummary;
    previousPrice: number | null;
    price: number;
    actorId: string;
    source: "MANUAL";
    now: Date;
  }) => void;
}

export class SalesDomain {
  private readonly products = new Map<string, ProductSummary>();
  private readonly productMedia = new Map<string, ProductMediaRecord>();
  private readonly productFieldSchemas = new Map<string, ProductFieldSchemaSummary>();
  private readonly customers = new Map<string, CustomerSummary>();
  private readonly invoices = new Map<string, InvoiceSummary>();
  private readonly payments = new Map<string, PaymentSummary>();
  private readonly inventoryMovements = new Map<string, InventoryMovementSummary>();
  private readonly publicOrders = new Map<string, PublicOrderSummary>();
  private readonly publicStorefrontMessages = new Map<string, PublicStorefrontMessageSummary>();
  private readonly publicCustomerCareRequests = new Map<string, PublicCustomerCareRequestSummary>();
  private readonly nextInvoiceNumberByBusiness = new Map<string, number>();

  constructor(private readonly deps: SalesDomainDeps) {}

  get productsMap(): Map<string, ProductSummary> {
    return this.products;
  }

  get productMediaMap(): Map<string, ProductMediaRecord> {
    return this.productMedia;
  }

  get productFieldSchemasMap(): Map<string, ProductFieldSchemaSummary> {
    return this.productFieldSchemas;
  }

  get customersMap(): Map<string, CustomerSummary> {
    return this.customers;
  }

  get invoicesMap(): Map<string, InvoiceSummary> {
    return this.invoices;
  }

  get paymentsMap(): Map<string, PaymentSummary> {
    return this.payments;
  }

  get inventoryMovementsMap(): Map<string, InventoryMovementSummary> {
    return this.inventoryMovements;
  }

  get publicOrdersMap(): Map<string, PublicOrderSummary> {
    return this.publicOrders;
  }

  get publicStorefrontMessagesMap(): Map<string, PublicStorefrontMessageSummary> {
    return this.publicStorefrontMessages;
  }

  get publicCustomerCareRequestsMap(): Map<string, PublicCustomerCareRequestSummary> {
    return this.publicCustomerCareRequests;
  }

  clear(): void {
    this.products.clear();
    this.productMedia.clear();
    this.productFieldSchemas.clear();
    this.customers.clear();
    this.invoices.clear();
    this.payments.clear();
    this.inventoryMovements.clear();
    this.publicOrders.clear();
    this.publicStorefrontMessages.clear();
    this.publicCustomerCareRequests.clear();
    this.nextInvoiceNumberByBusiness.clear();
  }

  restore(snapshot: Cp2Snapshot): void {
    for (const product of snapshot.products) {
      this.products.set(product.id, {
        ...product,
        aliases: product.aliases ?? [],
        primaryMediaId: product.primaryMediaId ?? null
      });
    }
    for (const media of snapshot.productMedia ?? []) this.productMedia.set(media.id, media);

    for (const schema of snapshot.productFieldSchemas ?? []) {
      this.productFieldSchemas.set(schema.businessId, {
        ...schema,
        fields: schema.fields.map((field) => ({ ...field }))
      });
    }

    for (const customer of snapshot.customers) {
      this.customers.set(customer.id, {
        ...customer,
        linkedAccountId: customer.linkedAccountId ?? null
      });
    }

    for (const invoice of snapshot.invoices) {
      this.invoices.set(invoice.id, invoice);
      const invoiceNumber = Number(invoice.invoiceNumber.replace(/^INV-/, ""));
      const nextNumber = Number.isInteger(invoiceNumber) ? invoiceNumber + 1 : 1;
      this.nextInvoiceNumberByBusiness.set(
        invoice.businessId,
        Math.max(this.nextInvoiceNumberByBusiness.get(invoice.businessId) ?? 1, nextNumber)
      );
    }

    for (const payment of snapshot.payments) {
      this.payments.set(payment.id, payment);
    }

    for (const request of snapshot.publicCustomerCareRequests ?? []) {
      this.publicCustomerCareRequests.set(request.id, request);
    }

    for (const message of snapshot.publicStorefrontMessages ?? []) {
      this.publicStorefrontMessages.set(message.id, message);
    }

    for (const order of snapshot.publicOrders ?? []) {
      this.publicOrders.set(order.id, order);
    }

    for (const item of snapshot.inventoryMovements) {
      this.inventoryMovements.set(item.id, item);
    }
  }

  listProducts(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): ProductSummary[] {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "product:read",
      input.now
    );
    return [...this.products.values()].filter((product) => product.businessId === input.businessId);
  }

  queryCatalogue(input: {
    sessionId: string | null;
    businessId: string;
    query: string;
    limit?: number;
    now?: Date;
  }): CatalogueQueryResult {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "product:read",
      input.now
    );
    return queryCatalogueProducts({
      businessId: input.businessId,
      products: [...this.products.values()],
      query: input.query,
      imageForProduct: (product) => this.publicProductImage(product),
      ...(input.limit === undefined ? {} : { limit: input.limit })
    });
  }

  getProductFieldSchema(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): ProductFieldSchemaSummary {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "product:read",
      input.now
    );
    return (
      this.productFieldSchemas.get(input.businessId) ?? {
        businessId: input.businessId,
        fields: defaultProductFieldDefinitions(),
        updatedAt: new Date(0).toISOString()
      }
    );
  }

  saveProductFieldSchema(input: {
    sessionId: string | null;
    businessId: string;
    fields: ProductFieldDefinition[];
    now?: Date;
  }): ProductFieldSchemaSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "product:write",
      now
    );
    const fields = normalizeProductFieldDefinitions(input.fields);
    const schema: ProductFieldSchemaSummary = {
      businessId: input.businessId,
      fields,
      updatedAt: now.toISOString()
    };
    this.productFieldSchemas.set(input.businessId, schema);
    this.deps.recordAuditEvent({
      type: "product.fields_updated",
      aggregateType: "business",
      aggregateId: input.businessId,
      actorId: session.user.id,
      occurredAt: now.toISOString(),
      payload: { fieldCount: fields.length }
    });
    return schema;
  }

  getPublicProductMedia(input: { mediaId: string }): ProductMediaRecord {
    const media = this.productMedia.get(input.mediaId);
    if (media === undefined || media.productId === null) {
      throw new Cp2Error(404, "product_media_not_found", "Product image was not found.");
    }
    return media;
  }

  createProduct(input: {
    sessionId: string | null;
    businessId: string;
    product: ProductInput;
    now?: Date;
  }): ProductSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "product:write",
      now
    );
    assertValid(validateProductInput(input.product));
    const normalized = normalizeProductInput(input.product);
    const product: ProductSummary = {
      id: randomUUID(),
      businessId: input.businessId,
      name: normalized.name,
      sku: normalized.sku,
      aliases: normalized.aliases,
      primaryMediaId: null,
      unit: normalized.unit,
      quantity: normalized.quantity,
      buyingPrice: normalized.buyingPrice,
      sellingPrice: normalized.sellingPrice,
      unitWeightGrams: normalized.unitWeightGrams ?? null,
      fieldValues: normalized.fieldValues,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };

    this.products.set(product.id, product);
    if (product.buyingPrice !== null) {
      this.deps.recordPurchasePriceMutation?.({
        businessId: input.businessId,
        product,
        previousPrice: null,
        price: product.buyingPrice,
        actorId: session.user.id,
        source: "MANUAL",
        now
      });
    }
    this.deps.appendBusinessEvent(
      productCreatedEvent({
        id: randomUUID(),
        product,
        actorId: session.user.id,
        occurredAt: now.toISOString()
      })
    );

    if (product.quantity > 0) {
      this.createInventoryMovement({
        businessId: input.businessId,
        productId: product.id,
        quantityBefore: 0,
        quantityAfter: product.quantity,
        reason: "Initial product quantity",
        actorId: session.user.id,
        now
      });
    }

    return product;
  }

  updateProduct(input: {
    sessionId: string | null;
    businessId: string;
    productId: string;
    product: ProductInput;
    now?: Date;
  }): ProductSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "product:write",
      now
    );
    const existing = this.requireProduct(input.businessId, input.productId);
    assertValid(validateProductInput(input.product));
    const normalized = normalizeProductInput(input.product);
    const updated: ProductSummary = {
      ...existing,
      name: normalized.name,
      sku: normalized.sku,
      aliases: input.product.aliases === undefined ? (existing.aliases ?? []) : normalized.aliases,
      primaryMediaId: existing.primaryMediaId ?? null,
      unit: normalized.unit,
      quantity: normalized.quantity,
      buyingPrice: normalized.buyingPrice,
      sellingPrice: normalized.sellingPrice,
      unitWeightGrams:
        normalized.unitWeightGrams === undefined
          ? (existing.unitWeightGrams ?? null)
          : normalized.unitWeightGrams,
      fieldValues:
        input.product.fieldValues === undefined
          ? (existing.fieldValues ?? {})
          : normalized.fieldValues,
      updatedAt: now.toISOString()
    };

    this.products.set(updated.id, updated);
    if (updated.buyingPrice !== null && updated.buyingPrice !== existing.buyingPrice) {
      this.deps.recordPurchasePriceMutation?.({
        businessId: input.businessId,
        product: updated,
        previousPrice: existing.buyingPrice,
        price: updated.buyingPrice,
        actorId: session.user.id,
        source: "MANUAL",
        now
      });
    }
    this.deps.appendBusinessEvent(
      productUpdatedEvent({
        id: randomUUID(),
        product: updated,
        actorId: session.user.id,
        occurredAt: now.toISOString()
      })
    );

    if (existing.quantity !== updated.quantity) {
      this.createInventoryMovement({
        businessId: input.businessId,
        productId: updated.id,
        quantityBefore: existing.quantity,
        quantityAfter: updated.quantity,
        reason: "Product quantity updated",
        actorId: session.user.id,
        now
      });
    }

    return updated;
  }

  deleteProduct(input: {
    sessionId: string | null;
    businessId: string;
    productId: string;
    now?: Date;
  }): ProductSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "product:write",
      now
    );
    const product = this.requireProduct(input.businessId, input.productId);

    this.products.delete(product.id);
    this.deps.appendBusinessEvent(
      productDeletedEvent({
        id: randomUUID(),
        product,
        actorId: session.user.id,
        occurredAt: now.toISOString()
      })
    );

    return product;
  }

  adjustProductStock(input: {
    sessionId: string | null;
    businessId: string;
    productId: string;
    adjustment: StockAdjustmentInput;
    now?: Date;
  }): { product: ProductSummary; movement: InventoryMovementSummary } {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "inventory:adjust",
      now
    );
    const product = this.requireProduct(input.businessId, input.productId);
    assertValid(validateStockAdjustmentInput(input.adjustment));
    const normalized = normalizeStockAdjustmentInput(input.adjustment);
    const updated: ProductSummary = {
      ...product,
      quantity: normalized.quantityAfter,
      updatedAt: now.toISOString()
    };

    this.products.set(updated.id, updated);
    const movement = this.createInventoryMovement({
      businessId: input.businessId,
      productId: product.id,
      quantityBefore: product.quantity,
      quantityAfter: normalized.quantityAfter,
      reason: normalized.reason,
      actorId: session.user.id,
      now
    });

    return {
      product: updated,
      movement
    };
  }

  listCustomers(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): CustomerSummary[] {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "customer:read",
      input.now
    );
    return [...this.customers.values()].filter(
      (customer) => customer.businessId === input.businessId
    );
  }

  createCustomer(input: {
    sessionId: string | null;
    businessId: string;
    customer: ContactRecordInput;
    now?: Date;
  }): CustomerSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "customer:write",
      now
    );
    assertValid(validateContactRecordInput(input.customer, "Customer"));
    const normalized = normalizeContactRecordInput(input.customer);
    const customer: CustomerSummary = {
      id: randomUUID(),
      businessId: input.businessId,
      name: normalized.name,
      phone: normalized.phone,
      email: normalized.email,
      linkedAccountId: null,
      notes: normalized.notes,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };

    this.customers.set(customer.id, customer);
    this.deps.appendBusinessEvent(
      customerCreatedEvent({
        id: randomUUID(),
        customer,
        actorId: session.user.id,
        occurredAt: now.toISOString()
      })
    );

    return customer;
  }

  updateCustomer(input: {
    sessionId: string | null;
    businessId: string;
    customerId: string;
    customer: ContactRecordInput;
    now?: Date;
  }): CustomerSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "customer:write",
      now
    );
    const existing = this.requireCustomer(input.businessId, input.customerId);
    assertValid(validateContactRecordInput(input.customer, "Customer"));
    const normalized = normalizeContactRecordInput(input.customer);
    const updated: CustomerSummary = {
      ...existing,
      name: normalized.name,
      phone: normalized.phone,
      email: normalized.email,
      notes: normalized.notes,
      updatedAt: now.toISOString()
    };

    this.customers.set(updated.id, updated);
    this.deps.appendBusinessEvent(
      customerUpdatedEvent({
        id: randomUUID(),
        customer: updated,
        actorId: session.user.id,
        occurredAt: now.toISOString()
      })
    );

    return updated;
  }

  linkCustomerAccount(input: {
    sessionId: string | null;
    businessId: string;
    customerId: string;
    accountId: string;
    now?: Date;
  }): CustomerSummary {
    const now = input.now ?? new Date();
    const auth = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "customer:write",
      now
    );
    const customer = this.requireCustomer(input.businessId, input.customerId);
    this.deps.requireAccount(input.accountId);
    const conflict = [...this.customers.values()].find(
      (candidate) =>
        candidate.businessId === input.businessId &&
        candidate.id !== customer.id &&
        candidate.linkedAccountId === input.accountId
    );
    if (conflict) {
      throw new Cp2Error(
        409,
        "customer_account_already_linked",
        "This Grogoni account is already linked to another customer."
      );
    }
    const linked: CustomerSummary = {
      ...customer,
      linkedAccountId: input.accountId,
      updatedAt: now.toISOString()
    };
    this.customers.set(linked.id, linked);
    this.deps.relinkPlatformIdentitiesForCustomer(
      input.businessId,
      linked.id,
      input.accountId,
      now
    );
    this.deps.recordAuditEvent({
      type: "customer.account_linked",
      aggregateType: "customer",
      aggregateId: linked.id,
      actorId: auth.user.id,
      occurredAt: now.toISOString(),
      payload: { businessId: input.businessId, accountId: input.accountId }
    });
    return linked;
  }

  previewInvoice(input: {
    sessionId: string | null;
    businessId: string;
    invoice: InvoiceInput;
    now?: Date;
  }): InvoicePreview {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "invoice:write",
      input.now
    );
    assertValid(validateInvoiceInput(input.invoice));

    return this.buildInvoicePreview(input.businessId, input.invoice);
  }

  listInvoices(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): InvoiceSummary[] {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "invoice:read",
      input.now
    );
    return [...this.invoices.values()].filter((invoice) => invoice.businessId === input.businessId);
  }

  createInvoice(input: {
    sessionId: string | null;
    businessId: string;
    invoice: InvoiceInput;
    now?: Date;
  }): InvoiceSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "invoice:write",
      now
    );
    return this.createInvoiceAsActor({
      businessId: input.businessId,
      invoice: input.invoice,
      actorId: session.user.id,
      now
    });
  }

  updateInvoice(input: {
    sessionId: string | null;
    businessId: string;
    invoiceId: string;
    invoice: InvoiceInput;
    now?: Date;
  }): InvoiceSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "invoice:write",
      now
    );
    const existing = this.requireInvoice(input.businessId, input.invoiceId);

    if (existing.status !== "draft") {
      throw new Cp2Error(409, "invoice_already_confirmed", "Confirmed invoices cannot be edited.");
    }

    assertValid(validateInvoiceInput(input.invoice));
    const invoice = this.buildStoredInvoice({
      businessId: input.businessId,
      invoiceId: existing.id,
      invoiceNumber: existing.invoiceNumber,
      input: input.invoice,
      status: "draft",
      confirmedAt: null,
      now,
      createdAt: existing.createdAt,
      // Provenance belongs to the order, not to the edit: keep it unless the edit names a source.
      source: input.invoice.source ?? existing.source ?? null,
      sourceMessageChannel:
        input.invoice.sourceMessageChannel ?? existing.sourceMessageChannel ?? null,
      createdByUserId: existing.createdByUserId ?? null
    });

    this.invoices.set(invoice.id, invoice);
    this.deps.appendBusinessEvent(
      invoiceUpdatedEvent({
        id: randomUUID(),
        invoice,
        actorId: session.user.id,
        occurredAt: now.toISOString()
      })
    );

    return invoice;
  }

  confirmInvoice(input: {
    sessionId: string | null;
    businessId: string;
    invoiceId: string;
    now?: Date;
  }): { invoice: InvoiceSummary; movements: InventoryMovementSummary[] } {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "invoice:confirm",
      now
    );
    return this.confirmInvoiceAsActor({
      businessId: input.businessId,
      invoiceId: input.invoiceId,
      actorId: session.user.id,
      now
    });
  }

  /** Trusted channel adapter entry point. Authorization and identity resolution happen upstream. */
  createAndConfirmChannelInvoice(input: {
    businessId: string;
    customerId: string;
    items: Array<{ productId: string; quantity: number }>;
    source: OrderSource;
    sourceMessageChannel: MessageChannel;
    actorId: string;
    now: Date;
  }): { invoice: InvoiceSummary; movements: InventoryMovementSummary[] } {
    const invoice = this.createInvoiceAsActor({
      businessId: input.businessId,
      actorId: input.actorId,
      now: input.now,
      invoice: {
        customerId: input.customerId,
        customerName: null,
        taxRate: 0,
        source: input.source,
        sourceMessageChannel: input.sourceMessageChannel,
        items: input.items.map((item) => {
          const product = this.requireProduct(input.businessId, item.productId);
          return {
            productId: product.id,
            quantity: item.quantity,
            unitPrice: product.sellingPrice ?? 0
          };
        })
      }
    });
    return this.confirmInvoiceAsActor({
      businessId: input.businessId,
      invoiceId: invoice.id,
      actorId: input.actorId,
      now: input.now
    });
  }

  private createInvoiceAsActor(input: {
    businessId: string;
    invoice: InvoiceInput;
    actorId: string;
    now: Date;
  }): InvoiceSummary {
    assertValid(validateInvoiceInput(input.invoice));
    this.buildInvoicePreview(input.businessId, input.invoice);
    const invoice = this.buildStoredInvoice({
      businessId: input.businessId,
      invoiceId: randomUUID(),
      invoiceNumber: this.nextInvoiceNumber(input.businessId),
      input: input.invoice,
      status: "draft",
      confirmedAt: null,
      now: input.now,
      source: input.invoice.source ?? "MANUAL",
      sourceMessageChannel: input.invoice.sourceMessageChannel ?? null,
      createdByUserId: input.actorId
    });
    this.invoices.set(invoice.id, invoice);
    this.deps.appendBusinessEvent(
      invoiceCreatedEvent({
        id: randomUUID(),
        invoice,
        actorId: input.actorId,
        occurredAt: input.now.toISOString()
      })
    );
    return invoice;
  }

  private confirmInvoiceAsActor(input: {
    businessId: string;
    invoiceId: string;
    actorId: string;
    now: Date;
  }): { invoice: InvoiceSummary; movements: InventoryMovementSummary[] } {
    const now = input.now;
    const invoice = this.requireInvoice(input.businessId, input.invoiceId);

    if (invoice.status !== "draft") {
      throw new Cp2Error(409, "invoice_already_confirmed", "Invoice is already confirmed.");
    }

    const requiredQuantityByProduct = new Map<string, number>();

    for (const item of invoice.items) {
      const fulfillment = invoice.offerFulfillment?.find((line) => line.lineId === item.id);
      if (fulfillment && fulfillment.snapshot.productBusinessId !== input.businessId) {
        if (!fulfillment.fulfilledAt)
          throw new Cp2Error(
            409,
            "upstream_fulfillment_required",
            "The stock-owning supplier must confirm fulfillment before this invoice can be confirmed."
          );
        continue;
      }
      requiredQuantityByProduct.set(
        item.productId,
        (requiredQuantityByProduct.get(item.productId) ?? 0) + item.quantity
      );
    }

    for (const [productId, requiredQuantity] of requiredQuantityByProduct) {
      const product = this.requireProduct(input.businessId, productId);

      if (product.quantity < requiredQuantity) {
        throw new Cp2Error(
          409,
          "stock_insufficient",
          `${product.name} has ${product.quantity} ${product.unit} available.`
        );
      }
    }

    const movements: InventoryMovementSummary[] = [];

    for (const item of invoice.items) {
      if (
        invoice.offerFulfillment?.some(
          (line) => line.lineId === item.id && line.snapshot.productBusinessId !== input.businessId
        )
      )
        continue;
      const product = this.requireProduct(input.businessId, item.productId);
      const updatedProduct: ProductSummary = {
        ...product,
        quantity: product.quantity - item.quantity,
        updatedAt: now.toISOString()
      };

      this.products.set(updatedProduct.id, updatedProduct);
      movements.push(
        this.createInventoryMovement({
          businessId: input.businessId,
          productId: product.id,
          type: "sale",
          quantityBefore: product.quantity,
          quantityAfter: updatedProduct.quantity,
          reason: `Invoice ${invoice.invoiceNumber}`,
          actorId: input.actorId,
          now
        })
      );
    }

    // A4: snapshot each line's weight from the catalogue as it stands at confirmation. Confirmed
    // invoices are immutable, so later product edits can never alter these historical values.
    const weightedItems = invoice.items.map((item) => ({
      ...item,
      ...snapshotInvoiceLineWeight(
        invoice.offerFulfillment?.some(
          (line) => line.lineId === item.id && line.snapshot.productBusinessId !== input.businessId
        )
          ? null
          : this.requireProduct(input.businessId, item.productId).unitWeightGrams,
        item.quantity
      )
    }));
    const confirmed: InvoiceSummary = {
      ...invoice,
      items: weightedItems,
      status: "confirmed",
      confirmedAt: now.toISOString(),
      updatedAt: now.toISOString()
    };

    this.invoices.set(confirmed.id, confirmed);
    this.deps.onInvoiceConfirmed?.(confirmed, input.actorId);
    this.deps.appendBusinessEvent(
      invoiceConfirmedEvent({
        id: randomUUID(),
        invoice: confirmed,
        actorId: input.actorId,
        occurredAt: now.toISOString()
      })
    );

    return {
      invoice: confirmed,
      movements
    };
  }

  listPayments(input: {
    sessionId: string | null;
    businessId: string;
    invoiceId?: string;
    now?: Date;
  }): PaymentSummary[] {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "payment:read",
      input.now
    );

    if (input.invoiceId !== undefined) {
      this.requireInvoice(input.businessId, input.invoiceId);
    }

    return [...this.payments.values()]
      .filter(
        (payment) =>
          payment.businessId === input.businessId &&
          (input.invoiceId === undefined || payment.invoiceId === input.invoiceId)
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  recordPayment(input: {
    sessionId: string | null;
    businessId: string;
    payment: PaymentInput;
    now?: Date;
  }): { payment: PaymentSummary; invoicePayment: InvoicePaymentSummary } {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "payment:write",
      now
    );
    assertValid(validatePaymentInput(input.payment));
    const normalized = normalizePaymentInput(input.payment);
    const invoice = this.requireInvoice(input.businessId, normalized.invoiceId);

    if (invoice.status !== "confirmed") {
      throw new Cp2Error(409, "invoice_not_confirmed", "Payments require a confirmed invoice.");
    }

    const currentSummary = this.buildInvoicePaymentSummary(invoice);

    if (normalized.amount > currentSummary.balanceDue) {
      throw new Cp2Error(
        409,
        "payment_exceeds_balance",
        "Payment amount exceeds the invoice balance."
      );
    }

    const payment: PaymentSummary = {
      id: randomUUID(),
      businessId: input.businessId,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      customerId: invoice.customerId,
      customerName: invoice.customerName,
      method: normalized.method,
      amount: normalized.amount,
      reference: normalized.reference,
      note: normalized.note,
      actorId: session.user.id,
      createdAt: now.toISOString()
    };

    this.payments.set(payment.id, payment);
    const invoicePayment = this.buildInvoicePaymentSummary(invoice);
    this.deps.appendBusinessEvent(
      paymentRecordedEvent({
        id: randomUUID(),
        payment,
        invoicePayment,
        actorId: session.user.id,
        occurredAt: now.toISOString()
      })
    );

    return {
      payment,
      invoicePayment
    };
  }

  listInvoicePaymentSummaries(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): InvoicePaymentSummary[] {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "payment:read",
      input.now
    );
    return this.buildInvoicePaymentSummaries(input.businessId);
  }

  listCustomerDebts(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): CustomerDebtSummary[] {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "payment:read",
      input.now
    );
    return this.buildCustomerDebtSummaries(input.businessId);
  }

  createPublicCustomerCareRequest(input: {
    agentId: string;
    type: PublicCustomerCareRequestType;
    customerName: string | null;
    phone: string | null;
    message: string | null;
    now?: Date;
  }): PublicCustomerCareRequestSummary {
    const now = input.now ?? new Date();
    const business = requirePublicStorefrontBusiness(
      this.deps.businesses,
      this.deps.quarantinedBusinessIds,
      input.agentId
    );
    const request: PublicCustomerCareRequestSummary = {
      id: randomUUID(),
      businessId: business.id,
      type: input.type,
      customerName: normalizeOptionalBoundedText(input.customerName, 120),
      phone: normalizeOptionalBoundedText(input.phone, 40),
      message: normalizeOptionalBoundedText(input.message, 2000),
      status: "new",
      createdAt: now.toISOString()
    };
    if (request.type === "callback" && request.phone === null) {
      throw new Cp2Error(400, "callback_phone_required", "A callback phone number is required.");
    }
    this.publicCustomerCareRequests.set(request.id, request);
    this.deps.recordAuditEvent({
      type: "storefront.customer_care_requested",
      aggregateType: "customer_care_request",
      aggregateId: request.id,
      actorId: "public-storefront",
      occurredAt: now.toISOString(),
      payload: { businessId: business.id, type: request.type }
    });
    return request;
  }

  listPublicCustomerCareRequests(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): PublicCustomerCareRequestSummary[] {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "business:read",
      input.now
    );
    return [...this.publicCustomerCareRequests.values()].filter(
      (request) => request.businessId === input.businessId
    );
  }

  createPublicOrder(input: {
    agentId: string;
    capabilityToken: string;
    customerName: string;
    phone: string;
    note: string | null;
    items: Array<{ productId: string; quantity: number }>;
    now?: Date;
  }): PublicOrderSummary {
    const now = input.now ?? new Date();
    const business = requirePublicStorefrontBusiness(
      this.deps.businesses,
      this.deps.quarantinedBusinessIds,
      input.agentId
    );
    const principal = this.deps.requireCustomerCapability(input.capabilityToken, business.id, now);
    const identity = this.deps.findPlatformIdentity(principal.platformIdentityId);
    if (identity === undefined) {
      throw new Cp2Error(401, "customer_capability_invalid", "Customer session is invalid.");
    }
    if (input.items.length === 0 || input.items.length > 100) {
      throw new Cp2Error(400, "order_items_invalid", "An order needs between 1 and 100 items.");
    }
    const resolvedItems = input.items.map((item) => {
      const product = this.products.get(item.productId);
      if (product === undefined || product.businessId !== business.id || product.quantity <= 0) {
        throw new Cp2Error(404, "order_product_unavailable", "An order product is unavailable.");
      }
      if (
        !Number.isInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > product.quantity
      ) {
        throw new Cp2Error(400, "order_quantity_invalid", `Invalid quantity for ${product.name}.`);
      }
      if (product.sellingPrice === null) {
        throw new Cp2Error(
          409,
          "order_price_unavailable",
          `Price is unavailable for ${product.name}.`
        );
      }
      return { product, quantity: item.quantity };
    });
    const invoice = this.buildStoredInvoice({
      businessId: business.id,
      invoiceId: randomUUID(),
      invoiceNumber: this.nextInvoiceNumber(business.id),
      input: {
        customerId: null,
        customerName: normalizeRequiredBoundedText(input.customerName, "customer name", 120),
        taxRate: 0,
        items: resolvedItems.map(({ product, quantity }) => ({
          productId: product.id,
          quantity,
          unitPrice: product.sellingPrice as number
        }))
      },
      status: "draft",
      confirmedAt: null,
      now,
      // A storefront order is placed in the Grogoni storefront chat by a guest, not a member.
      source: "GROGONI_CHAT",
      sourceMessageChannel: "grogoni"
    });
    this.invoices.set(invoice.id, invoice);
    const items = resolvedItems.map(({ product, quantity }) => ({
      productId: product.id,
      productName: product.name,
      unit: product.unit,
      quantity
    }));
    const order: PublicOrderSummary = {
      id: randomUUID(),
      businessId: business.id,
      visitorId: identity.externalUserId,
      customerName: invoice.customerName as string,
      phone: normalizeRequiredBoundedText(input.phone, "phone", 40),
      note: normalizeOptionalBoundedText(input.note, 2000),
      items,
      status: "requested",
      conversationId: principal.conversationId,
      invoiceId: invoice.id,
      payment: this.buildInvoicePaymentSummary(invoice),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    this.publicOrders.set(order.id, order);
    this.deps.recordAuditEvent({
      type: "storefront.order_requested",
      aggregateType: "invoice",
      aggregateId: order.id,
      actorId: "public-storefront",
      occurredAt: now.toISOString(),
      payload: {
        businessId: business.id,
        conversationId: principal.conversationId,
        invoiceId: invoice.id,
        itemCount: order.items.length
      }
    });
    return order;
  }

  listPublicOrders(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): PublicOrderSummary[] {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "business:read",
      input.now
    );
    return [...this.publicOrders.values()].filter((order) => order.businessId === input.businessId);
  }

  requireProduct(businessId: string, productId: string): ProductSummary {
    const product = this.products.get(productId);

    if (product === undefined || product.businessId !== businessId) {
      throw new Cp2Error(404, "product_not_found", "Product was not found.");
    }

    return product;
  }

  requireCustomer(businessId: string, customerId: string): CustomerSummary {
    const customer = this.customers.get(customerId);

    if (customer === undefined || customer.businessId !== businessId) {
      throw new Cp2Error(404, "customer_not_found", "Customer was not found.");
    }

    return customer;
  }

  createGuestCustomer(input: {
    businessId: string;
    displayName?: string | null;
    provider: ChannelProvider;
    externalUserId: string;
    now: Date;
  }): CustomerSummary {
    const name =
      normalizeOptionalBoundedText(input.displayName ?? null, 120) ??
      `${input.provider} customer ${input.externalUserId.slice(-6)}`;
    const customer: CustomerSummary = {
      id: randomUUID(),
      businessId: input.businessId,
      name,
      phone: null,
      email: input.provider === "email" ? normalizeEmailIdentity(input.externalUserId) : null,
      linkedAccountId: null,
      notes: null,
      createdAt: input.now.toISOString(),
      updatedAt: input.now.toISOString()
    };
    this.customers.set(customer.id, customer);
    return customer;
  }

  requireInvoice(businessId: string, invoiceId: string): InvoiceSummary {
    const invoice = this.invoices.get(invoiceId);

    if (invoice === undefined || invoice.businessId !== businessId) {
      throw new Cp2Error(404, "invoice_not_found", "Invoice was not found.");
    }

    return invoice;
  }

  publicProductImage(product: ProductSummary): string | null {
    if (product.primaryMediaId === null || product.primaryMediaId === undefined) return null;
    const media = this.productMedia.get(product.primaryMediaId);
    return media?.productId === product.id && media.businessId === product.businessId
      ? media.publicUrl
      : null;
  }

  productsForBusiness(businessId: string): ProductSummary[] {
    return [...this.products.values()].filter((product) => product.businessId === businessId);
  }

  customersForBusiness(businessId: string): CustomerSummary[] {
    return [...this.customers.values()].filter((customer) => customer.businessId === businessId);
  }

  invoicesForBusiness(businessId: string): InvoiceSummary[] {
    return [...this.invoices.values()].filter((invoice) => invoice.businessId === businessId);
  }

  paymentsForBusiness(businessId: string): PaymentSummary[] {
    return [...this.payments.values()].filter((payment) => payment.businessId === businessId);
  }

  inventoryMovementsForBusiness(businessId: string): InventoryMovementSummary[] {
    return [...this.inventoryMovements.values()].filter(
      (movement) => movement.businessId === businessId
    );
  }

  private buildInvoicePreview(businessId: string, invoice: InvoiceInput): InvoicePreview {
    const normalized = normalizeInvoiceInput(invoice);
    const customer =
      normalized.customerId === null
        ? null
        : this.requireCustomer(businessId, normalized.customerId);
    const products = normalized.items.map((item) =>
      this.requireProduct(businessId, item.productId)
    );

    return createInvoicePreview({
      businessId,
      invoice,
      products,
      customer
    });
  }

  buildOfferInvoice(input: {
    businessId: string;
    customerName: string;
    lines: { product: ProductSummary; quantity: number; snapshot: CommerceOfferOrderSnapshot }[];
    now: Date;
  }): InvoiceSummary {
    const invoiceInput: InvoiceInput = {
      customerName: input.customerName,
      taxRate: 0,
      items: input.lines.map((line) => ({
        productId: line.product.id,
        quantity: line.quantity,
        unitPrice: line.snapshot.price
      }))
    };
    assertValid(validateInvoiceInput(invoiceInput));
    const preview = createInvoicePreview({
      businessId: input.businessId,
      invoice: invoiceInput,
      products: input.lines.map((line) => line.product)
    });
    const id = randomUUID();
    const items = preview.items.map((item) => ({ ...item, id: randomUUID(), invoiceId: id }));
    return {
      ...preview,
      id,
      invoiceNumber: this.nextInvoiceNumber(input.businessId),
      status: "draft",
      items,
      confirmedAt: null,
      createdAt: input.now.toISOString(),
      updatedAt: input.now.toISOString(),
      source: "GROGONI_CHAT",
      sourceMessageChannel: "grogoni",
      offerFulfillment: items.map((item, index) => ({
        lineId: item.id,
        snapshot: structuredClone(input.lines[index]!.snapshot),
        fulfilledAt: null,
        fulfilledBy: null
      }))
    };
  }

  buildStoredInvoice(input: {
    businessId: string;
    invoiceId: string;
    invoiceNumber: string;
    input: InvoiceInput;
    status: "draft" | "confirmed";
    confirmedAt: string | null;
    now: Date;
    createdAt?: string;
    /** Provenance (Phase 1c). Callers that know the channel pass it; nothing branches on it. */
    source?: OrderSource | null;
    sourceMessageChannel?: MessageChannel | null;
    createdByUserId?: string | null;
  }): InvoiceSummary {
    const preview = this.buildInvoicePreview(input.businessId, input.input);
    const items: InvoiceItemSummary[] = preview.items.map((item) => ({
      id: randomUUID(),
      invoiceId: input.invoiceId,
      ...item
    }));

    return {
      id: input.invoiceId,
      businessId: input.businessId,
      invoiceNumber: input.invoiceNumber,
      status: input.status,
      customerId: preview.customerId,
      customerName: preview.customerName,
      items,
      subtotal: preview.subtotal,
      taxRate: preview.taxRate,
      taxTotal: preview.taxTotal,
      total: preview.total,
      confirmedAt: input.confirmedAt,
      createdAt: input.createdAt ?? input.now.toISOString(),
      updatedAt: input.now.toISOString(),
      source: input.source ?? input.input.source ?? null,
      sourceMessageChannel: input.sourceMessageChannel ?? input.input.sourceMessageChannel ?? null,
      createdByUserId: input.createdByUserId ?? null
    };
  }

  nextInvoiceNumber(businessId: string): string {
    const nextNumber = this.nextInvoiceNumberByBusiness.get(businessId) ?? 1;
    this.nextInvoiceNumberByBusiness.set(businessId, nextNumber + 1);
    return `INV-${String(nextNumber).padStart(5, "0")}`;
  }

  private createInventoryMovement(input: {
    businessId: string;
    productId: string;
    type?: "manual_adjustment" | "sale";
    quantityBefore: number;
    quantityAfter: number;
    reason: string;
    actorId: string;
    now: Date;
  }): InventoryMovementSummary {
    const movement: InventoryMovementSummary = {
      id: randomUUID(),
      businessId: input.businessId,
      productId: input.productId,
      type: input.type ?? "manual_adjustment",
      quantityBefore: input.quantityBefore,
      quantityAfter: input.quantityAfter,
      delta: input.quantityAfter - input.quantityBefore,
      reason: input.reason,
      actorId: input.actorId,
      createdAt: input.now.toISOString()
    };

    this.inventoryMovements.set(movement.id, movement);
    this.deps.appendBusinessEvent(
      stockAdjustedEvent({
        id: randomUUID(),
        movement,
        actorId: input.actorId,
        occurredAt: input.now.toISOString()
      })
    );

    return movement;
  }

  buildInvoicePaymentSummaries(businessId: string): InvoicePaymentSummary[] {
    return [...this.invoices.values()]
      .filter((invoice) => invoice.businessId === businessId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((invoice) => this.buildInvoicePaymentSummary(invoice));
  }

  buildInvoicePaymentSummary(invoice: InvoiceSummary): InvoicePaymentSummary {
    return createInvoicePaymentSummary({
      invoice,
      payments: [...this.payments.values()].filter(
        (payment) => payment.businessId === invoice.businessId
      )
    });
  }

  buildCustomerDebtSummaries(businessId: string): CustomerDebtSummary[] {
    const debts = new Map<string, CustomerDebtSummary>();

    for (const summary of this.buildInvoicePaymentSummaries(businessId)) {
      if (summary.customerId === null || summary.balanceDue <= 0) {
        continue;
      }

      const existing = debts.get(summary.customerId);

      if (existing === undefined) {
        debts.set(summary.customerId, {
          customerId: summary.customerId,
          customerName: summary.customerName ?? "Customer",
          invoiceCount: 1,
          totalInvoiced: summary.invoiceTotal,
          totalPaid: summary.paidTotal,
          balanceDue: summary.balanceDue
        });
        continue;
      }

      debts.set(summary.customerId, {
        ...existing,
        invoiceCount: existing.invoiceCount + 1,
        totalInvoiced: roundMoney(existing.totalInvoiced + summary.invoiceTotal),
        totalPaid: roundMoney(existing.totalPaid + summary.paidTotal),
        balanceDue: roundMoney(existing.balanceDue + summary.balanceDue)
      });
    }

    return [...debts.values()].sort((left, right) =>
      right.balanceDue === left.balanceDue
        ? left.customerName.localeCompare(right.customerName)
        : right.balanceDue - left.balanceDue
    );
  }
}
