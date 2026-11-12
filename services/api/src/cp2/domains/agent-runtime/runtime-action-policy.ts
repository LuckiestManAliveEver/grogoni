import type { RuntimeParserIntent, RuntimeToolName, ShopAgentRuntime } from "@grogoni/shared-types";
import { enforceAgentPolicy } from "../../agent-business-runtime.js";
import { findRuntimeUnknownEntityReferenceError } from "./capabilities.js";
import type { AgentRuntimeDomainDeps } from "./domain-deps.js";

/**
 * Entity-reference and skill-policy errors for one tool call. Proposal and confirmation both run
 * it, so a confirmed action is re-checked against the same rules it was approved under.
 */
export function runtimeActionPolicyErrors(
  deps: AgentRuntimeDomainDeps,
  input: {
    runtime: ShopAgentRuntime;
    businessId: string;
    toolName: RuntimeToolName;
    toolInput: Record<string, unknown>;
    intent: RuntimeParserIntent;
    sessionId: string | null;
  }
): string[] {
  const entityReferenceError = findRuntimeUnknownEntityReferenceError(
    deps,
    input.businessId,
    input.toolName,
    input.toolInput
  );
  return [
    ...(deps.assistantPermissionErrors?.(input.sessionId, input.toolName) ?? []),
    ...(entityReferenceError === null ? [] : [entityReferenceError]),
    ...enforceAgentPolicy({
      runtime: input.runtime,
      toolName: input.toolName,
      toolInput: input.toolInput,
      intent: input.intent
    })
  ];
}
