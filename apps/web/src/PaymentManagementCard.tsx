import { useEffect, useState } from "react";
import type { InvoicePaymentSummary, PaymentMethod } from "@grogoni/shared-types";
import { useAsyncActions } from "./hooks/useAsyncActions";
import { useApiMutationRevision } from "./hooks/useApiMutationRevision";
import { fetchFreshJson, postJson } from "./api-helpers";
import { getUserFacingErrorMessage } from "./user-facing-error";
import type { RecordPaymentResponse } from "./grogoni-application-shared";

const paymentMethods: PaymentMethod[] = [
  "cash",
  "bank_transfer",
  "mobile_money_manual",
  "card_manual",
  "other_manual"
];

// Self-contained generated-surface card for the payments domain (Phase 4e), same shape as
// InvoiceManagementCard - payment.record's proposal has always been hard-coded invalid ("needs an
// invoice id and method"), since a customer can have several open invoices and free text cannot
// reliably say which one. The chat trigger opens this card pre-filled with the extracted customer
// name; the owner picks the specific invoice here. See docs/frontend/frontend.md Phase 4e.
export default function PaymentManagementCard(props: {
  businessId: string;
  customerName?: string;
}) {
  const paymentSummariesPath = `/businesses/${props.businessId}/payment-summaries`;
  const paymentsPath = `/businesses/${props.businessId}/payments`;
  const invoicesPath = `/businesses/${props.businessId}/invoices`;
  const mutationRevision = useApiMutationRevision(paymentSummariesPath, paymentsPath, invoicesPath);
  const { isPending, runAction } = useAsyncActions();
  const [invoicePayments, setInvoicePayments] = useState<InvoicePaymentSummary[] | null>(null);
  const [message, setMessage] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [recorded, setRecorded] = useState<RecordPaymentResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchFreshJson<InvoicePaymentSummary[]>(paymentSummariesPath)
      .then((loaded) => {
        if (cancelled) return;
        const unpaid = loaded.filter((summary) => summary.status !== "paid");
        setInvoicePayments(unpaid);
        const matched =
          props.customerName === undefined
            ? unpaid[0]
            : (unpaid.find(
                (summary) =>
                  summary.customerName?.toLowerCase() === props.customerName?.toLowerCase()
              ) ?? unpaid[0]);
        if (matched !== undefined) {
          setInvoiceId(matched.invoiceId);
          setAmount(String(matched.balanceDue));
        }
      })
      .catch((error) => {
        if (!cancelled) setMessage(getUserFacingErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [mutationRevision, paymentSummariesPath, props.customerName]);

  async function record() {
    if (invoiceId === "") {
      setMessage("Choose an invoice.");
      return;
    }
    const response = await postJson<RecordPaymentResponse>(
      `/businesses/${props.businessId}/payments`,
      {
        invoiceId,
        amount: Number(amount),
        method,
        reference: null,
        note: null
      }
    );
    setRecorded(response);
    setMessage(`Payment recorded, balance due ${response.invoicePayment.balanceDue}`);
  }

  if (invoicePayments === null) {
    return (
      <section className="record-form payment-management-card" aria-label="Payments">
        {message.length > 0 ? <p className="shell-note">{message}</p> : <p>Loading invoices…</p>}
      </section>
    );
  }

  return (
    <section className="record-form payment-management-card" aria-label="Record a payment">
      <div className="section-heading">
        <p className="eyebrow">Payments</p>
        <h3>Record a payment from chat</h3>
      </div>
      {message.length > 0 ? <p className="shell-note">{message}</p> : null}
      {recorded === null ? (
        <>
          {invoicePayments.length === 0 ? (
            <p className="shell-note">No invoices with a balance due.</p>
          ) : (
            <>
              <label>
                Invoice
                <select value={invoiceId} onChange={(event) => setInvoiceId(event.target.value)}>
                  {invoicePayments.map((summary) => (
                    <option key={summary.invoiceId} value={summary.invoiceId}>
                      {summary.invoiceNumber} · {summary.customerName ?? "No customer"} · balance{" "}
                      {summary.balanceDue}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Amount
                <input
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
              </label>
              <label>
                Method
                <select
                  value={method}
                  onChange={(event) => setMethod(event.target.value as PaymentMethod)}
                >
                  {paymentMethods.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <div className="row-actions">
                <button
                  type="button"
                  disabled={isPending("payment-management-record")}
                  onClick={() =>
                    void runAction("payment-management-record", async () => {
                      try {
                        await record();
                      } catch (error) {
                        setMessage(getUserFacingErrorMessage(error));
                      }
                    })
                  }
                >
                  Record payment
                </button>
              </div>
            </>
          )}
        </>
      ) : (
        <p>
          <strong>Payment recorded</strong>
          <br />
          Balance due: {recorded.invoicePayment.balanceDue}
        </p>
      )}
    </section>
  );
}
