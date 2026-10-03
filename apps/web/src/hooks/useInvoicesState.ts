import { useState } from "react";
import { reportBackgroundLoadError } from "../background-load-error";

import type { SyncMutationPayload, SyncMutationType } from "@grogoni/shared-types";

import { getErrorMessage } from "../chat-message-plumbing";
import { getJson, patchJson, postJson } from "../api-helpers";
import {
  emptyInvoiceForm,
  type ConfirmInvoiceResponse,
  type InvoiceFormState,
  type InvoicePreview,
  type InvoiceSummary
} from "../grogoni-application-shared";

interface UseInvoicesStateDeps {
  businessId: string | null;
  setStatusMessage: (message: string) => void;
  loadProducts: (businessId: string) => Promise<void>;
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

export function useInvoicesState(deps: UseInvoicesStateDeps) {
  const [invoices, setInvoices] = useState<InvoiceSummary[]>([]);
  const [invoiceForm, setInvoiceForm] = useState<InvoiceFormState>(emptyInvoiceForm);
  const [invoicePreview, setInvoicePreview] = useState<InvoicePreview | null>(null);

  function createInvoicePayload() {
    return {
      customerId: invoiceForm.customerId || null,
      customerName: invoiceForm.customerName,
      taxRate: Number(invoiceForm.taxRate),
      items: [
        {
          productId: invoiceForm.productId,
          quantity: Number(invoiceForm.quantity),
          unitPrice: Number(invoiceForm.unitPrice)
        }
      ]
    };
  }

  async function loadInvoices(businessId: string) {
    try {
      setInvoices(
        await getJson<InvoiceSummary[]>(`/businesses/${businessId}/invoices`, setInvoices)
      );
    } catch (error) {
      reportBackgroundLoadError(deps.setStatusMessage, error);
    }
  }

  async function previewInvoice() {
    if (deps.businessId === null) {
      return;
    }

    try {
      const preview = await postJson<InvoicePreview>(
        `/businesses/${deps.businessId}/invoices/preview`,
        createInvoicePayload()
      );
      setInvoicePreview(preview);
      deps.setStatusMessage("Invoice preview ready");
    } catch (error) {
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  async function saveInvoice() {
    if (deps.businessId === null) {
      return;
    }

    try {
      const payload = createInvoicePayload();
      const invoice =
        invoiceForm.id === null
          ? await postJson<InvoiceSummary>(`/businesses/${deps.businessId}/invoices`, payload)
          : await patchJson<InvoiceSummary>(
              `/businesses/${deps.businessId}/invoices/${invoiceForm.id}`,
              payload
            );

      setInvoiceForm({
        ...invoiceForm,
        id: invoice.id
      });
      setInvoicePreview(invoice);
      await loadInvoices(deps.businessId);
      deps.setStatusMessage(
        invoiceForm.id === null ? "Invoice draft saved" : "Invoice draft updated"
      );
    } catch (error) {
      if (
        invoiceForm.id === null &&
        (await deps.queueMutationAfterNetworkFailure(
          error,
          "invoice.create",
          createInvoicePayload()
        ))
      ) {
        setInvoiceForm(emptyInvoiceForm);
        return;
      }
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  async function confirmInvoice(invoiceId: string) {
    if (deps.businessId === null) {
      return;
    }

    try {
      const response = await postJson<ConfirmInvoiceResponse>(
        `/businesses/${deps.businessId}/invoices/${invoiceId}/confirm`,
        {}
      );
      setInvoicePreview(response.invoice);
      setInvoiceForm(emptyInvoiceForm);
      await loadInvoices(deps.businessId);
      await deps.loadProducts(deps.businessId);
      deps.setStatusMessage("Invoice confirmed and stock moved");
    } catch (error) {
      if (
        await deps.queueMutationAfterNetworkFailure(error, "invoice.confirm", {
          invoiceId
        })
      ) {
        return;
      }
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  function printInvoice(invoice: InvoiceSummary | InvoicePreview) {
    setInvoicePreview(invoice);
    window.setTimeout(() => window.print(), 0);
  }

  deps.registerReset("invoices", () => {
    setInvoices([]);
    setInvoiceForm(emptyInvoiceForm);
    setInvoicePreview(null);
  });
  deps.registerRefresh("invoices", ["pos", "invoices", "payments", "logistics"], loadInvoices);

  return {
    invoices,
    invoiceForm,
    setInvoiceForm,
    invoicePreview,
    setInvoicePreview,
    loadInvoices,
    previewInvoice,
    saveInvoice,
    confirmInvoice,
    printInvoice
  };
}
