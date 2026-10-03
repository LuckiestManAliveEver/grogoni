/**
 * Tenth domain slice of in-process modularization for services/api/src/cp2/routes.ts (see
 * docs/architecture/routes-modularization-roadmap.md). Products/customers/invoices/payments plus
 * the public-storefront customer-care/order routes - the same "sales" domain the store.ts side
 * extracted (named `sales`, not `commerce`, to stay distinct from `domains/commerce/`, the
 * storefront/social-commerce surface built on top of this deeper transactional core).
 *
 * `parseProductBody`/`parseStockAdjustmentBody`/`parseInvoiceBody`/`parsePaymentBody` are exported
 * since routes.ts's own `parseSyncMutationPayload` (the offline sync-queue mutation-replay
 * dispatcher) calls them directly for `product.create`/`inventory.adjust`/`invoice.create`/
 * `payment.record` mutation replay - the same cross-domain reference every sync-queue-aware
 * domain extraction has hit (logistics, suppliers before it).
 *
 * `CustomerParams`/`StorefrontParams` live in route-helpers.ts, not here - both are genuinely
 * shared with routes that stay elsewhere (messaging's channel-link-grant route uses
 * `CustomerParams`; CORE's `getPublicStorefront` and messaging's public-storefront
 * session/message routes use `StorefrontParams`).
 */
import type { FastifyRequest, FastifyInstance } from "fastify";
import { isPaymentMethod } from "@grogoni/business-core";
import type {
  ProductFieldDefinition,
  ProductFieldInputType,
  PublicCustomerCareRequestType
} from "@grogoni/shared-types";
import {
  GramsFormatError,
  formatGrams,
  isOrderSource,
  parsePositiveGrams,
  type FulfillmentMethod,
  type OrderSource
} from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import { type Cp2Store, readSessionCookie } from "../../store.js";
import {
  parseBoolean,
  parseContactRecordBody,
  parseNullableNumber,
  parseNullableString,
  parseNumber,
  parsePositiveInteger,
  parseRequestBody,
  parseString,
  parseStringArray,
  sendCp2Error,
  type BusinessParams,
  type ContactRecordBody,
  type CustomerParams,
  type StorefrontParams
} from "../../route-helpers.js";

interface CustomerAccountLinkBody {
  accountId?: string;
}

interface PublicCustomerCareBody {
  type?: string;
  customerName?: string | null;
  phone?: string | null;
  message?: string | null;
}

interface PublicOrderBody {
  capabilityToken?: string;
  customerName?: string;
  phone?: string;
  note?: string | null;
  items?: Array<{ productId?: string; quantity?: number }>;
}

interface ProductParams extends BusinessParams {
  productId: string;
}

interface InvoiceParams extends BusinessParams {
  invoiceId: string;
}

interface PaymentParams extends BusinessParams {
  invoiceId: string;
}

interface ProductBody {
  name?: string;
  sku?: string | null;
  aliases?: unknown[];
  unit?: string | null;
  quantity?: number;
  buyingPrice?: number | null;
  sellingPrice?: number | null;
  unitWeightGrams?: unknown;
  fieldValues?: unknown;
}

interface ProductFieldStructureBody {
  fields?: unknown[];
}

interface StockAdjustmentBody {
  quantityAfter?: number;
  reason?: string | null;
}

interface InvoiceItemBody {
  productId?: string;
  quantity?: number;
  unitPrice?: number;
}

interface InvoiceBody {
  customerId?: string | null;
  customerName?: string | null;
  taxRate?: number | null;
  items?: InvoiceItemBody[];
  source?: unknown;
}

interface PaymentBody {
  invoiceId?: string;
  amount?: number;
  method?: string;
  reference?: string | null;
  note?: string | null;
}

