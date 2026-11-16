import type {
  ReceiptDocumentType,
  DocumentEffectPolicy,
  ReceiptStructuredExtractionSummary
} from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";

/** Extraction proposes a class. Only the authenticated confirmation path may apply effects. */
export function documentEffectPolicy(type: ReceiptDocumentType): DocumentEffectPolicy {
  switch (type) {
    case "sales_receipt":
      return {
        kind: "goods_sale",
        postsInventory: true,
        postsBalance: true,
        postsPayment: false,
        buyerStockSign: 1
      };
    case "invoice":
      return {
        kind: "goods_sale",
        postsInventory: true,
        postsBalance: true,
        postsPayment: false,
        buyerStockSign: 1
      };
    case "delivery_note":
      return {
        kind: "delivery_confirmation",
        postsInventory: true,
        postsBalance: false,
        postsPayment: false,
        buyerStockSign: 1
      };
    case "return_receipt":
      return {
        kind: "return",
        postsInventory: true,
        postsBalance: false,
        postsPayment: false,
        buyerStockSign: -1
      };
    case "credit_note":
      return {
        kind: "credit_note",
        postsInventory: false,
        postsBalance: true,
        postsPayment: false,
        buyerStockSign: 0
      };
    case "refund_receipt":
      return {
        kind: "refund",
        postsInventory: false,
        postsBalance: false,
        postsPayment: true,
        buyerStockSign: 0
      };
    case "payment_receipt":
      return {
        kind: "payment",
        postsInventory: false,
        postsBalance: false,
        postsPayment: true,
        buyerStockSign: 0
      };
    case "quotation":
      return {
        kind: "quotation",
        postsInventory: false,
        postsBalance: false,
        postsPayment: false,
        buyerStockSign: 0
      };
    case "pro_forma_invoice":
      return {
        kind: "pro_forma",
        postsInventory: false,
        postsBalance: false,
        postsPayment: false,
        buyerStockSign: 0
      };
    case "unknown":
      return {
        kind: "quotation",
        postsInventory: false,
        postsBalance: false,
        postsPayment: false,
        buyerStockSign: 0
      };
  }
}

export function requirePurchaseDocument(
  fields: ReceiptStructuredExtractionSummary,
  receiveInventory: boolean
): void {
  const type = fields.documentType ?? "unknown";
  if (!fields.receipt.purchaseDate || !Number.isFinite(Date.parse(fields.receipt.purchaseDate)))
    throw new Cp2Error(
      409,
      "receipt_date_review_required",
      "Enter the receipt date before posting. Today's date is not substituted for an unknown transaction date."
    );

  // The existing writer creates purchases and positive stock movements only. Other classes must
  // use their own authorized workflow, never masquerade as a purchase through this endpoint.
  if (!["sales_receipt", "invoice", "delivery_note"].includes(type))
    throw new Cp2Error(
      409,
      "receipt_document_review_required",
      "Classify this document as a purchase invoice, sales receipt or delivery note before recording a purchase. Quotations, payments, returns and credits cannot use purchase confirmation."
    );
  if (
    receiveInventory &&
    (!documentEffectPolicy(type).postsInventory || fields.fulfillmentStatus !== "received")
  )
    throw new Cp2Error(
      409,
      "receipt_fulfillment_required",
      "Confirm that the goods were received before adding inventory. An invoice alone does not prove delivery or payment."
    );
}
