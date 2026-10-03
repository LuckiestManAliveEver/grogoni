import type {
  NativeRuntimeAgentSummary,
  RuntimeModelCompletionResult,
  RuntimeModelPrompt,
  RuntimeModelProvider
} from "@grogoni/shared-types";

export interface AgentRuntimeAvailabilityInput {
  agent: NativeRuntimeAgentSummary;
  modelId: string;
  conversationId: string;
  shopId: string;
}

export interface AgentRuntimeAvailability {
  available: boolean;
  errorCode: string | null;
  message: string | null;
}

/**
 * Fully resolved state for one agent invocation. Adapters receive neither database access nor
 * business mutation callbacks. `model` is the already-selected model execution capability.
 */
export interface AgentRuntimeExecutionInput extends AgentRuntimeAvailabilityInput {
  bindingId: string;
  executionHostId: string | null;
  userMessage: string;
  prompt: RuntimeModelPrompt;
  model: RuntimeModelProvider;
  allowedTools: readonly string[];
  signal?: AbortSignal;
}

export interface AgentRuntimeExecutionResult {
  completion: RuntimeModelCompletionResult;
  eventTypes: string[];
}

export interface AgentRuntimeAdapter {
  readonly id: string;
  canRun(input: AgentRuntimeAvailabilityInput): Promise<AgentRuntimeAvailability>;
  execute(input: AgentRuntimeExecutionInput): Promise<AgentRuntimeExecutionResult>;
}

export class AgentRuntimeAdapterRegistry {
  private readonly adapters = new Map<string, AgentRuntimeAdapter>();

  register(adapter: AgentRuntimeAdapter): this {
    const id = normalizeAdapterId(adapter.id);
    if (this.adapters.has(id)) {
      throw new Error(`Agent runtime adapter ${id} is already registered.`);
    }
    this.adapters.set(id, adapter);
    return this;
  }

  resolve(id: string): AgentRuntimeAdapter | undefined {
    return this.adapters.get(normalizeAdapterId(id));
  }

  list(): AgentRuntimeAdapter[] {
    return [...this.adapters.values()];
  }
}

/** Old native records predate adapter metadata and execute through the original Grogoni harness. */
export const legacyAgentRuntimeAdapterId = "grogoni";

export function runtimeAdapterIdForAgent(agent: NativeRuntimeAgentSummary): string {
  const configured = agent.configuration.runtimeAdapterId;
  return typeof configured === "string" && configured.trim() !== ""
    ? normalizeAdapterId(configured)
    : legacyAgentRuntimeAdapterId;
}

export function normalizeAdapterId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(id)) {
    throw new Error("Agent runtime adapter IDs must be lowercase portable identifiers.");
  }
  return id;
}
