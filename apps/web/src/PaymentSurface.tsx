import {
  type CustomerDebtSummary,
  type InvoicePaymentSummary,
  type InvoiceSummary,
  type PaymentFormState,
  type PaymentMethod,
  type PaymentSummary
} from "./grogoni-application-shared";

import { formatMoney } from "./formatters";

export interface PaymentSurfaceProps {
  invoices: InvoiceSummary[];
  payments: PaymentSummary[];
  invoicePayments: InvoicePaymentSummary[];
  customerDebts: CustomerDebtSummary[];
  form: PaymentFormState;
  onFormChange: (form: PaymentFormState) => void;
  onRecord: () => void;
  onRefresh: () => void;
}

export function PaymentSurface(props: PaymentSurfaceProps) {
  const confirmedInvoices = props.invoices.filter((invoice) => invoice.status === "confirmed");
  const selectedSummary = props.invoicePayments.find(
    (summary) => summary.invoiceId === props.form.invoiceId
  );
  const unpaidInvoices = props.invoicePayments.filter((summary) => summary.status !== "paid");

  return (
    <div className="records-surface">
      <section className="record-form" aria-label="Payment form">
        <div className="section-heading">
          <p className="eyebrow">Payment</p>
          <h3>Record invoice payment</h3>
        </div>
        <label>
          Invoice
          <select
            value={props.form.invoiceId}
            onChange={(event) => {
              const summary = props.invoicePayments.find(
                (item) => item.invoiceId === event.target.value
              );
              props.onFormChange({
                ...props.form,
                invoiceId: event.target.value,
                amount: summary === undefined ? props.form.amount : String(summary.balanceDue)
              });
            }}
          >
            <option value="">Select confirmed invoice</option>
            {confirmedInvoices.map((invoice) => {
              const summary = props.invoicePayments.find((item) => item.invoiceId === invoice.id);

              return (
                <option key={invoice.id} value={invoice.id} disabled={summary?.status === "paid"}>
                  {invoice.invoiceNumber} - {invoice.customerName ?? "Walk-in"} -{" "}
                  {formatMoney(summary?.balanceDue ?? invoice.total)}
                </option>
              );
            })}
          </select>
        </label>
        <div className="form-row">
          <label>
            Amount
            <input
              value={props.form.amount}
              onChange={(event) =>
                props.onFormChange({ ...props.form, amount: event.target.value })
              }
              inputMode="decimal"
            />
          </label>
          <label>
            Method
            <select
              value={props.form.method}
              onChange={(event) =>
                props.onFormChange({
                  ...props.form,
                  method: event.target.value as PaymentMethod
                })
              }
            >
              <option value="cash">Cash</option>
              <option value="bank_transfer">Bank transfer</option>
              <option value="mobile_money_manual">Manual mobile money</option>
              <option value="card_manual">Manual card</option>
              <option value="other_manual">Other manual</option>
            </select>
          </label>
        </div>
        <label>
          Reference
          <input
            value={props.form.reference}
            onChange={(event) =>
              props.onFormChange({ ...props.form, reference: event.target.value })
            }
          />
        </label>
        <label>
          Note
          <textarea
            value={props.form.note}
            onChange={(event) => props.onFormChange({ ...props.form, note: event.target.value })}
            rows={3}
          />
        </label>
        {selectedSummary !== undefined ? (
          <div className="metric-grid compact">
            <div className="metric">
              <span>Total</span>
              <strong>{formatMoney(selectedSummary.invoiceTotal)}</strong>
            </div>
            <div className="metric">
              <span>Paid</span>
              <strong>{formatMoney(selectedSummary.paidTotal)}</strong>
            </div>
            <div className="metric">
              <span>Due</span>
              <strong>{formatMoney(selectedSummary.balanceDue)}</strong>
            </div>
          </div>
        ) : null}
        <div className="actions">
          <button
            type="button"
            onClick={props.onRecord}
            disabled={props.form.invoiceId === "" || Number(props.form.amount) <= 0}
          >
            Record
          </button>
          <button className="secondary" type="button" onClick={props.onRefresh}>
            Refresh
          </button>
        </div>
      </section>

      <section className="record-list" aria-label="Invoice settlement">
        <div className="section-heading">
          <p className="eyebrow">Settlement</p>
          <h3>Open invoice balances</h3>
        </div>
        {unpaidInvoices.length === 0 ? (
          <div className="empty-record">
            <h3>No open balances</h3>
            <p>Confirmed unpaid invoices will appear here.</p>
          </div>
        ) : (
          unpaidInvoices.map((summary) => (
            <article className="record-row" key={summary.invoiceId}>
              <div>
                <strong>
                  {summary.invoiceNumber} - {summary.status.replace("_", " ")}
                </strong>
                <span>
                  {summary.customerName ?? "Walk-in customer"} - due{" "}
                  {formatMoney(summary.balanceDue)}
                </span>
              </div>
              <button
                type="button"
                onClick={() =>
                  props.onFormChange({
                    ...props.form,
                    invoiceId: summary.invoiceId,
                    amount: String(summary.balanceDue)
                  })
                }
              >
                Pay
              </button>
            </article>
          ))
        )}
      </section>

      <section className="record-list" aria-label="Customer debt">
        <div className="section-heading">
          <p className="eyebrow">Debt</p>
          <h3>Customer balances</h3>
        </div>
        {props.customerDebts.length === 0 ? (
          <div className="empty-record">
            <h3>No customer debt</h3>
            <p>Customer-linked invoice balances are clear.</p>
          </div>
        ) : (
          props.customerDebts.map((debt) => (
            <article className="record-row" key={debt.customerId}>
              <div>
                <strong>{debt.customerName}</strong>
                <span>
                  {debt.invoiceCount} invoice{debt.invoiceCount === 1 ? "" : "s"} - paid{" "}
                  {formatMoney(debt.totalPaid)}
                </span>
              </div>
              <strong>{formatMoney(debt.balanceDue)}</strong>
            </article>
          ))
        )}
      </section>

      <section className="record-list" aria-label="Recent payments">
        <div className="section-heading">
          <p className="eyebrow">Ledger</p>
          <h3>Recent payments</h3>
        </div>
        {props.payments.length === 0 ? (
          <div className="empty-record">
            <h3>No payments yet</h3>
            <p>Record a payment against a confirmed invoice.</p>
          </div>
        ) : (
          props.payments.map((payment) => (
            <article className="record-row" key={payment.id}>
              <div>
                <strong>
                  {payment.invoiceNumber} - {formatMoney(payment.amount)}
                </strong>
                <span>
                  {payment.customerName ?? "Walk-in customer"} -{" "}
                  {payment.method.replaceAll("_", " ")}
                </span>
              </div>
              <span>{new Date(payment.createdAt).toLocaleDateString()}</span>
            </article>
          ))
        )}
      </section>
    </div>
  );
}
