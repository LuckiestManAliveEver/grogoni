import { createEvent, type BusinessEvent } from "@grogoni/event-core";
import type {
  CatalogueQueryResult,
  CustomerSummary,
  DocumentImportPreviewRow,
  InventoryMovementSummary,
  InvoicePaymentStatus,
  InvoicePaymentSummary,
  InvoicePreview,
  InvoiceSummary,
  PaymentMethod,
  PaymentSummary,
  ProductCaptureField,
  ProductCaptureItemSummary,
  ProductCaptureJobSummary,
  ProductImportDraft,
  ProductSummary
} from "@grogoni/shared-types";
import {
  isGramsString,
  isOrderSource,
  type MessageChannel,
  type OrderSource
} from "@grogoni/shared-types";
import { invalid, type ValidationResult, valid } from "@grogoni/tool-core";

import { parseFlexibleImportRecords, parseImportNumber } from "../shared/content-parsing.js";
import {
  isPositiveMoney,
  isPositiveQuantity,
  isValidMoney,
  isValidQuantity,
  isValidTaxRate,
  roundMoney
} from "../shared/money.js";
import {
  normalizeOptionalText,
  normalizeRequiredText,
  nullableText
} from "../shared/text-normalization.js";

export const paymentMethods: PaymentMethod[] = [
  "cash",
  "bank_transfer",
  "mobile_money_manual",
  "card_manual",
  "other_manual"
];

export interface ProductInput {
  name: string;
  sku?: string | null;
  aliases?: string[];
  unit?: string | null;
  quantity?: number;
  buyingPrice?: number | null;
  sellingPrice?: number | null;
  /** Whole grams per sellable unit as a decimal string (A22). `undefined` leaves an existing
   *  product's weight unchanged; `null` clears it back to unknown. */
  unitWeightGrams?: string | null;
  fieldValues?: Record<string, string>;
}

export interface StockAdjustmentInput {
  quantityAfter: number;
  reason?: string | null;
}

export interface InvoiceLineInput {
  productId: string;
  quantity: number;
  unitPrice: number;
}

export interface InvoiceInput {
  customerId?: string | null;
  customerName?: string | null;
  taxRate?: number | null;
  items: InvoiceLineInput[];
  /** Descriptive provenance (Phase 1c); omitted means MANUAL for member-created orders. */
  source?: OrderSource | null;
  sourceMessageChannel?: MessageChannel | null;
}

export interface PaymentInput {
  invoiceId: string;
  amount: number;
  method: PaymentMethod;
  reference?: string | null;
  note?: string | null;
}

export interface NormalizedProductInput {
  name: string;
  sku: string | null;
  aliases: string[];
  unit: string;
  quantity: number;
  buyingPrice: number | null;
  sellingPrice: number | null;
  unitWeightGrams: string | null | undefined;
  fieldValues: Record<string, string>;
}

export interface NormalizedStockAdjustmentInput {
  quantityAfter: number;
  reason: string;
}

export interface NormalizedInvoiceLineInput {
  productId: string;
  quantity: number;
  unitPrice: number;
}

export interface NormalizedInvoiceInput {
  customerId: string | null;
  customerName: string | null;
  taxRate: number;
  items: NormalizedInvoiceLineInput[];
}

export interface NormalizedPaymentInput {
  invoiceId: string;
  amount: number;
  method: PaymentMethod;
  reference: string | null;
  note: string | null;
}

export interface ProductImportPreview {
  fieldMapping: Record<string, keyof ProductImportDraft>;
  rows: DocumentImportPreviewRow[];
}

