import { createHash } from "node:crypto";
import type { ReceiptStructuredExtractionSummary } from "@grogoni/shared-types";

/** Local purchase identity. It never identifies or authorizes a counterparty account. */
export function receiptPostingIdentity(
  supplierId: string,
  fields: ReceiptStructuredExtractionSummary
): string | null {
  const reference = fields.receipt.receiptNumber ?? fields.receipt.invoiceNumber;
  if (!reference?.trim()) return null;
  // Do not include total/date: changed OCR amounts must surface as conflicts, not new stock.
  return createHash("sha256")
    .update(
      JSON.stringify([
        supplierId,
        reference.normalize("NFKC").trim().toUpperCase().replace(/\s+/gu, " ")
      ])
    )
    .digest("hex");
}
