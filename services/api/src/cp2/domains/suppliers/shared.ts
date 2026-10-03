import { randomUUID } from "node:crypto";
import type {
  NetworkNodeSummary,
  ReceiptOCRJobSummary,
  SalesAgentSummary,
  SupplierSummary
} from "@grogoni/shared-types";
import { roundMoney } from "../../money.js";
import { normalizeDestination } from "../../phone-identity.js";

export const receiptOCRDefaultPrimaryEngine = "paddleocr";
export const receiptOCRDefaultFallbackEngine = "tesseract";
export const receiptOCRDefaultProfile = "balanced";
export const receiptOCRDefaultLanguageHints = ["en", "sw"];
export const receiptOCRSupportedContentTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/vnd.ms-excel"
]);

export interface ParsedReceiptText {
  supplierName: string | null;
  supplierTradingName: string | null;
  supplierLegalName: string | null;
  salesAgentName: string | null;
  phone: string | null;
  alternatePhone: string | null;
  supplierEmail: string | null;
  supplierAddress: string | null;
  supplierTaxPin: string | null;
  supplierRegistrationNumber: string | null;
  supplierBranch: string | null;
  supplierAccountNumber: string | null;
  salesAgentPhone: string | null;
  salesAgentEmail: string | null;
  salesAgentNumber: string | null;
  salesAgentSupplierRepresented: string | null;
  salesAgentBranch: string | null;
  salesAgentNotes: string | null;
  receiptNumber: string | null;
  invoiceNumber: string | null;
  orderNumber: string | null;
  receiptDate: string | null;
  purchaseTime: string | null;
  currency: string | null;
  subtotal: number | null;
  discount: number | null;
  tax: number | null;
  total: number | null;
  amountPaid: number | null;
  balance: number | null;
  paymentMethod: string | null;
  tillNumber: string | null;
  paybillNumber: string | null;
  transactionReference: string | null;
  items: Array<{
    name: string;
    itemCode: string | null;
    sku: string | null;
    quantity: number;
    unit: string | null;
    unitPrice: number;
    total: number;
    batchNumber: string | null;
    expiryDate: string | null;
  }>;
}

export function parseReceiptText(text: string): ParsedReceiptText {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return {
    supplierName:
      findReceiptField(lines, ["supplier", "supplier name", "vendor"]) ?? lines[0] ?? null,
    supplierTradingName: findReceiptField(lines, ["trading name", "business name"]),
    supplierLegalName: findReceiptField(lines, ["legal name", "registered name"]),
    salesAgentName: findReceiptField(lines, ["agent", "sales agent", "served by"]),
    phone: normalizeReceiptPhone(findReceiptField(lines, ["phone", "tel", "mobile"]) ?? text),
    alternatePhone: normalizeReceiptPhone(
      findReceiptField(lines, ["alternate phone", "alt phone"])
    ),
    supplierEmail: normalizeReceiptEmail(
      findReceiptField(lines, ["email", "supplier email"]) ?? text
    ),
    supplierAddress: findReceiptField(lines, ["address", "physical address", "location"]),
    supplierTaxPin: findReceiptField(lines, ["tax pin", "pin", "kra pin"]),
    supplierRegistrationNumber: findReceiptField(lines, [
      "registration",
      "registration number",
      "reg no"
    ]),
    supplierBranch: findReceiptField(lines, ["branch"]),
    supplierAccountNumber: findReceiptField(lines, [
      "account",
      "account number",
      "supplier number"
    ]),
    salesAgentPhone: normalizeReceiptPhone(
      findReceiptField(lines, ["agent phone", "sales agent phone"])
    ),
    salesAgentEmail: normalizeReceiptEmail(
      findReceiptField(lines, ["agent email", "sales agent email"])
    ),
    salesAgentNumber: findReceiptField(lines, [
      "agent number",
      "employee number",
      "sales agent number"
    ]),
    salesAgentSupplierRepresented: findReceiptField(lines, ["supplier represented"]),
    salesAgentBranch: findReceiptField(lines, ["agent branch", "sales agent branch"]),
    salesAgentNotes: findReceiptField(lines, ["agent notes", "sales agent notes"]),
    receiptNumber: findReceiptField(lines, ["receipt", "receipt number", "receipt no"]),
    invoiceNumber: findReceiptField(lines, ["invoice", "invoice number", "invoice no"]),
    orderNumber: findReceiptField(lines, ["order", "order number", "order no"]),
    receiptDate: normalizeReceiptDate(findReceiptField(lines, ["date"]) ?? text),
    purchaseTime: normalizeReceiptTime(findReceiptField(lines, ["time", "purchase time"]) ?? text),
    currency: normalizeReceiptCurrency(findReceiptField(lines, ["currency"]) ?? text),
    subtotal: parseReceiptMoney(findReceiptField(lines, ["subtotal", "sub total"])),
    discount: parseReceiptMoney(findReceiptField(lines, ["discount"])),
    tax: parseReceiptMoney(findReceiptField(lines, ["tax", "vat"])),
    total: parseReceiptMoney(findReceiptField(lines, ["total", "amount"])),
    amountPaid: parseReceiptMoney(findReceiptField(lines, ["amount paid", "paid"])),
    balance: parseReceiptMoney(findReceiptField(lines, ["balance"])),
    paymentMethod: findReceiptField(lines, ["payment method", "paid by", "method"]),
    tillNumber: findReceiptField(lines, ["till", "till number"]),
    paybillNumber: findReceiptField(lines, ["paybill", "paybill number"]),
    transactionReference: findReceiptField(lines, [
      "transaction",
      "transaction reference",
      "mpesa code",
      "reference"
    ]),
    items: parseReceiptLineItems(lines)
  };
}

