import { receiptDocumentTypes } from "@grogoni/shared-types";
import type {
  ReceiptStructuredExtractionSummary,
  ReceiptContactMatchingResultSummary
} from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import {
  buildReceiptStructuredExtraction,
  parseReceiptText,
  normalizeReceiptDate,
  type ParsedReceiptText
} from "./shared.js";

const amounts = new Set(["subtotal", "discount", "tax", "total", "amountPaid", "balance"]);
/** Only document fields are accepted. Model output cannot select records, tools or permissions. */
export function parseReceiptFields(value: unknown): ReceiptStructuredExtractionSummary {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Cp2Error(400, "receipt_fields_invalid", "Receipt fields must be an object.");
  const source = value as Record<string, unknown>;
  const fields = buildReceiptStructuredExtraction(parseReceiptText(""));
  const documentType = source.documentType ?? "unknown";
  if (!receiptDocumentTypes.includes(documentType as (typeof receiptDocumentTypes)[number]))
    throw new Cp2Error(400, "receipt_fields_invalid", "Choose a supported document type.");
  fields.documentType = documentType as (typeof receiptDocumentTypes)[number];
  const fulfillment = source.fulfillmentStatus ?? "unknown";
  if (!["unknown", "pending", "received"].includes(fulfillment as string))
    throw new Cp2Error(400, "receipt_fields_invalid", "Choose a supported fulfillment status.");
  fields.fulfillmentStatus = fulfillment as "unknown" | "pending" | "received";
  const receiptInput = source.receipt as Record<string, unknown> | undefined;
  const taxBasis = receiptInput?.taxBasis ?? "unknown";
  if (!["exclusive", "inclusive", "unknown"].includes(taxBasis as string))
    throw new Cp2Error(
      400,
      "receipt_fields_invalid",
      "Choose whether tax is included in the subtotal."
    );
  fields.receipt.taxBasis = taxBasis as "exclusive" | "inclusive" | "unknown";

  for (const section of ["supplier", "salesAgent", "receipt"] as const) {
    const input = source[section];
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Cp2Error(400, "receipt_fields_invalid", `Missing receipt section: ${section}.`);
    for (const key of Object.keys(fields[section])) {
      if (section === "receipt" && key === "taxBasis") continue;
      const item = (input as Record<string, unknown>)[key] ?? null;
      if (
        item !== null &&
        (section === "receipt" && amounts.has(key)
          ? typeof item !== "number" || !Number.isFinite(item) || item < 0
          : typeof item !== "string" || item.length > 2000)
      )
        throw new Cp2Error(
          400,
          "receipt_fields_invalid",
          `Invalid receipt field: ${section}.${key}.`
        );
      (fields[section] as Record<string, unknown>)[key] =
        typeof item === "string" ? item.trim() || null : item;
    }
  }
  if (!Array.isArray(source.products) || source.products.length > 200)
    throw new Cp2Error(400, "receipt_fields_invalid", "A receipt supports up to 200 products.");
  fields.products = source.products.map((value: unknown) => {
    if (!value || typeof value !== "object")
      throw new Cp2Error(400, "receipt_fields_invalid", "Invalid delivered product.");
    const item = value as Record<string, unknown>;
    if (typeof item.itemName !== "string" || !item.itemName.trim() || item.itemName.length > 255)
      throw new Cp2Error(400, "receipt_fields_invalid", "Each delivered product needs a name.");
    const number = (key: string) => {
      const n = item[key];
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || (key === "quantity" && n === 0))
        throw new Cp2Error(400, "receipt_fields_invalid", `Check product ${key}.`);
      return n;
    };
    const text = (key: string) => {
      const raw = item[key];
      if (raw === undefined || raw === null) return null;
      if (typeof raw !== "string" || raw.length > 255)
        throw new Cp2Error(400, "receipt_fields_invalid", `Check product ${key}.`);
      return raw.trim() || null;
    };
    if (
      item.lineDiscount != null &&
      (typeof item.lineDiscount !== "number" ||
        !Number.isFinite(item.lineDiscount) ||
        item.lineDiscount < 0)
    )
      throw new Cp2Error(400, "receipt_fields_invalid", "Check the line discount.");
    const totalSource = item.lineTotalSource ?? "unknown";
    if (!["printed", "derived", "reviewed", "unknown"].includes(totalSource as string))
      throw new Cp2Error(400, "receipt_fields_invalid", "Check the line total source.");
    return {
      lineTotalSource: totalSource as "printed" | "derived" | "reviewed" | "unknown",
      lineDiscount: typeof item.lineDiscount === "number" ? item.lineDiscount : null,
      itemName: item.itemName.trim(),
      itemCode: text("itemCode"),
      sku: text("sku"),
      quantity: number("quantity"),
      unit: text("unit"),
      unitPrice: number("unitPrice"),
      lineTotal: number("lineTotal"),
      batchNumber: text("batchNumber"),
      expiryDate: text("expiryDate")
    };
  });
  if (fields.receipt.purchaseDate && normalizeReceiptDate(fields.receipt.purchaseDate) === null)
    throw new Cp2Error(400, "receipt_fields_invalid", "Check the receipt date before saving.");
  return fields;
}

