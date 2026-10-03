import { useState } from "react";
import { reportBackgroundLoadError } from "../background-load-error";

import type { SyncMutationPayload, SyncMutationType } from "@grogoni/shared-types";

import { getErrorMessage } from "../chat-message-plumbing";
import { getJson, patchJson, postJson } from "../api-helpers";
import {
  emptyLogisticsForm,
  type FulfillmentStatus,
  type InvoiceSummary,
  type LogisticsFormState,
  type LogisticsSummary
} from "../grogoni-application-shared";

interface UseLogisticsStateDeps {
  businessId: string | null;
  // A getter, not a direct value: Logistics is called early among the domain hooks (Sync needs it
  // for queueMutationAfterNetworkFailure's transitive consumers), before Invoices exists as a
  // const. A getter's body isn't evaluated until actually called (at real refresh time, after every
  // hook in OwnerApp has run), so it sidesteps the ordering constraint a direct value dependency
  // would hit.
  getInvoices: () => InvoiceSummary[];
  setStatusMessage: (message: string) => void;
  loadReports: (businessId: string) => Promise<void>;
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

export function useLogisticsState(deps: UseLogisticsStateDeps) {
  const [logistics, setLogistics] = useState<LogisticsSummary[]>([]);
  const [logisticsForm, setLogisticsForm] = useState<LogisticsFormState>(emptyLogisticsForm);

  async function loadLogistics(businessId: string) {
    try {
      const nextLogistics = await getJson<LogisticsSummary[]>(
        `/businesses/${businessId}/logistics`,
        setLogistics
      );
      setLogistics(nextLogistics);
      if (logisticsForm.invoiceId.length === 0) {
        const existingInvoiceIds = new Set(nextLogistics.map((item) => item.invoiceId));
        const invoice = deps
          .getInvoices()
          .find((item) => item.status === "confirmed" && !existingInvoiceIds.has(item.id));
        if (invoice !== undefined) {
          setLogisticsForm((form) => ({ ...form, invoiceId: invoice.id }));
        }
      }
    } catch (error) {
      reportBackgroundLoadError(deps.setStatusMessage, error);
    }
  }

  async function createLogistics() {
    if (deps.businessId === null || logisticsForm.invoiceId.length === 0) {
      return;
    }

    try {
      await postJson<LogisticsSummary>(`/businesses/${deps.businessId}/logistics`, {
        invoiceId: logisticsForm.invoiceId,
        method: logisticsForm.method,
        destination: logisticsForm.destination,
        note: logisticsForm.note
      });
      setLogisticsForm(emptyLogisticsForm);
      await loadLogistics(deps.businessId);
      await deps.loadReports(deps.businessId);
      deps.setStatusMessage("Logistics record created");
    } catch (error) {
      if (
        await deps.queueMutationAfterNetworkFailure(error, "logistics.create", {
          invoiceId: logisticsForm.invoiceId,
          method: logisticsForm.method,
          destination: logisticsForm.destination,
          note: logisticsForm.note
        })
      ) {
        setLogisticsForm(emptyLogisticsForm);
        return;
      }
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  async function updateLogisticsStatus(logisticsId: string, status: FulfillmentStatus) {
    if (deps.businessId === null) {
      return;
    }

    try {
      await patchJson<LogisticsSummary>(`/businesses/${deps.businessId}/logistics/${logisticsId}`, {
        status,
        note: ""
      });
      await loadLogistics(deps.businessId);
      await deps.loadReports(deps.businessId);
      deps.setStatusMessage("Logistics status updated");
    } catch (error) {
      if (
        await deps.queueMutationAfterNetworkFailure(error, "logistics.update_status", {
          logisticsId,
          status,
          note: ""
        })
      ) {
        return;
      }
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  deps.registerReset("logistics", () => {
    setLogistics([]);
    setLogisticsForm(emptyLogisticsForm);
  });
  deps.registerRefresh("logistics", ["logistics"], loadLogistics);

  return {
    logistics,
    logisticsForm,
    setLogisticsForm,
    loadLogistics,
    createLogistics,
    updateLogisticsStatus
  };
}
