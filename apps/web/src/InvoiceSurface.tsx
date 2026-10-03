import {
  type CustomerSummary,
  type InvoiceFormState,
  type InvoicePreview,
  type InvoiceSummary,
  type ProductSummary
} from "./grogoni-application-shared";

import { formatMoney } from "./formatters";

import { InvoiceDocument } from "./InvoiceDocument";

export interface InvoiceSurfaceProps {
  products: ProductSummary[];
  customers: CustomerSummary[];
  invoices: InvoiceSummary[];
  form: InvoiceFormState;
  preview: InvoicePreview | null;
  onFormChange: (form: InvoiceFormState) => void;
  onPreview: () => void;
  onSave: () => void;
  onReset: () => void;
  onEdit: (invoice: InvoiceSummary) => void;
  onConfirm: (invoiceId: string) => void;
  onPrint: (invoice: InvoiceSummary | InvoicePreview) => void;
}

export function InvoiceSurface(props: InvoiceSurfaceProps) {
  const selectedCustomer = props.customers.find(
    (customer) => customer.id === props.form.customerId
  );

  return (
    <div className="records-surface">
      <section className="record-form" aria-label="Invoice draft form">
        <div className="section-heading">
          <p className="eyebrow">{props.form.id === null ? "New invoice" : "Draft invoice"}</p>
          <h3>{props.form.id === null ? "Create invoice" : "Update invoice draft"}</h3>
        </div>
        <div className="form-row">
          <label>
            Customer
            <select
              value={props.form.customerId}
              onChange={(event) => {
                const customer = props.customers.find((item) => item.id === event.target.value);
                props.onFormChange({
                  ...props.form,
                  customerId: event.target.value,
                  customerName: customer === undefined ? props.form.customerName : ""
                });
              }}
            >
              <option value="">Walk-in or typed customer</option>
              {props.customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Customer name
            <input
              value={selectedCustomer?.name ?? props.form.customerName}
              onChange={(event) =>
                props.onFormChange({
                  ...props.form,
                  customerId: "",
                  customerName: event.target.value
                })
              }
              disabled={props.form.customerId !== ""}
            />
          </label>
        </div>
        <div className="form-row">
          <label>
            Product
            <select
              value={props.form.productId}
              onChange={(event) =>
                props.onFormChange({ ...props.form, productId: event.target.value })
              }
            >
              <option value="">Select product</option>
              {props.products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name} ({product.quantity} {product.unit})
                </option>
              ))}
            </select>
          </label>
          <label>
            Quantity
            <input
              value={props.form.quantity}
              onChange={(event) =>
                props.onFormChange({ ...props.form, quantity: event.target.value })
              }
              inputMode="decimal"
            />
          </label>
        </div>
        <div className="form-row">
          <label>
            Unit price
            <input
              value={props.form.unitPrice}
              onChange={(event) =>
                props.onFormChange({ ...props.form, unitPrice: event.target.value })
              }
              inputMode="decimal"
            />
          </label>
          <label>
            Tax rate
            <input
              value={props.form.taxRate}
              onChange={(event) =>
                props.onFormChange({ ...props.form, taxRate: event.target.value })
              }
              inputMode="decimal"
            />
          </label>
        </div>
        <div className="actions">
          <button type="button" onClick={props.onPreview} disabled={props.products.length === 0}>
            Preview
          </button>
          <button type="button" onClick={props.onSave} disabled={props.products.length === 0}>
            {props.form.id === null ? "Save draft" : "Update draft"}
          </button>
        </div>
        <button className="secondary" type="button" onClick={props.onReset}>
          Clear
        </button>
      </section>

      <section className="invoice-preview" aria-label="Invoice preview">
        {props.preview === null ? (
          <div className="empty-record">
            <h3>No preview yet</h3>
            <p>Preview calculates totals without changing inventory.</p>
          </div>
        ) : (
          <InvoiceDocument invoice={props.preview} />
        )}
        {props.preview !== null ? (
          <button type="button" onClick={() => props.onPrint(props.preview as InvoicePreview)}>
            Print
          </button>
        ) : null}
      </section>

      <section className="record-list" aria-label="Invoices">
        {props.invoices.length === 0 ? (
          <div className="empty-record">
            <h3>No invoices yet</h3>
            <p>Create the first invoice draft to preview totals and confirm stock movement.</p>
          </div>
        ) : (
          props.invoices.map((invoice) => (
            <article className="record-row invoice-row" key={invoice.id}>
              <div>
                <strong>
                  {invoice.invoiceNumber} · {invoice.status}
                </strong>
                <span>
                  {invoice.customerName ?? "Walk-in customer"} · {formatMoney(invoice.total)}
                </span>
              </div>
              <div className="row-actions">
                <button type="button" onClick={() => props.onEdit(invoice)}>
                  View
                </button>
                <button type="button" onClick={() => props.onPrint(invoice)}>
                  Print
                </button>
                <button
                  type="button"
                  onClick={() => props.onConfirm(invoice.id)}
                  disabled={invoice.status === "confirmed"}
                >
                  Confirm
                </button>
              </div>
            </article>
          ))
        )}
      </section>
    </div>
  );
}
