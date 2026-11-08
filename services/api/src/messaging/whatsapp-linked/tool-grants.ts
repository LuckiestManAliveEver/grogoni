import { runtimeToolRegistry } from "@grogoni/tool-core";
import type { RuntimeToolName } from "@grogoni/shared-types";
import { Cp2Error } from "../../cp2/cp2-error.js";

// Owner-selected commerce capabilities only. Messaging, computers, account administration and
// arbitrary code execution cannot be delegated through this channel.
const commerceTools = [
  "products.list",
  "product.create",
  "product.update",
  "product.stock_adjust",
  "invoice.draft",
  "invoices.list",
  "logistics.update_status",
  "procurement.quote.record",
  "procurement.prepare",
  "procurement.submit",
  "procurement.respond",
  "sale.record",
  "sales.history",
  "purchase.record",
  "purchase.history"
] as const;
export const linkedToolChoices = commerceTools.filter((name) =>
  Object.hasOwn(runtimeToolRegistry, name)
);
export function parseLinkedToolGrants(value: unknown): RuntimeToolName[] {
  if (
    !Array.isArray(value) ||
    value.length > linkedToolChoices.length ||
    value.some(
      (name) =>
        typeof name !== "string" ||
        !linkedToolChoices.includes(name as (typeof linkedToolChoices)[number])
    )
  )
    throw new Cp2Error(
      400,
      "whatsapp_tool_grants_invalid",
      "Choose supported business capabilities explicitly."
    );
  return [...new Set(value)] as RuntimeToolName[];
}

/** A reference to persisted authority, never a bearer credential or a client-provided tool list. */
export interface LinkedToolDelegation {
  channelId: string;
  grantId: string;
  ownerId: string;
  sourceMessageId: string;
  actorId: string;
}