function findReceiptField(lines: string[], labels: string[]): string | null {
  for (const line of lines) {
    const normalized = line.toLowerCase();

    for (const label of labels) {
      if (normalized.startsWith(`${label}:`) || normalized.startsWith(`${label} -`)) {
        return line.slice(label.length + 1).trim();
      }
    }
  }

  return null;
}

function normalizeReceiptPhone(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const match = value.match(/\+?[0-9][0-9\s-]{6,18}[0-9]/u);

  if (match === null) {
    return null;
  }

  const compact = match[0].replace(/[\s-]+/gu, "");
  const kenyanNormalized = /^0[17]\d{8}$/u.test(compact)
    ? `+254${compact.slice(1)}`
    : /^254[17]\d{8}$/u.test(compact)
      ? `+${compact}`
      : compact;

  return normalizeDestination("phone", kenyanNormalized);
}

function normalizeReceiptEmail(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const match = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu);

  if (match === null) {
    return null;
  }

  try {
    return normalizeDestination("email", match[0]);
  } catch {
    return null;
  }
}

function normalizeReceiptDate(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const match = value.match(/\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}/u);
  const parsed = match === null ? NaN : Date.parse(match[0]);

  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function parseReceiptMoney(value: string | null): number | null {
  if (value === null) {
    return null;
  }

  const match = value.match(/[0-9]+(?:[.,][0-9]{1,2})?/u);

  return match === null ? null : roundMoney(Number(match[0].replace(",", ".")));
}

