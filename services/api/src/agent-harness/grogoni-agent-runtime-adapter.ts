import type { AgentRuntimeAdapter } from "./agent-runtime-adapter.js";

/** Compatibility and rollback harness for native agent records created before adapter metadata. */
export function createGrogoniAgentRuntimeAdapter(): AgentRuntimeAdapter {
  return {
    id: "grogoni",
    async canRun() {
      return { available: true, errorCode: null, message: null };
    },
    async execute(input) {
      input.signal?.throwIfAborted();
      const completion = await input.model.complete(input.prompt, input.signal);
      input.signal?.throwIfAborted();
      return { completion, eventTypes: ["agent_start", "turn_start", "turn_end", "agent_end"] };
    }
  };
}
