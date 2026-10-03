import { AgentRuntimeAdapterRegistry } from "./agent-runtime-adapter.js";
import { createPiAgentRuntimeAdapter } from "./pi-agent-runtime-adapter.js";
import { createGrogoniAgentRuntimeAdapter } from "./grogoni-agent-runtime-adapter.js";
import {
  createZeroClawAgentRuntimeAdapter,
  type ZeroClawAgentRuntimeOptions
} from "./zeroclaw-agent-runtime-adapter.js";

/**
 * Every engine is always registered, so agent definitions can name any of them; an engine that is
 * not connected on this deployment (ZeroClaw without ZEROCLAW_GATEWAY_URL) reports itself
 * unavailable from canRun rather than disappearing.
 */
export function createDefaultAgentRuntimeAdapterRegistry(
  options: { zeroclaw?: ZeroClawAgentRuntimeOptions } = {}
): AgentRuntimeAdapterRegistry {
  return new AgentRuntimeAdapterRegistry()
    .register(createZeroClawAgentRuntimeAdapter(options.zeroclaw ?? { gateway: null }))
    .register(createGrogoniAgentRuntimeAdapter())
    .register(createPiAgentRuntimeAdapter());
}
