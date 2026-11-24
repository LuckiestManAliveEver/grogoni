/**
 * Deterministic receipt checks that run before anything is posted (receipt-to-commerce checklist,
 * P0): what kind of document it is and what that document may change, whether its printed
 * arithmetic holds, and which values were printed rather than derived. A model's reading is
 * evidence for review; these rules decide what a confirmation may post.
 */
import type {
  ReceiptArithmeticIssueSummary,
  ReceiptChecksSummary,
  ReceiptDocumentType,
  ReceiptStructuredExtractionSummary
} from "@grogoni/shared-types";

export type { ReceiptDocumentType };

export const receiptDocumentTypes = [
  "purchase_receipt",
  "delivery_note",
  "invoice",
  "pro_forma",
  "quotation",
  "sales_receipt",
  "payment_receipt",
  "return",
  "refund",
  "credit_note",
  "unknown"
] as const satisfies readonly ReceiptDocumentType[];

export interface ReceiptDocumentEffects {
  /** May record a purchase (a payable or paid expense) for the scanning shop. */
  recordPurchase: boolean;
  /** May add the goods to the scanning shop's stock. */
  receiveStock: boolean;
  /** Why it may not post, when it may not. */
  refusal: string | null;
}

/**
 * What each document type may do. Quotations and pro-formas are offers: they never move stock or
 * money. Returns, refunds and credit notes reverse an earlier purchase, which needs the receipt
 * reversal workflow; until then they are refused rather than posted as new purchases. A sales
 * receipt or payment receipt is not a delivery to this shop. An invoice records what is owed;
 * it never implies payment (amountPaid stays as printed).
 */
export function receiptDocumentEffects(type: ReceiptDocumentType): ReceiptDocumentEffects {
  switch (type) {
    case "purchase_receipt":
    case "delivery_note":
    case "invoice":
      return { recordPurchase: true, receiveStock: true, refusal: null };
    case "pro_forma":
    case "quotation":
      return {
        recordPurchase: false,
        receiveStock: false,
        refusal:
          "A quotation or pro-forma is an offer: it cannot be saved as a purchase or move stock."
      };
    case "return":
    case "refund":
    case "credit_note":
      return {
        recordPurchase: false,
        receiveStock: false,
        refusal:
          "Returns, refunds and credit notes reverse an earlier purchase and are not supported yet. Keep this as a draft."
      };
    case "sales_receipt":
    case "payment_receipt":
      return {
        recordPurchase: false,
        receiveStock: false,
        refusal:
          "This is a sales or payment receipt, not goods delivered to this shop. It cannot be saved as a purchase."
      };
    case "unknown":
      return {
        recordPurchase: false,
        receiveStock: false,
        refusal: "Choose what kind of document this is before confirming it."
      };
  }
}

/** Printed headings, most specific first: "PRO FORMA INVOICE" is a pro-forma, not an invoice. */
const headingRules: Array<[ReceiptDocumentType, RegExp]> = [
  ["pro_forma", /\bpro[\s-]?forma\b/iu],
  ["credit_note", /\bcredit\s+note\b/iu],
  ["quotation", /\b(?:quotation|quote\s+no\.?|price\s+quote|nukuu)\b/iu],
  ["refund", /\brefund\b/iu],
  ["return", /\b(?:goods\s+)?return(?:s|ed)?\s+(?:note|slip|receipt)\b/iu],
  ["delivery_note", /\b(?:delivery\s+note|dispatch\s+note|goods\s+received\s+note|grn)\b/iu],
  ["payment_receipt", /\b(?:payment\s+receipt|official\s+receipt|receipt\s+of\s+payment)\b/iu],
  ["invoice", /\b(?:tax\s+)?invoice\b|\bankara\b/iu],
  ["purchase_receipt", /\b(?:cash\s+sale|receipt|risiti|stakabadhi)\b/iu]
];