export function validateProductInput(input: ProductInput): ValidationResult {
  const errors: string[] = [];

  if (normalizeRequiredText(input.name).length < 2) {
    errors.push("Product name must be at least 2 characters.");
  }

  if (!isValidQuantity(input.quantity ?? 0)) {
    errors.push("Product quantity must be a finite non-negative number.");
  }

  if (
    input.unitWeightGrams !== null &&
    input.unitWeightGrams !== undefined &&
    (!isGramsString(input.unitWeightGrams) || input.unitWeightGrams === "0")
  ) {
    errors.push("Product unit weight must be a whole number of grams greater than zero.");
  }

  if (
    input.buyingPrice !== null &&
    input.buyingPrice !== undefined &&
    !isValidMoney(input.buyingPrice)
  ) {
    errors.push("Product buying price must be a finite non-negative amount.");
  }

  if (
    input.sellingPrice !== null &&
    input.sellingPrice !== undefined &&
    !isValidMoney(input.sellingPrice)
  ) {
    errors.push("Product selling price must be a finite non-negative amount.");
  }

  if (normalizeOptionalText(input.unit).length > 32) {
    errors.push("Product unit must be 32 characters or fewer.");
  }

  if (normalizeOptionalText(input.sku).length > 64) {
    errors.push("Product SKU must be 64 characters or fewer.");
  }

  if (input.aliases !== undefined) {
    if (!Array.isArray(input.aliases) || input.aliases.length > 20) {
      errors.push("Product aliases must contain at most 20 entries.");
    } else if (
      input.aliases.some(
        (alias) =>
          typeof alias !== "string" ||
          normalizeRequiredText(alias).length === 0 ||
          normalizeRequiredText(alias).length > 80
      )
    ) {
      errors.push("Each product alias must be non-empty text no longer than 80 characters.");
    }
  }

  if (input.fieldValues !== undefined) {
    const entries = Object.entries(input.fieldValues);
    if (entries.length > 50) {
      errors.push("Product field values must contain at most 50 entries.");
    } else if (
      entries.some(
        ([fieldId, value]) =>
          !/^[a-z0-9][a-z0-9_-]*$/iu.test(fieldId) ||
          fieldId.length > 80 ||
          typeof value !== "string" ||
          value.trim().length > 5_000
      )
    ) {
      errors.push("Product field values contain an invalid field ID or value.");
    }
  }

  return errors.length > 0 ? invalid(...errors) : valid();
}

export function validateStockAdjustmentInput(input: StockAdjustmentInput): ValidationResult {
  const errors: string[] = [];

  if (!isValidQuantity(input.quantityAfter)) {
    errors.push("Adjusted quantity must be a finite non-negative number.");
  }

  if (normalizeOptionalText(input.reason).length > 160) {
    errors.push("Stock adjustment reason must be 160 characters or fewer.");
  }

  return errors.length > 0 ? invalid(...errors) : valid();
}

export function validateInvoiceInput(input: InvoiceInput): ValidationResult {
  const errors: string[] = [];

  if (!Array.isArray(input.items) || input.items.length === 0) {
    errors.push("Invoice must include at least one item.");
  } else if (input.items.length > 50) {
    errors.push("Invoice must include 50 items or fewer.");
  }

  if (!isValidTaxRate(input.taxRate ?? 0)) {
    errors.push("Invoice tax rate must be between 0 and 1.");
  }

  if (normalizeOptionalText(input.customerId).length > 80) {
    errors.push("Invoice customer id must be 80 characters or fewer.");
  }

  if (normalizeOptionalText(input.customerName).length > 120) {
    errors.push("Invoice customer name must be 120 characters or fewer.");
  }

  if (input.source !== null && input.source !== undefined && !isOrderSource(input.source)) {
    errors.push("Invoice source is not supported.");
  }

  for (const [index, item] of input.items.entries()) {
    if (normalizeRequiredText(item.productId).length === 0) {
      errors.push(`Invoice item ${index + 1} product is required.`);
    }

    if (!isPositiveQuantity(item.quantity)) {
      errors.push(`Invoice item ${index + 1} quantity must be a positive finite number.`);
    }

    if (!isValidMoney(item.unitPrice)) {
      errors.push(`Invoice item ${index + 1} unit price must be a finite non-negative number.`);
    }
  }

  return errors.length > 0 ? invalid(...errors) : valid();
}

export function validatePaymentInput(input: PaymentInput): ValidationResult {
  const errors: string[] = [];

  if (normalizeRequiredText(input.invoiceId).length === 0) {
    errors.push("Payment invoice id is required.");
  }

  if (!isPositiveMoney(input.amount)) {
    errors.push("Payment amount must be a positive finite number.");
  }

  if (!isPaymentMethod(input.method)) {
    errors.push("Payment method is not supported.");
  }

  if (normalizeOptionalText(input.reference).length > 80) {
    errors.push("Payment reference must be 80 characters or fewer.");
  }

  if (normalizeOptionalText(input.note).length > 160) {
    errors.push("Payment note must be 160 characters or fewer.");
  }

  return errors.length > 0 ? invalid(...errors) : valid();
}

