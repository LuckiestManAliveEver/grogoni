import type {
  ReceiptStructuredExtractionSummary,
  ReceiptContactMatchingResultSummary
} from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import { normalizeDocumentType } from "./receipt-validation.js";
import {
  buildReceiptStructuredExtraction,
  parseReceiptMoney,
  parseReceiptText,
  type ParsedReceiptText
} from "./shared.js";

const amounts = new Set(["subtotal", "discount", "tax", "total", "amountPaid", "balance"]);
/** Only document fields are accepted. Model output cannot select records, tools or permissions. */
export function parseReceiptFields(value: unknown): ReceiptStructuredExtractionSummary {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Cp2Error(400, "receipt_fields_invalid", "Receipt fields must be an object.");
  const source = value as Record<string, unknown>;
  const fields = buildReceiptStructuredExtraction(parseReceiptText(""));
  for (const section of ["supplier", "salesAgent", "receipt"] as const) {
    const input = source[section];
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Cp2Error(400, "receipt_fields_invalid", `Missing receipt section: ${section}.`);
    for (const key of Object.keys(fields[section])) {
      const raw = (input as Record<string, unknown>)[key] ?? null;
      // A printed amount sent as text ("KES 3,800") is that number; anything else stays invalid.
      const item =
        section === "receipt" && amounts.has(key) && typeof raw === "string"
          ? (moneyFromText(raw) ?? raw)
          : raw;
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
    return {
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
  // A document type a person or Luna named (resolveReceiptDocumentType cross-checks Luna's).
  fields.receipt.documentType = normalizeDocumentType(fields.receipt.documentType);
  // A computed line total stays marked as computed while it still equals its calculation; one a
  // person changed is what they entered.
  fields.derivedFields = (Array.isArray(source.derivedFields) ? source.derivedFields : [])
    .slice(0, 400)
    .filter((path): path is string => {
      if (typeof path !== "string") return false;
      // An assumed type stays assumed only while nobody chose one (withReceiptChecks re-adds it).
      if (path === "receipt.documentType") return false;
      const line = /^products\.(\d+)\.lineTotal$/u.exec(path);
      const product = line ? fields.products[Number(line[1])] : undefined;
      return (
        product !== undefined &&
        Math.abs(Math.round(product.quantity * product.unitPrice * 100) / 100 - product.lineTotal) <
          0.005
      );
    });
  if (fields.receipt.purchaseDate && !Number.isFinite(Date.parse(fields.receipt.purchaseDate)))
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
    total: f.receipt.total,
    amountPaid: f.receipt.amountPaid,
    balance: f.receipt.balance,
    paymentMethod: f.receipt.paymentMethod,
    tillNumber: f.receipt.tillNumber,
    paybillNumber: f.receipt.paybillNumber,
    transactionReference: f.receipt.transactionReference,
    items: f.products.map((p, index) => ({
      ...((f.derivedFields ?? []).includes(`products.${index}.lineTotal`)
        ? { totalDerived: true }
        : {}),
      name: p.itemName,
      itemCode: p.itemCode,
      sku: p.sku,
      quantity: p.quantity,
      unit: p.unit,
      unitPrice: p.unitPrice,
      total: p.lineTotal,
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

/** A whole printed amount ("3800", "KES 3,800.50"), or null when the text is anything more. */
function moneyFromText(value: string): number | null {
  const bare = value.replace(/^\s*(?:KES|KSH|Ksh|Kshs\.?|Sh\.?)\s*/u, "").trim();
  return /^(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]{1,2})?$/u.test(bare)
    ? parseReceiptMoney(bare)
    : null;
}
