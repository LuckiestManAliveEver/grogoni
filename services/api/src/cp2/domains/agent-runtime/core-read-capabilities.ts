import type { RuntimePlannedAction } from "@grogoni/shared-types";

import type { AgentRuntimeDomainDeps } from "./store.js";

export function executeCoreReadCapability(
  deps: AgentRuntimeDomainDeps,
  input: {
    sessionId: string | null;
    businessId: string;
    action: RuntimePlannedAction;
    now: Date;
  }
): unknown {
  switch (input.action.toolName) {
    case "products.list":
      return typeof input.action.input.query === "string" && input.action.input.query.trim() !== ""
        ? deps.queryCatalogue({
            sessionId: input.sessionId,
            businessId: input.businessId,
            query: input.action.input.query,
            now: input.now
          })
        : deps.listProducts({
            sessionId: input.sessionId,
            businessId: input.businessId,
            now: input.now
          });
    case "invoices.list":
      return deps.listInvoices({
        sessionId: input.sessionId,
        businessId: input.businessId,
        now: input.now
      });
    case "reports.summary":
      return deps.getBusinessReport({
        sessionId: input.sessionId,
        businessId: input.businessId,
        now: input.now
      });
    case "payments.debtors":
      return deps.listCustomerDebts({
        sessionId: input.sessionId,
        businessId: input.businessId,
        now: input.now
      });
    case "notifications.list":
      return deps.listNotifications({
        sessionId: input.sessionId,
        businessId: input.businessId,
        now: input.now
      });
    case "compliance.review":
      return deps.getSecurityReview({
        sessionId: input.sessionId,
        businessId: input.businessId,
        now: input.now
      });
    default:
      return null;
  }
}
