import type { PurchaseReceiptSummary, ReceiptOCRJobSummary } from "@grogoni/shared-types";

/** Documentary relationships in this shop; these do not assert another party accepted a connection. */
export function receiptNetwork(receipt: PurchaseReceiptSummary, job?: ReceiptOCRJobSummary) {
  const document = {
    id: receipt.id,
    kind: "document",
    label:
      job?.structuredExtraction.receipt.receiptNumber ??
      receipt.sourceFileName ??
      "Delivery receipt"
  };
  const supplier = { id: receipt.supplierId, kind: "wholesaler", label: receipt.supplierName };
  const agent = receipt.salesAgentId
    ? {
        id: receipt.salesAgentId,
        kind: "sales_agent",
        label: receipt.salesAgentName ?? "Sales agent"
      }
    : null;
  const products = receipt.lineItems.map((item) => {
    const binding = job?.structuredExtraction.deliveryBinding?.products.find(
      (p) => p.receiptLineItemId === item.id
    );
    return {
      id: binding?.productId ?? item.id,
      kind: binding ? "product" : "receipt_line",
      label: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      total: item.total,
      movementId: binding?.movementId ?? null
    };
  });
  return {
    receiptId: receipt.id,
    sourceDocument: job?.structuredExtraction.sourceDocument ?? null,
    nodes: [document, supplier, ...(agent ? [agent] : []), ...products],
    edges: [
      { from: document.id, to: supplier.id, relation: "supplied_by" },
      ...(agent
        ? [
            { from: document.id, to: agent.id, relation: "handled_by" },
            { from: agent.id, to: supplier.id, relation: "represents_on_document" }
          ]
        : []),
      ...products.map((p) => ({
        from: document.id,
        to: p.id,
        relation: "delivers",
        quantity: p.quantity
      }))
    ]
  };
}
