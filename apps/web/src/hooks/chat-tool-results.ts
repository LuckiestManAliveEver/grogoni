import type { RuntimeToolName } from "@grogoni/tool-core";

export const productMutationToolNames: ReadonlySet<string> = new Set<RuntimeToolName>([
  "product.create",
  "product.update",
  "product.stock_adjust"
]);

export const supplierMutationToolNames: ReadonlySet<string> = new Set<RuntimeToolName>([
  "supplier.create",
  "supplier.update"
]);

export const customerMutationToolNames: ReadonlySet<string> = new Set<RuntimeToolName>([
  "customer.create",
  "customer.update"
]);

function ownId(toolResult: unknown): string | undefined {
  if (toolResult === null || typeof toolResult !== "object") return undefined;
  if ("id" in toolResult && typeof toolResult.id === "string") return toolResult.id;
  return undefined;
}

export function productIdFromToolResult(toolResult: unknown): string | undefined {
  const id = ownId(toolResult);
  if (id !== undefined) return id;
  if (
    toolResult !== null &&
    typeof toolResult === "object" &&
    "product" in toolResult &&
    typeof toolResult.product === "object" &&
    toolResult.product !== null &&
    "id" in toolResult.product &&
    typeof toolResult.product.id === "string"
  ) {
    return toolResult.product.id;
  }
  return undefined;
}

export const supplierIdFromToolResult = ownId;
export const customerIdFromToolResult = ownId;