/** The type the document's own printed headings name, or null when none does. */
export function classifyReceiptText(text: string): ReceiptDocumentType | null {
  // Headings sit at the top: classify on the first lines, so "receipt no." in a footer of a
  // quotation does not decide it.
  const head = text.split(/\r?\n/u).slice(0, 8).join("\n");
  for (const [type, rule] of headingRules) if (rule.test(head)) return type;
  return null;
}

/**
 * The document type to use: the model's when the printed headings agree with it or name none,
 * the headings' when the model gave none, and "unknown" (a person chooses) when they disagree.
 * The model's legacy "delivery_receipt" is a delivery note.
 */
export function resolveReceiptDocumentType(
  modelType: string | null | undefined,
  text: string
): ReceiptDocumentType {
  // The scanner is the buyer: a seller's sales receipt is their purchase receipt. "Our own sales
  // receipt" is a person's choice in review, never a model's reading (eval-receipt-reading.ts).
  const read = normalizeDocumentType(modelType);
  const fromModel = read === "sales_receipt" ? "purchase_receipt" : read;
  const fromText = classifyReceiptText(text);
  if (fromModel === null) return fromText ?? "unknown";
  if (fromText === null || fromText === fromModel) return fromModel;
  // A plain "receipt" heading is generic: it does not contradict a more specific model reading.
  if (fromText === "purchase_receipt" && fromModel !== "quotation" && fromModel !== "pro_forma")
    return fromModel;
  return "unknown";
}

export function normalizeDocumentType(value: unknown): ReceiptDocumentType | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, "_");
  if (normalized === "delivery_receipt") return "delivery_note";
  if (normalized === "proforma") return "pro_forma";
  return (receiptDocumentTypes as readonly string[]).includes(normalized)
    ? (normalized as ReceiptDocumentType)
    : null;
}

export interface ReceiptArithmeticInput {
  products: Array<{ itemName: string; quantity: number; unitPrice: number; lineTotal: number }>;
  subtotal: number | null;
  discount: number | null;
  tax: number | null;
  total: number | null;
  amountPaid: number | null;
  balance: number | null;
  /** Values computed rather than printed (paths such as "products.0.lineTotal"). */
  derivedFields: readonly string[];
}

export type ReceiptArithmeticIssue = ReceiptArithmeticIssueSummary;

/** Shillings are printed to the cent at most; anything within half a cent is rounding. */
const tolerance = 0.005;
const round = (value: number) => Math.round(value * 100) / 100;
const differs = (a: number, b: number) => Math.abs(round(a) - round(b)) > tolerance;

/**
 * Every printed calculation on the receipt, recomputed. A value the parser derived is never
 * checked against itself (that would always pass): only printed values are compared. Tax may be
 * inclusive (Kenyan VAT usually is: total = subtotal − discount) or exclusive (total = subtotal −
 * discount + tax); either reading that holds is accepted.
 */
