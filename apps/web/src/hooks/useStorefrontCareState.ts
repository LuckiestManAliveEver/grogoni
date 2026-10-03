import { useState } from "react";
import { reportBackgroundLoadError } from "../background-load-error";

import type {
  PublicCustomerCareRequestSummary,
  PublicOrderSummary,
  PublicStorefrontMessageSummary
} from "@grogoni/shared-types";

import { getJson } from "../api-helpers";

interface UseStorefrontCareStateDeps {
  setStatusMessage: (message: string) => void;
  registerReset: (domainKey: string, fn: () => void) => void;
  registerRefresh: (
    domainKey: string,
    views: readonly string[],
    fn: (businessId: string) => Promise<void>
  ) => void;
}

export function useStorefrontCareState(deps: UseStorefrontCareStateDeps) {
  const [storefrontCareRequests, setStorefrontCareRequests] = useState<
    PublicCustomerCareRequestSummary[]
  >([]);
  const [storefrontMessages, setStorefrontMessages] = useState<PublicStorefrontMessageSummary[]>(
    []
  );
  const [storefrontOrders, setStorefrontOrders] = useState<PublicOrderSummary[]>([]);

  async function loadStorefrontInbox(businessId: string) {
    try {
      const [careRequests, messages, orders] = await Promise.all([
        getJson<PublicCustomerCareRequestSummary[]>(
          `/businesses/${businessId}/storefront/customer-care`
        ),
        getJson<PublicStorefrontMessageSummary[]>(`/businesses/${businessId}/storefront/messages`),
        getJson<PublicOrderSummary[]>(`/businesses/${businessId}/storefront/orders`)
      ]);
      setStorefrontCareRequests(careRequests);
      setStorefrontMessages(messages);
      setStorefrontOrders(orders);
    } catch (error) {
      reportBackgroundLoadError(deps.setStatusMessage, error);
    }
  }

  deps.registerReset("storefront-care", () => {
    setStorefrontCareRequests([]);
    setStorefrontMessages([]);
    setStorefrontOrders([]);
  });
  deps.registerRefresh("storefront-care", ["home", "notifications"], loadStorefrontInbox);

  return { storefrontCareRequests, storefrontMessages, storefrontOrders, loadStorefrontInbox };
}
