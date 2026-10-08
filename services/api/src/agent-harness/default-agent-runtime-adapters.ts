import { AgentRuntimeAdapterRegistry } from "./agent-runtime-adapter.js";
import { createPiAgentRuntimeAdapter } from "./pi-agent-runtime-adapter.js";
import { createGrogoniAgentRuntimeAdapter } from "./grogoni-agent-runtime-adapter.js";

/**
 * Every engine this deployment runs. The hosted ZeroClaw engine was removed with the local-first
 * runtime (docs/local-first-cloud-audit.md); stored agent definitions that still name it resolve to
 * Grogoni's built-in engine (connectedAgentRuntimeAdapterId in cp2/store.ts).
 */
export function createDefaultAgentRuntimeAdapterRegistry(): AgentRuntimeAdapterRegistry {
  return new AgentRuntimeAdapterRegistry()
    .register(createGrogoniAgentRuntimeAdapter())
    .register(createPiAgentRuntimeAdapter());
}
