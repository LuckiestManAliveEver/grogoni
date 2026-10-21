import type {
  BuyCheckoutItemInput,
  BuyResultSourceKind,
  RuntimePlannedAction
} from "@grogoni/shared-types";

import type { AgentRuntimeDomainDeps } from "./store.js";

export function executeCommerceCapability(
  deps: AgentRuntimeDomainDeps,
  input: {
    sessionId: string | null;
    action: RuntimePlannedAction;
    now: Date;
  }
): unknown {
  if (input.action.toolName === "commerce.search") {
    return deps.searchBuyFeed({
      sessionId: input.sessionId,
      query: typeof input.action.input.query === "string" ? input.action.input.query : "",
      now: input.now
    });
  }
  return deps.createUnifiedCheckout({
    sessionId: input.sessionId,
    items: checkoutItems(input.action.input.items),
    ...(typeof input.action.input.sellerConversationId === "string"
      ? { sellerConversationId: input.action.input.sellerConversationId }
      : {}),
    // Durable idempotency key (docs/architecture/durable-execution-plane.md "Idempotency"), same
    // pattern messaging.send already uses (capabilities.ts's `runtime-message:${action.id}`): a
    // confirmed action's id is stable across a retried/resumed turn, so a duplicate
    // commerce.checkout call for the same confirmed action reuses the original order instead of
    // creating a second one.
    idempotencyKey: `runtime-checkout:${input.action.id}`,
    now: input.now
  });
}

function checkoutItems(value: unknown): BuyCheckoutItemInput[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    return [
      {
        ...(typeof record.websiteUrl === "string" ? { websiteUrl: record.websiteUrl } : {}),
        sourceKind: String(record.sourceKind) as BuyResultSourceKind,
        sourceId: String(record.sourceId ?? ""),
        sourceLabel: String(record.sourceLabel ?? ""),
        title: String(record.title ?? ""),
        quantity: Number(record.quantity),
        agentId: typeof record.agentId === "string" ? record.agentId : null,
        productId: typeof record.productId === "string" ? record.productId : null,
        statusBroadcastId:
          typeof record.statusBroadcastId === "string" ? record.statusBroadcastId : null,
        productCaptureItemId:
          typeof record.productCaptureItemId === "string" ? record.productCaptureItemId : null
      }
    ];
  });
}