function normalizeReceiptTime(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const match = value.match(/\b(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?\b/u);
  return match?.[0] ?? null;
}

function normalizeReceiptCurrency(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const match = value.match(/\b(KES|KSH|USD|EUR|GBP|TZS|UGX)\b/iu);

  if (match === null) {
    return null;
  }

  return match[1]?.toUpperCase() === "KSH" ? "KES" : (match[1]?.toUpperCase() ?? null);
}

function parseReceiptLineItems(lines: string[]): ParsedReceiptText["items"] {
  const items: ParsedReceiptText["items"] = [];

  for (const line of lines) {
    const match = line.match(
      /^(?:item:)?\s*([A-Za-z][A-Za-z0-9\s-]{1,48})[,|]\s*([0-9]+(?:\.[0-9]+)?)[,|]\s*([0-9]+(?:\.[0-9]+)?)(?:[,|]\s*([0-9]+(?:\.[0-9]+)?))?/u
    );

    if (match === null) {
      continue;
    }

    const quantity = Number(match[2]);
    const unitPrice = Number(match[3]);
    const total = match[4] === undefined ? quantity * unitPrice : Number(match[4]);

    items.push({
      name: match[1]?.trim() ?? "Receipt item",
      itemCode: null,
      sku: null,
      quantity,
      unit: null,
      unitPrice: roundMoney(unitPrice),
      total: roundMoney(total),
      batchNumber: null,
      expiryDate: null
    });
  }

  return items;
}

export function buildReceiptStructuredExtraction(
  parsed: ParsedReceiptText
): ReceiptOCRJobSummary["structuredExtraction"] {
  return {
    supplier: {
      supplierName: parsed.supplierName,
      tradingName: parsed.supplierTradingName,
      legalName: parsed.supplierLegalName,
      phoneNumber: parsed.phone,
      alternatePhoneNumber: parsed.alternatePhone,
      email: parsed.supplierEmail,
      physicalAddress: parsed.supplierAddress,
      taxPin: parsed.supplierTaxPin,
      registrationNumber: parsed.supplierRegistrationNumber,
      branch: parsed.supplierBranch,
      accountNumber: parsed.supplierAccountNumber
    },
    salesAgent: {
      name: parsed.salesAgentName,
      phoneNumber: parsed.salesAgentPhone ?? parsed.phone,
      email: parsed.salesAgentEmail,
      agentNumber: parsed.salesAgentNumber,
      supplierRepresented: parsed.salesAgentSupplierRepresented,
      branch: parsed.salesAgentBranch,
      notes: parsed.salesAgentNotes
    },
    receipt: {
      receiptNumber: parsed.receiptNumber,
      invoiceNumber: parsed.invoiceNumber,
      orderNumber: parsed.orderNumber,
      purchaseDate: parsed.receiptDate,
      purchaseTime: parsed.purchaseTime,
      currency: parsed.currency,
      subtotal: parsed.subtotal,
      discount: parsed.discount,
      tax: parsed.tax,
      total: parsed.total,
      amountPaid: parsed.amountPaid,
      balance: parsed.balance,
      paymentMethod: parsed.paymentMethod,
      tillNumber: parsed.tillNumber,
      paybillNumber: parsed.paybillNumber,
      transactionReference: parsed.transactionReference
    },
    products: parsed.items.map((item) => ({
      itemName: item.name,
      itemCode: item.itemCode,
      sku: item.sku,
      quantity: item.quantity,
      unit: item.unit,
      unitPrice: item.unitPrice,
      lineTotal: item.total,
      batchNumber: item.batchNumber,
      expiryDate: item.expiryDate
    }))
  };
}

export function readReceiptContactMatchThresholds(): ReceiptOCRJobSummary["contactMatchingResult"]["thresholds"] {
  return {
    autoSelect: readDecimalEnv("OCR_CONTACT_MATCH_AUTO_SELECT", 0.95),
    confirmationRequired: readDecimalEnv("OCR_CONTACT_MATCH_CONFIRMATION_REQUIRED", 0.8),
    rejectBelow: readDecimalEnv("OCR_CONTACT_MATCH_REJECT_BELOW", 0.5)
  };
}

function readDecimalEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

export function createReceiptCandidate(input: {
  entityType: ReceiptOCRJobSummary["supplierCandidates"][number]["entityType"];
  recordId: string | null;
  contactId: string | null;
  displayName: string;
  confidence: number;
  matchedBy: string[];
  sources: string[];
  thresholds: ReceiptOCRJobSummary["contactMatchingResult"]["thresholds"];
  reason: string;
}): ReceiptOCRJobSummary["supplierCandidates"][number] {
  const id = input.recordId ?? input.contactId ?? randomUUID();

  return {
    id,
    entityType: input.entityType,
    recordId: input.recordId,
    contactId: input.contactId,
    displayName: input.displayName,
    name: input.displayName,
    confidence: roundMoney(input.confidence),
    matchedBy: [...new Set(input.matchedBy)],
    sources: [...new Set(input.sources)],
    requiresConfirmation: input.confidence < input.thresholds.autoSelect,
    reason: input.reason,
    sourceProvider: input.sources[0] ?? null
  };
}

export function selectReceiptCandidate(
  candidates: ReceiptOCRJobSummary["supplierCandidates"],
  thresholds: ReceiptOCRJobSummary["contactMatchingResult"]["thresholds"]
): ReceiptOCRJobSummary["supplierCandidates"][number] | null {
  const [first, second] = candidates;

  if (first === undefined || first.confidence < thresholds.rejectBelow) {
    return null;
  }

  if (
    second !== undefined &&
    first.confidence >= thresholds.autoSelect &&
    second.confidence >= thresholds.autoSelect &&
    Math.abs(first.confidence - second.confidence) < 0.01
  ) {
    return {
      ...first,
      requiresConfirmation: true
    };
  }

  return first;
}

export function hasTiedHighConfidenceCandidates(
  candidates: ReceiptOCRJobSummary["supplierCandidates"],
  thresholds: ReceiptOCRJobSummary["contactMatchingResult"]["thresholds"]
): boolean {
  const [first, second] = candidates;
  return (
    first !== undefined &&
    second !== undefined &&
    first.confidence >= thresholds.autoSelect &&
    second.confidence >= thresholds.autoSelect &&
    Math.abs(first.confidence - second.confidence) < 0.01
  );
}

export function compareReceiptCandidates(
  left: ReceiptOCRJobSummary["supplierCandidates"][number],
  right: ReceiptOCRJobSummary["supplierCandidates"][number]
): number {
  return right.confidence - left.confidence || left.displayName.localeCompare(right.displayName);
}

export function receiptSupplierMatchedBy(
  parsed: ParsedReceiptText,
  supplier: SupplierSummary,
  node: NetworkNodeSummary | null
): string[] {
  const matchedBy: string[] = [];

  if (node !== null && supplier.linkedPhonebookContactId === node.id) {
    matchedBy.push("confirmed_contact_link");
  }

  if (
    parsed.phone !== null &&
    supplier.phone !== null &&
    normalizeReceiptPhone(supplier.phone) === parsed.phone
  ) {
    matchedBy.push("phone_exact");
  }

  if (
    parsed.supplierEmail !== null &&
    supplier.email !== null &&
    normalizeReceiptEmail(supplier.email) === parsed.supplierEmail
  ) {
    matchedBy.push("email_exact");
  }

  if (
    parsed.supplierTaxPin !== null &&
    supplier.notes !== null &&
    normalizeReceiptIdentifier(supplier.notes).includes(
      normalizeReceiptIdentifier(parsed.supplierTaxPin)
    )
  ) {
    matchedBy.push("tax_pin_exact");
  }

  if (
    parsed.supplierRegistrationNumber !== null &&
    supplier.notes !== null &&
    normalizeReceiptIdentifier(supplier.notes).includes(
      normalizeReceiptIdentifier(parsed.supplierRegistrationNumber)
    )
  ) {
    matchedBy.push("registration_number_exact");
  }

  if (
    parsed.supplierName !== null &&
    normalizeReceiptName(supplier.name) === normalizeReceiptName(parsed.supplierName)
  ) {
    matchedBy.push("name_exact");
  }

  if (
    node !== null &&
    parsed.supplierName !== null &&
    normalizeReceiptName(node.displayName) === normalizeReceiptName(parsed.supplierName)
  ) {
    matchedBy.push("external_contact_id");
  }

  return [...new Set(matchedBy)];
}

export function receiptIdentifierConfidence(matchedBy: string[]): number {
  if (
    matchedBy.includes("confirmed_contact_link") ||
    matchedBy.includes("tax_pin_exact") ||
    matchedBy.includes("registration_number_exact") ||
    matchedBy.includes("phone_exact") ||
    matchedBy.includes("email_exact")
  ) {
    return 0.97;
  }

  if (matchedBy.includes("name_supplier_combination")) {
    return 0.86;
  }

  if (matchedBy.includes("name_exact")) {
    return 0.82;
  }

  return 0.75;
}

function normalizeReceiptIdentifier(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/gu, "");
}