export function validateReceiptArithmetic(input: ReceiptArithmeticInput): ReceiptArithmeticIssue[] {
  const derived = new Set(input.derivedFields);
  const issues: ReceiptArithmeticIssue[] = [];
  input.products.forEach((product, index) => {
    const field = `products.${index}.lineTotal`;
    if (derived.has(field)) return;
    const expected = round(product.quantity * product.unitPrice);
    if (differs(expected, product.lineTotal))
      issues.push({
        code: "line_total_mismatch",
        field,
        expected,
        printed: product.lineTotal,
        message: `${product.itemName}: ${product.quantity} × ${product.unitPrice} is ${expected}, but the line says ${product.lineTotal}.`
      });
  });
  const lineSum = round(input.products.reduce((sum, product) => sum + product.lineTotal, 0));
  if (input.subtotal !== null && !derived.has("receipt.subtotal") && input.products.length > 0)
    if (differs(lineSum, input.subtotal))
      issues.push({
        code: "subtotal_mismatch",
        field: "receipt.subtotal",
        expected: lineSum,
        printed: input.subtotal,
        message: `The lines add up to ${lineSum}, but the subtotal says ${input.subtotal}.`
      });
  if (input.total !== null && !derived.has("receipt.total")) {
    const base = input.subtotal ?? (input.products.length > 0 ? lineSum : null);
    if (base !== null) {
      const discounted = round(base - (input.discount ?? 0));
      const readings = [discounted, round(discounted + (input.tax ?? 0))];
      if (readings.every((reading) => differs(reading, input.total!)))
        issues.push({
          code: "total_mismatch",
          field: "receipt.total",
          expected: input.tax ? readings[1]! : readings[0]!,
          printed: input.total,
          message:
            input.tax || input.discount
              ? `Subtotal ${base}${input.discount ? ` less discount ${input.discount}` : ""}${input.tax ? ` (tax ${input.tax}, inclusive or added)` : ""} does not give the total ${input.total}.`
              : `The lines add up to ${base}, but the total says ${input.total}.`
        });
    }
  }
  if (input.total !== null && input.amountPaid !== null) {
    if (input.balance !== null && !derived.has("receipt.balance")) {
      const expected = round(input.total - input.amountPaid);
      // A balance printed as change (paid more than due) is the same amount, sign aside.
      if (differs(Math.abs(expected), Math.abs(input.balance)))
        issues.push({
          code: "balance_mismatch",
          field: "receipt.balance",
          expected,
          printed: input.balance,
          message: `Total ${input.total} less paid ${input.amountPaid} is ${expected}, but the balance says ${input.balance}.`
        });
    }
  }
  return issues;
}

/**
 * The checks for a draft, as confirmation will apply them. A draft saved before these checks
 * existed (no `checks` on its extraction) and naming no document type is read as a purchase
 * receipt, which is how it behaved then, unless its own headings say otherwise.
 */
export function receiptChecksFor(
  extraction: ReceiptStructuredExtractionSummary,
  fullText: string
): ReceiptChecksSummary {
  const named = normalizeDocumentType(extraction.receipt.documentType);
  const documentType: ReceiptDocumentType =
    named ??
    (extraction.checks === undefined
      ? (classifyReceiptText(fullText) ?? "purchase_receipt")
      : "unknown");
  const effects = receiptDocumentEffects(documentType);
  return {
    documentType,
    recordPurchase: effects.recordPurchase,
    receiveStock: effects.receiveStock,
    refusal: effects.refusal,
    arithmeticIssues: validateReceiptArithmetic({
      products: extraction.products,
      subtotal: extraction.receipt.subtotal,
      discount: extraction.receipt.discount,
      tax: extraction.receipt.tax,
      total: extraction.receipt.total,
      amountPaid: extraction.receipt.amountPaid,
      balance: extraction.receipt.balance,
      derivedFields: extraction.derivedFields ?? []
    })
  };
}

/**
 * The extraction with its checks recomputed (every draft create and correction). A type it
 * already names (Luna's, cross-checked by resolveReceiptDocumentType, or a person's choice) is
 * kept. Otherwise its printed headings decide; a document with no heading at all (many shop
 * slips print none) is taken as a purchase receipt, and that is recorded as an assumption in
 * derivedFields ("receipt.documentType") so the review shows it was not printed.
 */
export function withReceiptChecks(
  extraction: ReceiptStructuredExtractionSummary,
  fullText: string
): ReceiptStructuredExtractionSummary {
  const named = normalizeDocumentType(extraction.receipt.documentType);
  const fromText = named === null ? classifyReceiptText(fullText) : null;
  const documentType = named ?? fromText ?? "purchase_receipt";
  const assumed = named === null && fromText === null;
  const derivedFields = [
    ...(extraction.derivedFields ?? []).filter((path) => path !== "receipt.documentType"),
    ...(assumed ? ["receipt.documentType"] : [])
  ];
  const receipt = { ...extraction.receipt, documentType };
  const checks = receiptChecksFor({ ...extraction, receipt, derivedFields }, fullText);
  return { ...extraction, receipt, derivedFields, checks };
}