export function createProductImportPreview(input: {
  content: string;
  fieldMapping?: Record<string, keyof ProductImportDraft>;
}): ProductImportPreview {
  const records = parseFlexibleImportRecords(input.content);
  const fieldMapping = input.fieldMapping ?? inferProductFieldMapping(records.headers);
  const rows = records.rows.map((row, index) => {
    const mapped = mapProductRow(row, fieldMapping);
    const validation = validateProductInput(mapped);

    return {
      rowNumber: index + 1,
      raw: row,
      mapped,
      errors: validation.errors,
      warnings: [],
      selected: validation.ok
    };
  });

  return {
    fieldMapping,
    rows
  };
}

export function normalizeProductInput(input: ProductInput): NormalizedProductInput {
  return {
    name: normalizeRequiredText(input.name),
    sku: nullableText(input.sku),
    aliases: normalizeProductAliases(input.aliases ?? []),
    unit: normalizeOptionalText(input.unit) || "unit",
    quantity: input.quantity ?? 0,
    buyingPrice:
      input.buyingPrice === null || input.buyingPrice === undefined
        ? null
        : roundMoney(input.buyingPrice),
    sellingPrice:
      input.sellingPrice === null || input.sellingPrice === undefined
        ? null
        : roundMoney(input.sellingPrice),
    unitWeightGrams: input.unitWeightGrams,
    fieldValues: Object.fromEntries(
      Object.entries(input.fieldValues ?? {}).map(([fieldId, value]) => [fieldId, value.trim()])
    )
  };
}

export function queryCatalogueProducts(input: {
  businessId: string;
  products: ProductSummary[];
  query: string;
  limit?: number;
  imageForProduct?: (product: ProductSummary) => string | null;
}): CatalogueQueryResult {
  const query = normalizeCatalogueText(input.query).slice(0, 120);
  const limit = Math.min(50, Math.max(1, input.limit ?? 20));
  const queryTokens = catalogueTokens(query);
  const products = input.products
    .filter((product) => product.businessId === input.businessId)
    .map((product) => ({ product, score: catalogueMatchScore(product, query, queryTokens) }))
    .filter((candidate) => query.length === 0 || candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.product.name.localeCompare(right.product.name)
    )
    .slice(0, limit)
    .map(({ product }) => ({
      productId: product.id,
      businessId: product.businessId,
      name: product.name,
      unit: product.unit,
      sellingPrice: product.sellingPrice,
      availability: product.quantity > 0 ? ("available" as const) : ("unavailable" as const),
      image: input.imageForProduct?.(product) ?? null
    }));

  return { query, products, total: products.length };
}

/**
 * Deterministic OCR-text-to-field extraction for camera product capture. Pure and side-effect
 * free so the exact same heuristic runs on the server (the online capture path) and on-device
 * (the offline capture path in packages/offline-runtime) without duplicating logic between them -
 * see services/api/src/cp2/domains/commerce/shared.ts and
 * packages/offline-runtime/providers/product-capture-entity.ts, both of which import these from
 * here rather than redefining them.
 */
export function captureField<T>(
  value: T | null,
  confidence: number | null
): ProductCaptureField<T> {
  return {
    value,
    source: value === null ? "not_detected" : "vision_extraction",
    confidence: value === null ? null : confidence
  };
}

export function firstProductCaptureTitle(text: string): string | null {
  const firstUsefulLine = text
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/\s+/gu, " "))
    .find(
      (line) =>
        line.length > 1 && !/^(?:ksh|kes|usd|tzs|ugx|zar|eur|gbp|\$|€|£)\s*[\d,.]+$/iu.test(line)
    );
  return firstUsefulLine === undefined ? null : firstUsefulLine.slice(0, 160);
}

export function visibleProductCapturePrice(text: string): number | null {
  const match = text.match(
    /(?:\b(?:ksh|kes|usd|tzs|ugx|zar|eur|gbp)\b|[$€£])\s*([0-9]+(?:[,.][0-9]{1,3})*)/iu
  );
  if (match?.[1] === undefined) return null;
  const normalized = match[1].replace(/,/gu, "");
  const price = Number(normalized);
  return Number.isFinite(price) && price >= 0 ? price : null;
}

/**
 * Builds the single-entry `items` array that mirrors a job's `fields`. Every capture produces
 * exactly one item today since no real vision/detection model is wired in (see
 * ProductCaptureItemSummary's doc comment) - this keeps `items` in sync with `fields` across
 * create/review/retry while preserving an existing item's id/status/boundingBox when supplied, so
 * a field edit does not reset an already-confirmed or already-rejected item back to pending.
 */
