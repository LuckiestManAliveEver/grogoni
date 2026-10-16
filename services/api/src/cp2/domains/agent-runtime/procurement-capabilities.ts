import type { RuntimePlannedAction } from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2-error.js";
import type { AgentRuntimeDomainDeps } from "./domain-deps.js";
import type { PurchaseOrderSubmission } from "./purchase-order-store.js";

/** Called only by the canonical post-policy capability dispatcher. */
export function executeProcurementCapability(
  deps: AgentRuntimeDomainDeps,
  input: {
    sessionId: string | null;
    businessId: string;
    action: RuntimePlannedAction;
    now: Date;
  }
) {
  if (!deps.inventoryProcurement)
    throw new Cp2Error(
      503,
      "procurement_storage_unavailable",
      "Durable procurement storage is unavailable."
    );
  const actor = { sessionId: input.sessionId, businessId: input.businessId };
  const values = input.action.input;
  if (input.action.toolName === "procurement.submit")
    return deps.inventoryProcurement.submit(
      actor,
      values as PurchaseOrderSubmission,
      input.action.id,
      input.now
    );
  if (input.action.toolName === "procurement.respond")
    return deps.inventoryProcurement.respond(
      actor,
      values as { orderId: string; revision: number; decision: "ACCEPTED" | "REJECTED" },
      input.now
    );
  if (input.action.toolName === "procurement.prepare")
    return deps.inventoryProcurement.prepare(
      actor,
      String(values.taskId),
      input.action.id,
      input.now
    );
  if (values.priceIncludesCharges !== true)
    throw new Cp2Error(
      400,
      "procurement_quote_charges_unknown",
      "Quote prices must explicitly include all charges."
    );
  return deps.inventoryProcurement.recordQuote(
    actor,
    {
      id: String(values.id),
      productId: String(values.productId),
      supplierId: String(values.supplierId),
      currency: String(values.currency),
      unit: String(values.unit),
      unitPriceMinor: Number(values.unitPriceMinor),
      priceIncludesCharges: true,
      minQuantityMilli: Number(values.minQuantityMilli),
      incrementMilli: Number(values.incrementMilli),
      availableQuantityMilli: Number(values.availableQuantityMilli),
      leadTimeDays: Number(values.leadTimeDays),
      expiresAt: String(values.expiresAt)
    },
    input.now
  );
}
