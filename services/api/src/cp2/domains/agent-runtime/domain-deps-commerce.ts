import type {
  BusinessReportSummary,
  CatalogueQueryResult,
  ChannelProvider,
  ClientWorkspaceFileTransfer,
  CustomerSummary,
  DocumentImportJobSummary,
  FulfillmentStatus,
  InvoiceSummary,
  LogisticsSummary,
  NotificationInbox,
  ProductFieldDefinition,
  ProductFieldSchemaSummary,
  ProductSummary,
  PurchaseReceiptSummary,
  ReceiptOCRJobSummary,
  SecurityReviewSummary,
  SupplierSummary,
  TrustedMessageAttachmentReference,
  WorkspaceDeliverResult
} from "@grogoni/shared-types";
import type { InvoiceInput, PaymentInput } from "@grogoni/business-core";

/**
 * Business record CRUD, receipts, imports, channel messaging, and workspace file delivery -
 * split out of AgentRuntimeDomainDeps (see domain-deps.ts) purely to keep that file under its
 * modularity budget. Split along the existing commerce-capabilities.ts/receipt-capabilities.ts
 * boundary; no behavior changes, this is the same flat dependency shape as before.
 */
export interface AgentRuntimeCommerceDeps {
  sourceCommerce?: (input: {
    sessionId: string | null;
    businessId: string;
    operation: string;
    values: Record<string, unknown>;
    now?: Date;
  }) => unknown;
  listSourceCommerce?: (input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }) => unknown;
  discoverCommerceOffers?: (input: { query?: string; now?: Date }) => unknown;
  imageForProduct: (product: ProductSummary) => string | null;
  importsForBusiness: (businessId: string) => DocumentImportJobSummary[];
  requireDocumentImport: (businessId: string, importJobId: string) => DocumentImportJobSummary;
  suppliersForBusiness: (businessId: string) => SupplierSummary[];
  purchaseReceipts: Map<string, PurchaseReceiptSummary>;
  queryCatalogue: (input: {
    sessionId: string | null;
    businessId: string;
    query: string;
    now?: Date;
  }) => CatalogueQueryResult;
  listProducts: (input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }) => ProductSummary[];
  listInvoices: (input: { sessionId: string | null; businessId: string; now?: Date }) => unknown;
  listCustomerDebts: (input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }) => unknown;
  getBusinessReport: (input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }) => BusinessReportSummary;
  listNotifications: (input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }) => NotificationInbox;
  getSecurityReview: (input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }) => SecurityReviewSummary;
  getProductFieldSchema: (input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }) => ProductFieldSchemaSummary;
  saveProductFieldSchema: (input: {
    sessionId: string | null;
    businessId: string;
    fields: ProductFieldDefinition[];
    now?: Date;
  }) => ProductFieldSchemaSummary;
  createProduct: (input: {
    sessionId: string | null;
    businessId: string;
    product: {
      name: string;
      sku: string | null;
      unit: string;
      quantity: number;
      sellingPrice?: number | null;
    };
    now?: Date;
  }) => ProductSummary;
  updateProduct: (input: {
    sessionId: string | null;
    businessId: string;
    productId: string;
    product: {
      name: string;
      sku: string | null;
      unit: string;
      quantity: number;
      buyingPrice: number | null;
      sellingPrice: number | null;
    };
    now?: Date;
  }) => ProductSummary;
  adjustProductStock: (input: {
    sessionId: string | null;
    businessId: string;
    productId: string;
    adjustment: { quantityAfter: number; reason?: string | null };
    now?: Date;
  }) => unknown;
  deleteProduct: (input: {
    sessionId: string | null;
    businessId: string;
    productId: string;
    now?: Date;
  }) => unknown;
  createCustomer: (input: {
    sessionId: string | null;
    businessId: string;
    customer: {
      name: string;
      phone: string | null;
      email: string | null;
      notes: string | null;
    };
    now?: Date;
  }) => CustomerSummary;
  updateCustomer: (input: {
    sessionId: string | null;
    businessId: string;
    customerId: string;
    customer: { name: string; phone: string | null; email: string | null; notes: string | null };
    now?: Date;
  }) => CustomerSummary;
  createSupplier: (input: {
    sessionId: string | null;
    businessId: string;
    supplier: { name: string; phone: string | null; email: string | null; notes: string | null };
    now?: Date;
  }) => SupplierSummary;
  updateSupplier: (input: {
    sessionId: string | null;
    businessId: string;
    supplierId: string;
    supplier: { name: string; phone: string | null; email: string | null; notes: string | null };
    now?: Date;
  }) => SupplierSummary;
  createInvoice: (input: {
    sessionId: string | null;
    businessId: string;
    invoice: InvoiceInput;
    now?: Date;
  }) => InvoiceSummary;
  recordPayment: (input: {
    sessionId: string | null;
    businessId: string;
    payment: PaymentInput;
    now?: Date;
  }) => unknown;
  updateLogisticsStatus: (input: {
    sessionId: string | null;
    businessId: string;
    logisticsId: string;
    status: { status: FulfillmentStatus; note?: string | null };
    now?: Date;
  }) => LogisticsSummary;
  listPurchaseReceipts: (input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }) => PurchaseReceiptSummary[];
  listReceiptOCRJobs: (input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }) => ReceiptOCRJobSummary[];
  createReceiptOCRJob: (input: {
    sessionId: string | null;
    businessId: string;
    sourceFileName: string;
    contentType: string;
    extractedText: string;
    now?: Date;
  }) => unknown;
  confirmReceiptOCRJob: (input: {
    sessionId: string | null;
    businessId: string;
    ocrJobId: string;
    supplierId?: string | null;
    salesAgentId?: string | null;
    createSupplier?: boolean;
    createSalesAgent?: boolean;
    now?: Date;
  }) => PurchaseReceiptSummary;
  correctReceiptOCRJob: (input: {
    sessionId: string | null;
    businessId: string;
    ocrJobId: string;
    extractedText: string;
    now?: Date;
  }) => unknown;
  cancelReceiptOCRJob: (input: {
    sessionId: string | null;
    businessId: string;
    ocrJobId: string;
    now?: Date;
  }) => unknown;
  confirmProductImport: (input: {
    sessionId: string | null;
    businessId: string;
    importJobId: string;
    now?: Date;
  }) => unknown;
  confirmSupplierImport: (input: {
    sessionId: string | null;
    businessId: string;
    importJobId: string;
    now?: Date;
  }) => unknown;
  sendChannelMessage: (input: {
    sessionId: string | null;
    businessId: string;
    customerId?: string;
    customerName?: string;
    conversationId?: string;
    provider?: ChannelProvider;
    mailboxId?: string;
    subject?: string;
    replyToMessageId?: string;
    attachments?: TrustedMessageAttachmentReference[];
    text: string;
    idempotencyKey: string;
    now?: Date;
  }) => Promise<unknown>;
  deliverWorkspaceFile: (input: {
    sessionId: string | null;
    businessId: string;
    conversationId: string;
    requestedPaths: string[];
    transferredFiles?: ClientWorkspaceFileTransfer[];
    caption?: string;
    toolCallId: string;
    now?: Date;
  }) => Promise<WorkspaceDeliverResult>;
  products: Map<string, ProductSummary>;
  customers: Map<string, CustomerSummary>;
  invoices: Map<string, InvoiceSummary>;
  listContacts: (input: {
    sessionId: string | null;
    businessId: string;
    query?: string | undefined;
    now?: Date;
  }) => unknown;
  attachSupplierContact: (input: {
    sessionId: string | null;
    businessId: string;
    supplierId: string;
    contactId: string;
    role: "OWNER" | "SALES_AGENT" | "DELIVERY_AGENT" | "DRIVER" | "ACCOUNT_MANAGER" | "OTHER";
    isPrimary?: boolean;
    now?: Date;
  }) => unknown;
  createPurchase: (input: {
    sessionId: string | null;
    businessId: string;
    supplierId: string;
    supplierContactId?: string | null;
    productId: string;
    quantity: number;
    buyingPrice: number;
    currency?: string | undefined;
    deliveredAt?: string | null;
    routeId?: string | null;
    externalSourceId?: string | null;
    now?: Date;
  }) => unknown;
  changePurchasePrice: (input: {
    sessionId: string | null;
    businessId: string;
    productId: string;
    price: number;
    currency?: string | undefined;
    supplierId?: string | null;
    supplierContactId?: string | null;
    effectiveAt?: string | undefined;
    now?: Date;
  }) => unknown;
  listPurchaseHistory: (input: {
    sessionId: string | null;
    businessId: string;
    productId?: string | undefined;
    supplierId?: string | undefined;
    now?: Date;
  }) => unknown;
  createSale: (input: {
    sessionId: string | null;
    businessId: string;
    customerId?: string | null;
    customerName?: string | null;
    customerContactId?: string | null;
    items: Array<{ productId: string; quantity: number; unitPrice: number }>;
    currency?: string | undefined;
    routeId?: string | null;
    externalSourceId?: string | null;
    now?: Date;
  }) => unknown;
  listSalesHistory: (input: {
    sessionId: string | null;
    businessId: string;
    customerId?: string | undefined;
    customerContactId?: string | undefined;
    now?: Date;
  }) => unknown;
  createDeliveryRoute: (input: {
    sessionId: string | null;
    businessId: string;
    origin: {
      label?: string;
      address?: string | null;
      latitude?: number | null;
      longitude?: number | null;
      region?: string | null;
      country?: string | null;
    };
    destination: {
      label?: string;
      address?: string | null;
      latitude?: number | null;
      longitude?: number | null;
      region?: string | null;
      country?: string | null;
    };
    provider?: string | undefined;
    externalSourceId?: string | null;
    now?: Date;
  }) => unknown;
  listDeliveryRouteHistory: (input: {
    sessionId: string | null;
    businessId: string;
    destinationLocationId?: string | undefined;
    now?: Date;
  }) => unknown;
}