export function receiptFieldsToParsed(f: ReceiptStructuredExtractionSummary): ParsedReceiptText {
  return {
    supplierName: f.supplier.supplierName,
    supplierTradingName: f.supplier.tradingName,
    supplierLegalName: f.supplier.legalName,
    phone: f.supplier.phoneNumber,
    alternatePhone: f.supplier.alternatePhoneNumber,
    supplierEmail: f.supplier.email,
    supplierAddress: f.supplier.physicalAddress,
    supplierTaxPin: f.supplier.taxPin,
    supplierRegistrationNumber: f.supplier.registrationNumber,
    supplierBranch: f.supplier.branch,
    supplierAccountNumber: f.supplier.accountNumber,
    salesAgentName: f.salesAgent.name,
    salesAgentPhone: f.salesAgent.phoneNumber,
    salesAgentEmail: f.salesAgent.email,
    salesAgentNumber: f.salesAgent.agentNumber,
    salesAgentSupplierRepresented: f.salesAgent.supplierRepresented,
    salesAgentBranch: f.salesAgent.branch,
    salesAgentNotes: f.salesAgent.notes,
    receiptNumber: f.receipt.receiptNumber,
    invoiceNumber: f.receipt.invoiceNumber,
    orderNumber: f.receipt.orderNumber,
    receiptDate: f.receipt.purchaseDate,
    purchaseTime: f.receipt.purchaseTime,
    currency: f.receipt.currency,
    subtotal: f.receipt.subtotal,
    discount: f.receipt.discount,
    tax: f.receipt.tax,
    taxBasis: f.receipt.taxBasis ?? "unknown",
    total: f.receipt.total,
    amountPaid: f.receipt.amountPaid,
    balance: f.receipt.balance,
    paymentMethod: f.receipt.paymentMethod,
    tillNumber: f.receipt.tillNumber,
    paybillNumber: f.receipt.paybillNumber,
    transactionReference: f.receipt.transactionReference,
    items: f.products.map((p) => ({
      name: p.itemName,
      itemCode: p.itemCode,
      sku: p.sku,
      quantity: p.quantity,
      unit: p.unit,
      unitPrice: p.unitPrice,
      total: p.lineTotal,
      lineDiscount: p.lineDiscount ?? null,
      totalSource: p.lineTotalSource ?? "unknown",
      batchNumber: p.batchNumber,
      expiryDate: p.expiryDate
    }))
  };
}

export function restoreReceiptJobFields(
  fields: ReceiptStructuredExtractionSummary | undefined,
  matching: ReceiptContactMatchingResultSummary | undefined,
  fullText: string
) {
  const parsed =
    fields?.supplier && fields?.salesAgent && Array.isArray(fields.products)
      ? receiptFieldsToParsed(fields)
      : parseReceiptText(fullText);
  return {
    receiptDate: parsed.receiptDate,
    total: parsed.total,
    items: parsed.items,
    matchedSupplierId: matching?.supplier?.selectedRecordId ?? null,
    matchedSalesAgentId: matching?.salesAgent?.selectedRecordId ?? null,
    blocks: [],
    errorMessage: null,
    failureCode: null,
    imageStorageKey: null,
    imageHash: fields?.sourceDocument?.sha256 ?? null,
    imageRetained: false,
    imageDeletedAt: null,
    cleanupPending: false,
    retryCount: 0,
    processingStartedAt: null,
    completedAt: null,
    temporaryImageExpiresAt: null,
    confirmedAt: null
  };
}