export function receiptSalesAgentMatchedBy(
  parsed: ParsedReceiptText,
  agent: SalesAgentSummary,
  node: NetworkNodeSummary | null,
  supplierId: string | null
): string[] {
  const matchedBy: string[] = [];
  const extractedPhone = parsed.salesAgentPhone ?? parsed.phone;

  if (node !== null && agent.linkedPhonebookContactId === node.id) {
    matchedBy.push("confirmed_contact_link");
  }

  if (
    extractedPhone !== null &&
    agent.phone !== null &&
    normalizeReceiptPhone(agent.phone) === extractedPhone
  ) {
    matchedBy.push("phone_exact");
  }

  if (
    parsed.salesAgentName !== null &&
    normalizeReceiptName(agent.name) === normalizeReceiptName(parsed.salesAgentName)
  ) {
    matchedBy.push("name_exact");
  }

  if (supplierId !== null && agent.supplierId === supplierId) {
    matchedBy.push("name_supplier_combination");
  }

  return [...new Set(matchedBy)];
}

export function contactSourceLabel(node: NetworkNodeSummary): string {
  if (node.sourceType === "phone_contact") {
    return "phone_contacts";
  }

  if (node.sourcePlatform !== null) {
    return `${node.sourcePlatform}_contacts`;
  }

  return node.sourceType;
}

