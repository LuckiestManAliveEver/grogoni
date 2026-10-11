import type { AgentRuntimeAdapter } from "./agent-runtime-adapter.js";

/** Largest serialized prompt the engine accepts by default; larger ones fail CONTEXT_TOO_LARGE. */
export const defaultGrogoniMaxPromptBytes = 131_072;

/** Request-scoped orchestration; only the outer authorized pipeline can execute business tools. */
export function createGrogoniAgentRuntimeAdapter(
  policy: {
    timeoutMs?: number;
    maxPromptBytes?: number;
    maxOutputBytes?: number;
  } = {}
): AgentRuntimeAdapter {
  const limits = {
    timeoutMs: policy.timeoutMs ?? 120_000,
    maxPromptBytes: policy.maxPromptBytes ?? defaultGrogoniMaxPromptBytes,
    maxOutputBytes: policy.maxOutputBytes ?? 262_144
  };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid agent runtime limit.");
  }
  return {
    id: "grogoni",
    async canRun(input) {
      return input.agent.status === "active"
        ? { available: true, errorCode: null, message: null }
        : {
            available: false,
            errorCode: "AGENT_RUNTIME_UNAVAILABLE",
            message: "The selected agent is not active."
          };
    },
    async execute(input) {
      input.signal?.throwIfAborted();
      const started = Date.now();
      const failure = (errorCode: string, timeout = false) => ({
        completion: {
          provider: input.model.name,
          status: timeout ? ("timeout" as const) : ("error" as const),
          outputText: null,
          durationMs: Date.now() - started,
          errorCode,
          metadata: { agentAdapterId: "grogoni", modelCalls: 0 }
        },
        eventTypes: ["agent_start", "turn_start", "turn_error", "agent_end"]
      });
      if (!(await this.canRun(input)).available) return failure("AGENT_RUNTIME_UNAVAILABLE");
      // Keep model-side prompt mutations separate from caller-owned history and tool policy.
      const prompt = structuredClone(input.prompt);
      const allowed = new Set(input.allowedTools);
      prompt.allowedTools = prompt.allowedTools.filter((tool) => allowed.has(tool));
      if (new TextEncoder().encode(JSON.stringify(prompt)).byteLength > limits.maxPromptBytes) {
        return failure("CONTEXT_TOO_LARGE");
      }
      input.signal?.throwIfAborted();
      const controller = new AbortController();
      const cancel = () => controller.abort(input.signal?.reason);
      input.signal?.addEventListener("abort", cancel, { once: true });
      if (input.signal?.aborted) cancel();
      let onAbort: () => void = () => {};
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
      const timer = setTimeout(
        () => controller.abort(new DOMException("Agent turn timed out.", "TimeoutError")),
        limits.timeoutMs
      );
      try {
        const completion = await Promise.race([
          Promise.resolve().then(() => {
            controller.signal.throwIfAborted();
            return input.model.complete(prompt, controller.signal);
          }),
          aborted
        ]);
        controller.signal.throwIfAborted();
        if (
          completion.outputText !== null &&
          new TextEncoder().encode(completion.outputText).byteLength > limits.maxOutputBytes
        ) {
          const result = failure("OUTPUT_TOO_LARGE");
          result.completion.metadata.modelCalls = 1;
          return result;
        }
        return {
          completion: {
            ...completion,
            metadata: { ...completion.metadata, agentAdapterId: "grogoni", modelCalls: 1 }
          },
          eventTypes: [
            "agent_start",
            "turn_start",
            completion.status === "available" ? "turn_end" : "turn_error",
            "agent_end"
          ]
        };
      } catch (error) {
        input.signal?.throwIfAborted();
        if (controller.signal.aborted) {
          const result = failure("AGENT_RUNTIME_TIMEOUT", true);
          result.completion.metadata.modelCalls = 1;
          return result;
        }
        throw error;
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", cancel);
        controller.signal.removeEventListener("abort", onAbort);
      }
    }
  };
}
