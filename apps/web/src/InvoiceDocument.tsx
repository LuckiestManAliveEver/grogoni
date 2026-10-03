import { type InvoicePreview, type InvoiceSummary } from "./grogoni-application-shared";

import { formatMoney } from "./formatters";

export function InvoiceDocument({ invoice }: { invoice: InvoicePreview | InvoiceSummary }) {
  const invoiceNumber = "invoiceNumber" in invoice ? invoice.invoiceNumber : "Preview";
  const status = "status" in invoice ? invoice.status : "preview";

  return (
    <div className="invoice-document">
      <div className="invoice-document-header">
        <div>
          <p className="eyebrow">{status}</p>
          <h3>{invoiceNumber}</h3>
        </div>
        <strong>{formatMoney(invoice.total)}</strong>
      </div>
      <p>{invoice.customerName ?? "Walk-in customer"}</p>
      <div className="invoice-lines">
        {invoice.items.map((item) => (
          <div className="invoice-line" key={item.productId}>
            <span>{item.productName}</span>
            <span>
              {item.quantity} x {formatMoney(item.unitPrice)}
            </span>
            <strong>{formatMoney(item.lineTotal)}</strong>
          </div>
        ))}
      </div>
      <div className="invoice-totals">
        <span>Subtotal</span>
        <strong>{formatMoney(invoice.subtotal)}</strong>
        <span>Tax ({Math.round(invoice.taxRate * 100)}%)</span>
        <strong>{formatMoney(invoice.taxTotal)}</strong>
        <span>Total</span>
        <strong>{formatMoney(invoice.total)}</strong>
      </div>
    </div>
  );
}
