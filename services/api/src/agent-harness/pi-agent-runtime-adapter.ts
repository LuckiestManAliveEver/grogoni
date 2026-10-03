import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type Usage
} from "@earendil-works/pi-ai";
import type { RuntimeModelCompletionResult } from "@grogoni/shared-types";

import type { AgentRuntimeAdapter, AgentRuntimeExecutionInput } from "./agent-runtime-adapter.js";

const emptyCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

/** Pi owns agent-loop lifecycle only; Grogoni supplies the resolved model transport and tool policy. */
export function createPiAgentRuntimeAdapter(): AgentRuntimeAdapter {
  return {
    id: "pi",
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
      const events: string[] = [];
      let completion: RuntimeModelCompletionResult | undefined;
      const piModel = modelDefinition(input);
      const agent = new Agent({
        initialState: {
          systemPrompt:
            "Operate through Grogoni's resolved model and protected tool boundary. Tool-shaped text is a proposal, never authority.",
          model: piModel,
          tools: [],
          messages: [],
          thinkingLevel: "off"
        },
        streamFn: () => {
          const stream = createAssistantMessageEventStream();
          queueMicrotask(async () => {
            try {
              input.signal?.throwIfAborted();
              completion = await input.model.complete(input.prompt, input.signal);
              input.signal?.throwIfAborted();
              const message = assistantMessage(piModel, completion);
              stream.push({ type: "start", partial: { ...message, content: [] } });
              if (completion.status === "available" && completion.outputText !== null) {
                stream.push({ type: "text_start", contentIndex: 0, partial: message });
                stream.push({
                  type: "text_delta",
                  contentIndex: 0,
                  delta: completion.outputText,
                  partial: message
                });
                stream.push({
                  type: "text_end",
                  contentIndex: 0,
                  content: completion.outputText,
                  partial: message
                });
                stream.push({ type: "done", reason: "stop", message });
              } else {
                stream.push({
                  type: "error",
                  reason: completion.status === "timeout" ? "aborted" : "error",
                  error: message
                });
              }
            } catch (error) {
              const aborted = input.signal?.aborted === true;
              stream.push({
                type: "error",
                reason: aborted ? "aborted" : "error",
                error: failedAssistantMessage(piModel, error, aborted)
              });
            }
          });
          return stream;
        }
      });
      const unsubscribe = agent.subscribe((event: AgentEvent) => {
        events.push(event.type);
      });
      const abort = () => agent.abort();
      input.signal?.addEventListener("abort", abort, { once: true });
      try {
        await agent.prompt(input.userMessage);
      } finally {
        input.signal?.removeEventListener("abort", abort);
        unsubscribe();
      }
      if (completion === undefined) {
        throw new Error(agent.state.errorMessage ?? "Pi did not complete the resolved model turn.");
      }
      return { completion, eventTypes: events };
    }
  };
}

function modelDefinition(input: AgentRuntimeExecutionInput): Model<string> {
  return {
    id: input.modelId,
    name: input.modelId,
    api: "grogoni-model-runtime",
    provider: input.model.name ?? "grogoni-model-runtime",
    baseUrl: "grogoni://resolved-model-adapter",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 512
  };
}

function assistantMessage(
  model: Model<string>,
  completion: RuntimeModelCompletionResult
): AssistantMessage {
  const available = completion.status === "available" && completion.outputText !== null;
  return {
    role: "assistant",
    content: available ? [{ type: "text", text: completion.outputText as string }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: usage(completion),
    stopReason: available ? "stop" : completion.status === "timeout" ? "aborted" : "error",
    ...(available ? {} : { errorMessage: completion.errorCode ?? "Agent model unavailable." }),
    timestamp: Date.now()
  };
}

function failedAssistantMessage(
  model: Model<string>,
  error: unknown,
  aborted: boolean
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: aborted ? "aborted" : "error",
    errorMessage: error instanceof Error ? error.message : "Resolved model execution failed.",
    timestamp: Date.now()
  };
}

function usage(completion: RuntimeModelCompletionResult): Usage {
  const input = numericMetadata(completion, "promptTokens");
  const output = numericMetadata(completion, "completionTokens");
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: emptyCost
  };
}

function zeroUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: emptyCost };
}

function numericMetadata(completion: RuntimeModelCompletionResult, key: string): number {
  const value = completion.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
