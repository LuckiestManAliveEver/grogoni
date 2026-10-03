import type { ActiveNativeAgentBinding, AgentModelBindingSummary } from "@grogoni/shared-types";

/**
 * The sole place `AgentModelBindingSummary` (the wire shape `AgentModelPanel.tsx`/
 * `QuickRuntimeSwitcher.tsx` already depend on) is ever constructed - as a read-through projection
 * of the native runtime graph, not a second persisted representation. Native bindings carry no
 * `executionMode`/`permissions` concept (those were on-device-execution-era fields the frontend
 * sends but never reads back, see AgentModelPanel.tsx/QuickRuntimeSwitcher.tsx `executionMode:
 * "LOCAL_FIRST"`); this projection fills them with the values that are actually true of the current
 * architecture ("always backend/remote-shop-device hosted") rather than round-tripping retired
 * on-device vocabulary.
 */
export function projectNativeBinding(
  active: ActiveNativeAgentBinding,
  businessId: string,
  accountId: string
): AgentModelBindingSummary {
  const { binding, model, executionTarget } = active;
  return {
    id: binding.id,
    agentId: binding.agentId,
    shopId: binding.businessId ?? businessId,
    accountId: binding.accountId ?? accountId,
    modelId: model.id,
    status: binding.status === "active" ? "active" : "inactive",
    executionMode: "CLOUD_ONLY",
    executionTarget,
    permissions: { allowRemoteShopDevice: executionTarget === "remote-shop-device" },
    activatedAt: binding.updatedAt,
    lastVerifiedAt: binding.updatedAt,
    lastVerificationStatus: "passed",
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
    updatedBy: binding.updatedBy
  };
}

export function projectActiveNativeBinding(
  active: ActiveNativeAgentBinding | null,
  businessId: string,
  accountId: string
): AgentModelBindingSummary | null {
  return active === null ? null : projectNativeBinding(active, businessId, accountId);
}