export function registerSalesRoutes(app: FastifyInstance, store: Cp2Store): void {
  app.post(
    "/businesses/:businessId/customers/:customerId/account-link",
    async (
      request: FastifyRequest<{ Params: CustomerParams; Body: CustomerAccountLinkBody }>,
      reply
    ) => {
      try {
        return store.linkCustomerAccount({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: parseString(request.params.businessId, "businessId"),
          customerId: parseString(request.params.customerId, "customerId"),
          accountId: parseString(request.body.accountId, "accountId")
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/public/storefronts/:agentId/customer-care",
    async (
      request: FastifyRequest<{ Params: StorefrontParams; Body: PublicCustomerCareBody }>,
      reply
    ) => {
      try {
        return store.createPublicCustomerCareRequest({
          agentId: parseString(request.params.agentId, "agentId"),
          type: parsePublicCustomerCareType(request.body.type),
          customerName: parseNullableString(request.body.customerName),
          phone: parseNullableString(request.body.phone),
          message: parseNullableString(request.body.message)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/public/storefronts/:agentId/orders",
    async (request: FastifyRequest<{ Params: StorefrontParams; Body: PublicOrderBody }>, reply) => {
      try {
        return store.createPublicOrder({
          agentId: parseString(request.params.agentId, "agentId"),
          capabilityToken: parseString(request.body.capabilityToken, "capabilityToken"),
          customerName: parseString(request.body.customerName, "customerName"),
          phone: parseString(request.body.phone, "phone"),
          note: parseNullableString(request.body.note),
          items: parsePublicOrderItems(request.body.items)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/public/product-media/:mediaId",
    async (request: FastifyRequest<{ Params: { mediaId: string } }>, reply) => {
      try {
        const media = store.getPublicProductMedia({
          mediaId: parseString(request.params.mediaId, "mediaId")
        });
        reply.header("content-type", media.contentType);
        reply.header("cache-control", "public, max-age=86400, immutable");
        return reply.send(Buffer.from(media.contentBase64, "base64"));
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/storefront/customer-care",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.listPublicCustomerCareRequests({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/storefront/orders",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.listPublicOrders({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/products",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.listProducts({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/products",
    async (request: FastifyRequest<{ Params: BusinessParams; Body: ProductBody }>, reply) => {
      try {
        return store.createProduct({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          product: parseProductBody(request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/products/fields",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.getProductFieldSchema({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/products/fields",
    async (
      request: FastifyRequest<{ Params: BusinessParams; Body: ProductFieldStructureBody }>,
      reply
    ) => {
      try {
        return store.saveProductFieldSchema({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          fields: parseProductFieldDefinitions(request.body?.fields)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.patch(
    "/businesses/:businessId/products/:productId",
    async (request: FastifyRequest<{ Params: ProductParams; Body: ProductBody }>, reply) => {
      try {
        return store.updateProduct({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          productId: request.params.productId,
          product: parseProductBody(request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.delete(
    "/businesses/:businessId/products/:productId",
    async (request: FastifyRequest<{ Params: ProductParams }>, reply) => {
      try {
        return store.deleteProduct({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          productId: request.params.productId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/products/:productId/stock-adjustments",
    async (
      request: FastifyRequest<{ Params: ProductParams; Body: StockAdjustmentBody }>,
      reply
    ) => {
      try {
        return store.adjustProductStock({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          productId: request.params.productId,
          adjustment: parseStockAdjustmentBody(request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/customers",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.listCustomers({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/customers",
    async (request: FastifyRequest<{ Params: BusinessParams; Body: ContactRecordBody }>, reply) => {
      try {
        return store.createCustomer({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          customer: parseContactRecordBody(request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.patch(
    "/businesses/:businessId/customers/:customerId",
    async (request: FastifyRequest<{ Params: CustomerParams; Body: ContactRecordBody }>, reply) => {
      try {
        return store.updateCustomer({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          customerId: request.params.customerId,
          customer: parseContactRecordBody(request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/invoices/preview",
    async (request: FastifyRequest<{ Params: BusinessParams; Body: InvoiceBody }>, reply) => {
      try {
        return store.previewInvoice({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          invoice: parseInvoiceBody(request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/invoices",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.listInvoices({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/invoices",
    async (request: FastifyRequest<{ Params: BusinessParams; Body: InvoiceBody }>, reply) => {
      try {
        return store.createInvoice({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          invoice: parseInvoiceBody(request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.patch(
    "/businesses/:businessId/invoices/:invoiceId",
    async (request: FastifyRequest<{ Params: InvoiceParams; Body: InvoiceBody }>, reply) => {
      try {
        return store.updateInvoice({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          invoiceId: request.params.invoiceId,
          invoice: parseInvoiceBody(request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/invoices/:invoiceId/confirm",
    async (request: FastifyRequest<{ Params: InvoiceParams; Body: unknown }>, reply) => {
      try {
        const body =
          request.body === undefined || request.body === null ? {} : parseRequestBody(request.body);
        const fulfillmentMethod =
          body.fulfillmentMethod === undefined || body.fulfillmentMethod === null
            ? undefined
            : parseConfirmFulfillmentMethod(body.fulfillmentMethod);
        return store.confirmInvoice({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          invoiceId: request.params.invoiceId,
          ...(fulfillmentMethod === undefined ? {} : { fulfillmentMethod })
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/payments",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.listPayments({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.post(
    "/businesses/:businessId/payments",
    async (request: FastifyRequest<{ Params: BusinessParams; Body: PaymentBody }>, reply) => {
      try {
        return store.recordPayment({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          payment: parsePaymentBody(request.body)
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/invoices/:invoiceId/payments",
    async (request: FastifyRequest<{ Params: PaymentParams }>, reply) => {
      try {
        return store.listPayments({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId,
          invoiceId: request.params.invoiceId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/payment-summaries",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.listInvoicePaymentSummaries({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );

  app.get(
    "/businesses/:businessId/customer-debts",
    async (request: FastifyRequest<{ Params: BusinessParams }>, reply) => {
      try {
        return store.listCustomerDebts({
          sessionId: readSessionCookie(request.headers.cookie),
          businessId: request.params.businessId
        });
      } catch (error) {
        return sendCp2Error(reply, error);
      }
    }
  );
}

function parsePublicCustomerCareType(value: unknown): PublicCustomerCareRequestType {
  if (
    value === "callback" ||
    value === "quote" ||
    value === "support" ||
    value === "registration"
  ) {
    return value;
  }
  throw new Cp2Error(400, "customer_care_type_invalid", "Customer-care request type is invalid.");
}

function parsePublicOrderItems(value: unknown): Array<{ productId: string; quantity: number }> {
  if (!Array.isArray(value)) {
    throw new Cp2Error(400, "order_items_required", "Order items are required.");
  }
  return value.map((item, index) => {
    const record = parseRequestBody(item);
    return {
      productId: parseString(record.productId, `items[${index}].productId`),
      quantity: parsePositiveInteger(record.quantity, `items[${index}].quantity`)
    };
  });
}

/** Exported - routes.ts's `parseSyncMutationPayload` offline-sync-replay dispatcher calls this too. */
export function parseProductBody(body: ProductBody | null | undefined) {
  const record = parseRequestBody(body);

  return {
    name: parseString(record.name, "name"),
    sku: parseNullableString(record.sku),
    ...(record.aliases === undefined
      ? {}
      : { aliases: parseStringArray(record.aliases, "aliases", 20) }),
    unit: parseNullableString(record.unit),
    quantity: record.quantity === undefined ? 0 : parseNumber(record.quantity, "quantity"),
    buyingPrice:
      record.buyingPrice === undefined || record.buyingPrice === null
        ? null
        : parseNumber(record.buyingPrice, "buyingPrice"),
    sellingPrice:
      record.sellingPrice === undefined || record.sellingPrice === null
        ? null
        : parseNumber(record.sellingPrice, "sellingPrice"),
    ...(record.unitWeightGrams === undefined
      ? {}
      : { unitWeightGrams: parseUnitWeightGrams(record.unitWeightGrams) }),
    ...(record.fieldValues === undefined
      ? {}
      : { fieldValues: parseProductFieldValues(record.fieldValues) })
  };
}

/** A22: grams cross JSON only as canonical decimal strings; numbers are rejected, never coerced. */
function parseUnitWeightGrams(value: unknown): string | null {
  if (value === null) return null;
  try {
    return formatGrams(parsePositiveGrams(value, "unitWeightGrams"));
  } catch (error) {
    if (error instanceof GramsFormatError) {
      throw new Cp2Error(400, "unit_weight_grams_invalid", error.message);
    }
    throw error;
  }
}

function parseProductFieldValues(value: unknown): Record<string, string> {
  const record = parseRequestBody(value);
  return Object.fromEntries(
    Object.entries(record).map(([fieldId, fieldValue]) => {
      if (typeof fieldValue !== "string") {
        throw new Cp2Error(
          400,
          "product_field_value_invalid",
          `Product field ${fieldId} must be text.`
        );
      }
      return [fieldId, fieldValue];
    })
  );
}

function parseProductFieldDefinitions(value: unknown): ProductFieldDefinition[] {
  if (!Array.isArray(value)) {
    throw new Cp2Error(400, "product_fields_required", "Product fields are required.");
  }

  return value.map((field, index) => {
    const record = parseRequestBody(field);
    const inputType = parseString(record.inputType, `fields[${index}].inputType`);
    if (!isProductFieldInputType(inputType)) {
      throw new Cp2Error(
        400,
        "product_field_type_invalid",
        `Field ${index + 1} has an unsupported input type.`
      );
    }
    return {
      id: parseString(record.id, `fields[${index}].id`),
      label: parseString(record.label, `fields[${index}].label`),
      inputType,
      required: parseBoolean(record.required, `fields[${index}].required`)
    };
  });
}

function isProductFieldInputType(value: string): value is ProductFieldInputType {
  return ["text", "number", "select", "textarea", "yes_no"].includes(value);
}

/** Exported - routes.ts's `parseSyncMutationPayload` offline-sync-replay dispatcher calls this too. */
export function parseStockAdjustmentBody(body: StockAdjustmentBody | null | undefined) {
  const record = parseRequestBody(body);

  return {
    quantityAfter: parseNumber(record.quantityAfter, "quantityAfter"),
    reason: parseNullableString(record.reason)
  };
}

/** Exported - routes.ts's `parseSyncMutationPayload` offline-sync-replay dispatcher calls this too. */
export function parseInvoiceBody(body: InvoiceBody | null | undefined) {
  const record = parseRequestBody(body);

  return {
    customerId: parseNullableString(record.customerId),
    customerName: parseNullableString(record.customerName),
    taxRate: record.taxRate === undefined ? 0 : parseNullableNumber(record.taxRate, "taxRate"),
    items: parseInvoiceItems(record.items),
    ...(record.source === undefined || record.source === null
      ? {}
      : { source: parseOrderSource(record.source) })
  };
}

/** D4: `delivery` at confirmation records delivery intent, which enters corridor fulfillment. */
function parseConfirmFulfillmentMethod(value: unknown): FulfillmentMethod {
  if (value === "delivery" || value === "pickup") return value;
  throw new Cp2Error(400, "fulfillment_method_invalid", "Fulfillment method is not supported.");
}

/** Descriptive provenance only (Phase 1c); unknown values are rejected, never coerced. */
function parseOrderSource(value: unknown): OrderSource {
  if (isOrderSource(value)) return value;
  throw new Cp2Error(400, "order_source_invalid", "Order source is not supported.");
}

/** Exported - routes.ts's `parseSyncMutationPayload` offline-sync-replay dispatcher calls this too. */
export function parsePaymentBody(body: PaymentBody | null | undefined) {
  const record = parseRequestBody(body);
  const method = parseString(record.method, "method");

  if (!isPaymentMethod(method)) {
    throw new Cp2Error(400, "payment_method_invalid", "Payment method is not supported.");
  }

  return {
    invoiceId: parseString(record.invoiceId, "invoiceId"),
    amount: parseNumber(record.amount, "amount"),
    method,
    reference: parseNullableString(record.reference),
    note: parseNullableString(record.note)
  };
}

function parseInvoiceItems(value: unknown) {
  if (!Array.isArray(value)) {
    throw new Cp2Error(400, "items_required", "items is required.");
  }

  return value.map((item, index) => {
    const record = parseRequestBody(item);

    return {
      productId: parseString(record.productId, `items.${index}.productId`),
      quantity: parseNumber(record.quantity, `items.${index}.quantity`),
      unitPrice: parseNumber(record.unitPrice, `items.${index}.unitPrice`)
    };
  });
}