export function productCaptureItemsFromFields(
  fields: ProductCaptureJobSummary["fields"],
  existingItems?: ProductCaptureItemSummary[]
): ProductCaptureItemSummary[] {
  const existing = existingItems?.[0];
  return [
    {
      id: existing?.id ?? crypto.randomUUID(),
      fields,
      boundingBox: existing?.boundingBox ?? null,
      status: existing?.status ?? "pending_review",
      confirmedProductId: existing?.confirmedProductId ?? null
    }
  ];
}

function normalizeProductAliases(aliases: string[]): string[] {
  const normalized = aliases
    .map((alias) => normalizeRequiredText(alias))
    .filter((alias) => alias.length > 0);
  return [...new Map(normalized.map((alias) => [normalizeCatalogueText(alias), alias])).values()];
}

function catalogueMatchScore(
  product: ProductSummary,
  query: string,
  queryTokens: string[]
): number {
  if (query.length === 0) return 1;
  const aliases = product.aliases ?? [];
  const normalizedName = normalizeCatalogueText(product.name);
  const normalizedSku = normalizeCatalogueText(product.sku ?? "");
  const normalizedAliases = aliases.map(normalizeCatalogueText);
  const names = [normalizedName, normalizedSku, ...normalizedAliases]
    .map(normalizeCatalogueText)
    .filter((value) => value.length > 0);

  if (normalizedName === query) return 1_000;
  if (normalizedSku === query) return 990;
  if (normalizedAliases.some((alias) => alias === query)) return 980;

  const candidateTokens = catalogueTokens(names.join(" "));
  const tokenMatches = queryTokens.filter((token) =>
    candidateTokens.some((candidate) => candidate === token || candidate.startsWith(token))
  ).length;
  if (queryTokens.length > 0 && tokenMatches === queryTokens.length) {
    return 800 + tokenMatches;
  }
  if (names.some((value) => value.includes(query) || query.includes(value))) return 700;

  const bestSimilarity = Math.max(
    0,
    ...names.map((value) => normalizedEditSimilarity(query, value))
  );
  return bestSimilarity >= 0.68 ? Math.round(bestSimilarity * 600) : 0;
}

