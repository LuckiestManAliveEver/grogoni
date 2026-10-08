/**
 * Agent engines that were removed but may still be named by stored agent definitions, native
 * runtime agents (via runtimeAdapterIdForAgent), or migrations (103_shopkeeper_zeroclaw_default.sql).
 * Each resolves to Grogoni's
 * built-in engine once, at configuration time - never per turn - and the effective runtime reports
 * the engine actually used, so the substitution is always visible.
 */
const retiredAgentRuntimeAdapterIds: ReadonlySet<string> = new Set(["zeroclaw"]);

export const retiredAgentRuntimeFallbackAdapterId = "grogoni";

export function connectedAgentRuntimeAdapterId(adapterId: string): string {
  return retiredAgentRuntimeAdapterIds.has(adapterId)
    ? retiredAgentRuntimeFallbackAdapterId
    : adapterId;
}