export function normalizeReceiptName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[.,'’"&/()-]+/gu, " ")
    .replace(/\b(ltd|limited|co|company|enterprises|enterprise|traders|shop|store)\b/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function normalizeReceiptContentType(contentType: string): string {
  const normalized = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return normalized.length === 0 ? "application/octet-stream" : normalized;
}

export function validateReceiptUpload(input: {
  contentType: string;
  fileSizeBytes: number | null;
  fileSignature: string | null;
}): { ok: true } | { ok: false; code: string; message: string } {
  const maxBytes = readPositiveIntegerEnv("OCR_MAX_UPLOAD_MB", 10) * 1024 * 1024;

  if (!receiptOCRSupportedContentTypes.has(input.contentType)) {
    return {
      ok: false,
      code: "receipt_ocr_unsupported_type",
      message: "Receipt upload must be JPEG, PNG, WebP, HEIC/HEIF, PDF, or text for manual retry."
    };
  }

  if (input.fileSizeBytes !== null && input.fileSizeBytes > maxBytes) {
    return {
      ok: false,
      code: "receipt_ocr_file_too_large",
      message: `Receipt upload must be ${readPositiveIntegerEnv("OCR_MAX_UPLOAD_MB", 10)} MB or smaller.`
    };
  }

  if (
    input.fileSignature !== null &&
    input.fileSignature.trim().length > 0 &&
    !receiptSignatureMatches(input.contentType, input.fileSignature)
  ) {
    return {
      ok: false,
      code: "receipt_ocr_signature_mismatch",
      message: "Receipt file contents do not match the declared upload type."
    };
  }

  return { ok: true };
}

function receiptSignatureMatches(contentType: string, signature: string): boolean {
  const hex = signature.replace(/[^a-f0-9]/giu, "").toLowerCase();

  if (contentType === "image/jpeg") {
    return hex.startsWith("ffd8ff");
  }

  if (contentType === "image/png") {
    return hex.startsWith("89504e47");
  }

  if (contentType === "image/webp") {
    return hex.startsWith("52494646") && hex.slice(16, 24) === "57454250";
  }

  if (contentType === "application/pdf") {
    return hex.startsWith("25504446");
  }

  if (contentType === "image/heic" || contentType === "image/heif") {
    return ["6674797068656963", "6674797068656966", "667479706d696631"].some((brand) =>
      hex.includes(brand)
    );
  }

  return contentType.startsWith("text/") || contentType === "application/vnd.ms-excel";
}

export function readReceiptOCRConfig(): {
  primaryEngine: ReceiptOCRJobSummary["engine"];
  engineVersion: string;
  modelVersion: string;
  profile: ReceiptOCRJobSummary["profile"];
  languageHints: string[];
} {
  const primaryEngine =
    process.env.OCR_ENGINE_PRIMARY === receiptOCRDefaultFallbackEngine
      ? receiptOCRDefaultFallbackEngine
      : receiptOCRDefaultPrimaryEngine;
  const profile =
    process.env.OCR_PROFILE === "mobile" || process.env.OCR_PROFILE === "accurate"
      ? process.env.OCR_PROFILE
      : receiptOCRDefaultProfile;
  const languageHints = (process.env.OCR_LANGUAGE_HINTS ?? receiptOCRDefaultLanguageHints.join(","))
    .split(",")
    .map((language) => language.trim())
    .filter((language) => language.length > 0);

  return {
    primaryEngine,
    engineVersion: process.env.OCR_ENGINE_VERSION ?? "paddleocr-2.8.1",
    modelVersion: process.env.OCR_MODEL_VERSION ?? `${profile}-cpu`,
    profile,
    languageHints
  };
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function buildReceiptOCRBlocks(
  text: string,
  confidence: number
): ReceiptOCRJobSummary["blocks"] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => ({
      id: `block-${index + 1}`,
      page: 1,
      text: line,
      confidence,
      boundingBox: null
    }));
}

export function averageReceiptBlockConfidence(blocks: ReceiptOCRJobSummary["blocks"]): number {
  if (blocks.length === 0) {
    return 0;
  }

  return roundMoney(blocks.reduce((sum, block) => sum + block.confidence, 0) / blocks.length);
}

export function buildReceiptFieldEvidence(
  parsed: ParsedReceiptText,
  fullText: string
): ReceiptOCRJobSummary["fieldEvidence"] {
  return [
    {
      field: "supplierName",
      value: parsed.supplierName,
      confidence: parsed.supplierName === null ? 0 : 0.86,
      sourceText: findEvidenceLine(fullText, parsed.supplierName)
    },
    {
      field: "salesAgentName",
      value: parsed.salesAgentName,
      confidence: parsed.salesAgentName === null ? 0 : 0.82,
      sourceText: findEvidenceLine(fullText, parsed.salesAgentName)
    },
    {
      field: "phone",
      value: parsed.phone,
      confidence: parsed.phone === null ? 0 : 0.88,
      sourceText: findEvidenceLine(fullText, parsed.phone)
    },
    {
      field: "receiptDate",
      value: parsed.receiptDate,
      confidence: parsed.receiptDate === null ? 0 : 0.84,
      sourceText: findEvidenceLine(fullText, parsed.receiptDate)
    },
    {
      field: "total",
      value: parsed.total,
      confidence: parsed.total === null ? 0 : 0.86,
      sourceText: parsed.total === null ? null : findEvidenceLine(fullText, String(parsed.total))
    }
  ];
}

function findEvidenceLine(fullText: string, value: string | number | null): string | null {
  if (value === null) {
    return null;
  }

  const normalizedValue = String(value).toLowerCase();
  return (
    fullText
      .split(/\r?\n/u)
      .find((line) => line.toLowerCase().includes(normalizedValue))
      ?.trim() ?? null
  );
}

export function buildReceiptOCRWarnings(parsed: ParsedReceiptText, hasContent: boolean): string[] {
  const warnings: string[] = [];

  if (!hasContent) {
    warnings.push("OCR produced no text. Retry the scan or enter the receipt manually.");
  }

  if (parsed.items.length === 0) {
    warnings.push("No line items were parsed. Review and correct the receipt before saving.");
  }

  if (parsed.total !== null && parsed.items.length > 0) {
    const itemTotal = roundMoney(parsed.items.reduce((sum, item) => sum + item.total, 0));

    if (Math.abs(itemTotal - parsed.total) > 1) {
      warnings.push("Line item total does not match the receipt total.");
    }
  }

  return warnings;
}