function normalizeCatalogueText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}\s.-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function catalogueTokens(value: string): string[] {
  return normalizeCatalogueText(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function normalizedEditSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  const maximum = Math.max(left.length, right.length);
  if (maximum === 0) return 1;
  if (Math.abs(left.length - right.length) > Math.max(3, Math.floor(maximum * 0.4))) return 0;

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + substitution
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return 1 - (previous[right.length] ?? maximum) / maximum;
}

export function normalizeStockAdjustmentInput(
  input: StockAdjustmentInput
): NormalizedStockAdjustmentInput {
  return {
    quantityAfter: input.quantityAfter,
    reason: normalizeOptionalText(input.reason) || "Manual stock adjustment"
  };
}

export function normalizeInvoiceInput(input: InvoiceInput): NormalizedInvoiceInput {
  return {
    customerId: nullableText(input.customerId),
    customerName: nullableText(input.customerName),
    taxRate: roundMoney(input.taxRate ?? 0),
    items: input.items.map((item) => ({
      productId: normalizeRequiredText(item.productId),
      quantity: item.quantity,
      unitPrice: roundMoney(item.unitPrice)
    }))
  };
}

export function normalizePaymentInput(input: PaymentInput): NormalizedPaymentInput {
  return {
    invoiceId: normalizeRequiredText(input.invoiceId),
    amount: roundMoney(input.amount),
    method: input.method,
    reference: nullableText(input.reference),
    note: nullableText(input.note)
  };
}

export function isPaymentMethod(value: string): value is PaymentMethod {
  return paymentMethods.includes(value as PaymentMethod);
}

export function createInvoicePreview(input: {
  businessId: string;
  invoice: InvoiceInput;
  products: ProductSummary[];
  customer?: CustomerSummary | null;
}): InvoicePreview {
  const normalized = normalizeInvoiceInput(input.invoice);
  const items = normalized.items.map((item) => {
    const product = input.products.find((candidate) => candidate.id === item.productId);

    return {
      productId: item.productId,
      productName: product?.name ?? "Unknown product",
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: roundMoney(item.quantity * item.unitPrice)
    };
  });
  const totals = calculateInvoiceTotals(items, normalized.taxRate);

  return {
    businessId: input.businessId,
    customerId: input.customer?.id ?? normalized.customerId,
    customerName: input.customer?.name ?? normalized.customerName,
    items,
    ...totals
  };
}

export function calculateInvoiceTotals(
  items: Array<{ lineTotal: number }>,
  taxRate: number
): {
  subtotal: number;
  taxRate: number;
  taxTotal: number;
  total: number;
} {
  const subtotal = roundMoney(items.reduce((sum, item) => sum + item.lineTotal, 0));
  const normalizedTaxRate = roundMoney(taxRate);
  const taxTotal = roundMoney(subtotal * normalizedTaxRate);

  return {
    subtotal,
    taxRate: normalizedTaxRate,
    taxTotal,
    total: roundMoney(subtotal + taxTotal)
  };
}

export function calculateInvoicePaymentStatus(input: {
  invoiceTotal: number;
  paidTotal: number;
}): InvoicePaymentStatus {
  const invoiceTotal = roundMoney(input.invoiceTotal);
  const paidTotal = roundMoney(input.paidTotal);

  if (paidTotal <= 0) {
    return "unpaid";
  }

  return paidTotal >= invoiceTotal ? "paid" : "partially_paid";
}

export function createInvoicePaymentSummary(input: {
  invoice: InvoiceSummary;
  payments: PaymentSummary[];
}): InvoicePaymentSummary {
  const paidTotal = roundMoney(
    input.payments
      .filter((payment) => payment.invoiceId === input.invoice.id)
      .reduce((sum, payment) => sum + payment.amount, 0)
  );
  const balanceDue = roundMoney(Math.max(0, input.invoice.total - paidTotal));

  return {
    invoiceId: input.invoice.id,
    businessId: input.invoice.businessId,
    invoiceNumber: input.invoice.invoiceNumber,
    customerId: input.invoice.customerId,
    customerName: input.invoice.customerName,
    invoiceTotal: input.invoice.total,
    paidTotal,
    balanceDue,
    status: calculateInvoicePaymentStatus({
      invoiceTotal: input.invoice.total,
      paidTotal
    })
  };
}

export function productCreatedEvent(input: {
  id: string;
  product: ProductSummary;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{ product: ProductSummary }> {
  return createEvent({
    id: input.id,
    type: "product.created",
    aggregateId: input.product.id,
    aggregateType: "product",
    actorId: input.actorId,
    risk: "low",
    occurredAt: input.occurredAt,
    payload: {
      product: input.product
    }
  });
}

export function productUpdatedEvent(input: {
  id: string;
  product: ProductSummary;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{ product: ProductSummary }> {
  return createEvent({
    id: input.id,
    type: "product.updated",
    aggregateId: input.product.id,
    aggregateType: "product",
    actorId: input.actorId,
    risk: "low",
    occurredAt: input.occurredAt,
    payload: {
      product: input.product
    }
  });
}

export function productDeletedEvent(input: {
  id: string;
  product: ProductSummary;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{ product: ProductSummary }> {
  return createEvent({
    id: input.id,
    type: "product.deleted",
    aggregateId: input.product.id,
    aggregateType: "product",
    actorId: input.actorId,
    risk: "medium",
    occurredAt: input.occurredAt,
    payload: {
      product: input.product
    }
  });
}

export function customerCreatedEvent(input: {
  id: string;
  customer: CustomerSummary;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{ customer: CustomerSummary }> {
  return createEvent({
    id: input.id,
    type: "customer.created",
    aggregateId: input.customer.id,
    aggregateType: "customer",
    actorId: input.actorId,
    risk: "low",
    occurredAt: input.occurredAt,
    payload: {
      customer: input.customer
    }
  });
}

export function customerUpdatedEvent(input: {
  id: string;
  customer: CustomerSummary;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{ customer: CustomerSummary }> {
  return createEvent({
    id: input.id,
    type: "customer.updated",
    aggregateId: input.customer.id,
    aggregateType: "customer",
    actorId: input.actorId,
    risk: "low",
    occurredAt: input.occurredAt,
    payload: {
      customer: input.customer
    }
  });
}

export function stockAdjustedEvent(input: {
  id: string;
  movement: InventoryMovementSummary;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{ movement: InventoryMovementSummary }> {
  return createEvent({
    id: input.id,
    type: "inventory.stock_adjusted",
    aggregateId: input.movement.productId,
    aggregateType: "product",
    actorId: input.actorId,
    risk: "medium",
    occurredAt: input.occurredAt,
    payload: {
      movement: input.movement
    }
  });
}

export function invoiceCreatedEvent(input: {
  id: string;
  invoice: InvoiceSummary;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{ invoice: InvoiceSummary }> {
  return createEvent({
    id: input.id,
    type: "invoice.created",
    aggregateId: input.invoice.id,
    aggregateType: "invoice",
    actorId: input.actorId,
    risk: "medium",
    occurredAt: input.occurredAt,
    payload: {
      invoice: input.invoice
    }
  });
}

export function invoiceUpdatedEvent(input: {
  id: string;
  invoice: InvoiceSummary;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{ invoice: InvoiceSummary }> {
  return createEvent({
    id: input.id,
    type: "invoice.updated",
    aggregateId: input.invoice.id,
    aggregateType: "invoice",
    actorId: input.actorId,
    risk: "medium",
    occurredAt: input.occurredAt,
    payload: {
      invoice: input.invoice
    }
  });
}

export function invoiceConfirmedEvent(input: {
  id: string;
  invoice: InvoiceSummary;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{ invoice: InvoiceSummary }> {
  return createEvent({
    id: input.id,
    type: "invoice.confirmed",
    aggregateId: input.invoice.id,
    aggregateType: "invoice",
    actorId: input.actorId,
    risk: "high",
    occurredAt: input.occurredAt,
    payload: {
      invoice: input.invoice
    }
  });
}

export function paymentRecordedEvent(input: {
  id: string;
  payment: PaymentSummary;
  invoicePayment: InvoicePaymentSummary;
  actorId: string;
  occurredAt: string;
}): BusinessEvent<{
  payment: PaymentSummary;
  invoicePayment: InvoicePaymentSummary;
}> {
  return createEvent({
    id: input.id,
    type: "payment.recorded",
    aggregateId: input.payment.invoiceId,
    aggregateType: "invoice",
    actorId: input.actorId,
    risk: "medium",
    occurredAt: input.occurredAt,
    payload: {
      payment: input.payment,
      invoicePayment: input.invoicePayment
    }
  });
}

function inferProductFieldMapping(headers: string[]): Record<string, keyof ProductImportDraft> {
  const mapping: Record<string, keyof ProductImportDraft> = {};

  for (const header of headers) {
    const normalized = header.toLowerCase().replace(/[^a-z0-9]/g, "");

    if (
      normalized === "name" ||
      normalized === "product" ||
      normalized === "productname" ||
      normalized === "item" ||
      normalized === "itemname"
    ) {
      mapping[header] = "name";
    } else if (normalized === "sku" || normalized === "code" || normalized === "barcode") {
      mapping[header] = "sku";
    } else if (
      normalized === "unit" ||
      normalized === "measure" ||
      normalized === "uom" ||
      normalized === "pack"
    ) {
      mapping[header] = "unit";
    } else if (
      normalized === "quantity" ||
      normalized === "qty" ||
      normalized === "stock" ||
      normalized === "onhand"
    ) {
      mapping[header] = "quantity";
    } else if (
      normalized === "buyingprice" ||
      normalized === "buyprice" ||
      normalized === "cost" ||
      normalized === "costprice" ||
      normalized === "purchaseprice"
    ) {
      mapping[header] = "buyingPrice";
    } else if (
      normalized === "sellingprice" ||
      normalized === "sellprice" ||
      normalized === "price" ||
      normalized === "retailprice" ||
      normalized === "saleprice"
    ) {
      mapping[header] = "sellingPrice";
    }
  }

  return mapping;
}

function mapProductRow(
  row: Record<string, string>,
  fieldMapping: Record<string, keyof ProductImportDraft>
): ProductImportDraft {
  const mapped: ProductImportDraft = {
    name: "",
    sku: null,
    unit: "unit",
    quantity: 0,
    buyingPrice: null,
    sellingPrice: null
  };

  for (const [sourceField, targetField] of Object.entries(fieldMapping)) {
    const value = row[sourceField] ?? "";

    if (targetField === "name") {
      mapped.name = value;
    } else if (targetField === "sku") {
      mapped.sku = nullableText(value);
    } else if (targetField === "unit") {
      mapped.unit = normalizeOptionalText(value) || "unit";
    } else if (targetField === "quantity") {
      mapped.quantity = parseImportNumber(value) ?? 0;
    } else if (targetField === "buyingPrice") {
      mapped.buyingPrice = parseImportNumber(value);
    } else {
      mapped.sellingPrice = parseImportNumber(value);
    }
  }

  const normalized = normalizeProductInput(mapped);

  return {
    name: normalized.name,
    sku: normalized.sku,
    unit: normalized.unit,
    quantity: normalized.quantity,
    buyingPrice: normalized.buyingPrice,
    sellingPrice: normalized.sellingPrice
  };
}
