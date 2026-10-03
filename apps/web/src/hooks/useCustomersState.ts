import { useState } from "react";
import { reportBackgroundLoadError } from "../background-load-error";

import type { SyncMutationPayload, SyncMutationType } from "@grogoni/shared-types";

import { getErrorMessage } from "../chat-message-plumbing";
import { getJson, patchJson, postJson } from "../api-helpers";
import {
  emptyCustomerForm,
  type CustomerFormState,
  type CustomerSummary
} from "../grogoni-application-shared";

interface UseCustomersStateDeps {
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

export function useCustomersState(deps: UseCustomersStateDeps) {
  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [customerForm, setCustomerForm] = useState<CustomerFormState>(emptyCustomerForm);

  async function loadCustomers(businessId: string) {
    try {
      setCustomers(
        await getJson<CustomerSummary[]>(`/businesses/${businessId}/customers`, setCustomers)
      );
    } catch (error) {
      reportBackgroundLoadError(deps.setStatusMessage, error);
    }
  }

  async function saveCustomer() {
    if (deps.businessId === null) {
      return;
    }

    try {
      const payload = {
        name: customerForm.name,
        phone: customerForm.phone,
        email: customerForm.email,
        notes: customerForm.notes
      };

      if (customerForm.id === null) {
        await postJson<CustomerSummary>(`/businesses/${deps.businessId}/customers`, payload);
      } else {
        await patchJson<CustomerSummary>(
          `/businesses/${deps.businessId}/customers/${customerForm.id}`,
          payload
        );
      }

      setCustomerForm(emptyCustomerForm);
      await loadCustomers(deps.businessId);
      deps.setStatusMessage(customerForm.id === null ? "Customer created" : "Customer updated");
    } catch (error) {
      if (
        customerForm.id === null &&
        (await deps.queueMutationAfterNetworkFailure(error, "customer.create", {
          name: customerForm.name,
          phone: customerForm.phone,
          email: customerForm.email,
          notes: customerForm.notes
        }))
      ) {
        setCustomerForm(emptyCustomerForm);
        return;
      }
      deps.setStatusMessage(getErrorMessage(error));
    }
  }

  deps.registerReset("customers", () => {
    setCustomers([]);
    setCustomerForm(emptyCustomerForm);
  });
  deps.registerRefresh("customers", ["customers", "pos"], loadCustomers);

  return { customers, customerForm, setCustomerForm, loadCustomers, saveCustomer };
}
