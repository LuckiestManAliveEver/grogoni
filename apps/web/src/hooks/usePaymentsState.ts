import { useState } from "react";
import { reportBackgroundLoadError } from "../background-load-error";

import type { SyncMutationPayload, SyncMutationType } from "@grogoni/shared-types";

import { getErrorMessage } from "../chat-message-plumbing";
import { getJson, postJson } from "../api-helpers";
import {
  emptyPaymentForm,
  type CustomerDebtSummary,
  type InvoicePaymentSummary,
  type PaymentFormState,
  type PaymentSummary,
  type RecordPaymentResponse
} from "../grogoni-application-shared";

interface UsePaymentsStateDeps {
  businessId: string | null;
  setStatusMessage: (message: string) => void;
  queueMutationAfterNetworkFailure: (
    error: unknown,
    mutationType: SyncMutationType,
    payload: SyncMutationPayload
  ) => Promise<boolean>;
  registerReset: (domainKey: string, fn: () => void) => void;
  registerRefresh: (
    domainKey: string,
    views: readonly string[],
    fn: (businessId: string) => Promise<void>
  ) => void;
}

export function usePaymentsState(deps: UsePaymentsStateDeps) {
  const [payments, setPayments] = useState<PaymentSummary[]>([]);
  const [invoicePayments, setInvoicePayments] = useState<InvoicePaymentSummary[]>([]);
  const [customerDebts, setCustomerDebts] = useState<CustomerDebtSummary[]>([]);
  const [paymentForm, setPaymentForm] = useState<PaymentFormState>(emptyPaymentForm);

  async function loadPaymentData(businessId: string) {
    try {
      const [nextPayments, nextSummaries, nextDebts] = await Promise.all([
        getJson<PaymentSummary[]>(`/businesses/${businessId}/payments`, setPayments),
        getJson<InvoicePaymentSummary[]>(
          `/businesses/${businessId}/payment-summaries`,
          setInvoicePayments
        ),
        getJson<CustomerDebtSummary[]>(`/businesses/${businessId}/customer-debts`, setCustomerDebts)
      ]);
      setPayments(nextPayments);
      setInvoicePayments(nextSummaries);
      setCustomerDebts(nextDebts);
    } catch (error) {
      reportBackgroundLoadError(deps.setStatusMessage, error);
    }
  }

  async function recordPayment() {
    if (deps.businessId === null || paymentForm.invoiceId.length === 0) {
      return;
    }

    try {
      const response = await postJson<RecordPaymentResponse>(
        `/businesses/${deps.businessId}/payments`,
        {
          invoiceId: paymentForm.invoiceId,
          amount: Number(paymentForm.amount),
          method: paymentForm.method,
          reference: paymentForm.reference,
          note: paymentForm.note
        }
      );
      setPaymentForm({
        ...emptyPaymentForm,
        invoiceId:
          response.invoicePayment.status === "paid" ? "" : response.invoicePayment.invoiceId,
        amount:
          response.invoicePayment.status === "paid"
            ? ""
            : String(response.invoicePayment.balanceDue)
      });
      await loadPaymentData(deps.businessId);
      deps.setStatusMessage("Payment recorded");
    } catch (error) {
      if (
        await deps.queueMutationAfterNetworkFailure(error, "payment.record", {
          invoiceId: paymentForm.invoiceId,
          amount: Number(paymentForm.amount),
          method: paymentForm.method,
          reference: paymentForm.reference,
          note: paymentForm.note
        })
      ) {
        setPaymentForm(emptyPaymentForm);
        return;
      }
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  deps.registerReset("payments", () => {
    setPayments([]);
    setInvoicePayments([]);
    setCustomerDebts([]);
    setPaymentForm(emptyPaymentForm);
  });
  deps.registerRefresh("payments", ["pos", "payments"], loadPaymentData);

  return {
    payments,
    invoicePayments,
    customerDebts,
    paymentForm,
    setPaymentForm,
    loadPaymentData,
    recordPayment
  };
}
