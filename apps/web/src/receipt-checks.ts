import type { ReceiptDocumentType } from "@grogoni/shared-types";

/** How each document type reads in the review screen. */
export const receiptDocumentTypeLabels: Record<ReceiptDocumentType, string> = {
  purchase_receipt: "Purchase receipt",
  delivery_note: "Delivery note",
  invoice: "Invoice (amount owed)",
  pro_forma: "Pro-forma invoice",
  quotation: "Quotation",
  sales_receipt: "Our own sales receipt",
  payment_receipt: "Payment receipt",
  return: "Return note",
  refund: "Refund",
  credit_note: "Credit note",
  unknown: "Not sure: choose one"
};
