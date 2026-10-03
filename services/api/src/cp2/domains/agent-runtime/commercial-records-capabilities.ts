import type { RuntimePlannedAction } from "@grogoni/shared-types";

import { optionalRuntimeString, runtimeInvoiceItems } from "./capability-inputs.js";
import type { AgentRuntimeDomainDeps } from "./store.js";

function runtimeLocation(value: unknown): {
  label: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  region: string | null;
  country: string | null;
} {
  const record =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    label: String(record.label ?? ""),
    address: optionalRuntimeString(record.address),
    latitude: typeof record.latitude === "number" ? record.latitude : null,
    longitude: typeof record.longitude === "number" ? record.longitude : null,
    region: optionalRuntimeString(record.region),
    country: optionalRuntimeString(record.country)
  };
}

export function executeCommercialRecordsCapability(
  deps: AgentRuntimeDomainDeps,
  input: {
    sessionId: string | null;
    businessId: string;
    action: RuntimePlannedAction;
    now: Date;
  }
): unknown {
  switch (input.action.toolName) {
    case "contacts.search":
      return deps.listContacts({
        sessionId: input.sessionId,
        businessId: input.businessId,
        query: typeof input.action.input.query === "string" ? input.action.input.query : "",
        now: input.now
      });
    case "supplier.contact.attach":
      return deps.attachSupplierContact({
        sessionId: input.sessionId,
        businessId: input.businessId,
        supplierId: String(input.action.input.supplierId ?? ""),
        contactId: String(input.action.input.contactId ?? ""),
        role: String(input.action.input.role ?? "OTHER") as
          "OWNER" | "SALES_AGENT" | "DELIVERY_AGENT" | "DRIVER" | "ACCOUNT_MANAGER" | "OTHER",
        isPrimary: input.action.input.isPrimary === true,
        now: input.now
      });
    case "purchase.record":
      return deps.createPurchase({
        sessionId: input.sessionId,
        businessId: input.businessId,
        supplierId: String(input.action.input.supplierId ?? ""),
        supplierContactId: optionalRuntimeString(input.action.input.supplierContactId),
        productId: String(input.action.input.productId ?? ""),
        quantity: Number(input.action.input.quantity),
        buyingPrice: Number(input.action.input.buyingPrice),
        currency: optionalRuntimeString(input.action.input.currency) ?? undefined,
        deliveredAt: optionalRuntimeString(input.action.input.deliveredAt),
        routeId: optionalRuntimeString(input.action.input.routeId),
        externalSourceId: optionalRuntimeString(input.action.input.externalSourceId),
        now: input.now
      });
    case "purchase.price.change":
      return deps.changePurchasePrice({
        sessionId: input.sessionId,
        businessId: input.businessId,
        productId: String(input.action.input.productId ?? ""),
        price: Number(input.action.input.price),
        currency: optionalRuntimeString(input.action.input.currency) ?? undefined,
        supplierId: optionalRuntimeString(input.action.input.supplierId),
        supplierContactId: optionalRuntimeString(input.action.input.supplierContactId),
        effectiveAt: optionalRuntimeString(input.action.input.effectiveAt) ?? undefined,
        now: input.now
      });
    case "purchase.history":
      return deps.listPurchaseHistory({
        sessionId: input.sessionId,
        businessId: input.businessId,
        productId: optionalRuntimeString(input.action.input.productId) ?? undefined,
        supplierId: optionalRuntimeString(input.action.input.supplierId) ?? undefined,
        now: input.now
      });
    case "sale.record":
      return deps.createSale({
        sessionId: input.sessionId,
        businessId: input.businessId,
        customerId: optionalRuntimeString(input.action.input.customerId),
        customerName: optionalRuntimeString(input.action.input.customerName),
        customerContactId: optionalRuntimeString(input.action.input.customerContactId),
        items: runtimeInvoiceItems(input.action.input.items),
        currency: optionalRuntimeString(input.action.input.currency) ?? undefined,
        routeId: optionalRuntimeString(input.action.input.routeId),
        externalSourceId: optionalRuntimeString(input.action.input.externalSourceId),
        now: input.now
      });
    case "sales.history":
      return deps.listSalesHistory({
        sessionId: input.sessionId,
        businessId: input.businessId,
        customerId: optionalRuntimeString(input.action.input.customerId) ?? undefined,
        customerContactId: optionalRuntimeString(input.action.input.customerContactId) ?? undefined,
        now: input.now
      });
    case "route.record": {
      const origin = runtimeLocation(input.action.input.origin);
      const destination = runtimeLocation(input.action.input.destination);
      return deps.createDeliveryRoute({
        sessionId: input.sessionId,
        businessId: input.businessId,
        origin,
        destination,
        provider: optionalRuntimeString(input.action.input.provider) ?? undefined,
        externalSourceId: optionalRuntimeString(input.action.input.externalSourceId),
        now: input.now
      });
    }
    case "route.history":
      return deps.listDeliveryRouteHistory({
        sessionId: input.sessionId,
        businessId: input.businessId,
        destinationLocationId:
          optionalRuntimeString(input.action.input.destinationLocationId) ?? undefined,
        now: input.now
      });
    default:
      return null;
  }
}
