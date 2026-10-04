import { randomUUID } from "node:crypto";

import type {
  ModelExecutionTarget,
  RuntimeModelPrompt,
  RuntimeToolName
} from "@grogoni/shared-types";
import { runtimeToolRegistry } from "@grogoni/tool-core";

import {
  buildInferenceInstructions,
  normalizeModelText,
  ModelRuntimeError,
  type ModelRuntimeAdapter,
  type ModelRuntimeContext
} from "../model-runtime.js";
import type {
  InferenceMessage,
  InferenceRequest,
  ModelDefinition,
  ToolDefinition
} from "./contract.js";
import { InferenceError } from "./errors.js";
import type { InferenceRouter } from "./inference-router.js";
import { currentTurnId, turnStreamHub } from "../turn-stream.js";

/**
 * Exposes the inference router to the existing agent runtime as an ordinary ModelRuntimeAdapter,
 * registered under `backend:<modelId>` for server-reachable providers and under
 * `browser-local:<modelId>` / `installed-app:<modelId>` for device-local models. This is the only integration point: agents, the turn
 * pipeline, runtime handoff, tool execution and approvals are unchanged, and none of them learn
 * which provider served a turn.
 *
 * Tool calls: when the model is verified tool-capable, Grogoni's tool definitions are sent in the
 * provider's native format; a returned tool call is converted back into the canonical
 * `{"type":"tool",...}` JSON that parseRuntimeModelOutput already understands. From there the call
 * goes through the same validation, permission, confirmation and approval path as every other
 * model's output. The provider never executes anything.
 */
export function createRoutedModelRuntimeAdapter(input: {
  router: InferenceRouter;
  model: ModelDefinition;
  executionTarget: ModelExecutionTarget;
}): ModelRuntimeAdapter {
  const { router, model, executionTarget } = input;
  const deviceLocal = executionTarget === "browser-local" || executionTarget === "installed-app";
  return {
    provider: model.providerId,
    executionTarget,

    async canRun(context) {
      if (context.modelId !== model.id) {
        return {
          available: false,
          errorCode: "MODEL_IDENTITY_MISMATCH",
          message: "The adapter does not serve this model."
        };
      }
      try {
        await router.resolveInferenceTarget({
          agentId: context.agentId,
          modelId: model.id,
          tenantId: context.shopId,
          userId: context.accountId ?? null,
          // Configuration check only; the device itself is found at generation time.
          allowDeviceExecution: deviceLocal
        });
        return { available: true, errorCode: null, message: null };
      } catch (error) {
        const normalized =
          error instanceof ModelRuntimeError ? error : new InferenceError("INFERENCE_FAILED");
        return { available: false, errorCode: normalized.code, message: normalized.message };
      }
    },

    async healthCheck(context) {
      const startedAt = Date.now();
      const availability = await this.canRun(context);
      if (!availability.available) {
        return {
          ...availability,
          modelId: context.modelId,
          provider: model.providerId,
          executionTarget,
          latencyMs: Date.now() - startedAt,
          responsePreview: null,
          retryable: false
        };
      }
      if (deviceLocal) {
        // The server cannot probe a member's device. The model is verified on each device when
        // it is installed there, and each turn fails clearly if no such device is online.
        return {
          available: true,
          errorCode: null,
          message: null,
          modelId: context.modelId,
          provider: model.providerId,
          executionTarget,
          latencyMs: Date.now() - startedAt,
          responsePreview: "DEVICE_EXECUTED",
          retryable: false
        };
      }
      const health = await router.checkHealth({
        providerId: model.providerId,
        tenantId: context.shopId,
        userId: context.accountId ?? null,
        probeModelId: model.providerModelId,
        ...(context.signal === undefined ? {} : { signal: context.signal })
      });
      const ok = health.status === "AVAILABLE" || health.status === "DEGRADED";
      return {
        available: ok,
        errorCode: ok ? null : (health.errorCode ?? health.status),
        message: ok ? null : (health.message ?? "The model provider is unavailable."),
        modelId: context.modelId,
        provider: model.providerId,
        executionTarget,
        latencyMs: health.latencyMs ?? Date.now() - startedAt,
        responsePreview: ok ? "GROGONI_MODEL_OK" : null,
        retryable: health.status === "UNAVAILABLE" || health.status === "RATE_LIMITED"
      };
    },

    async generate({ context, prompt }) {
      const request = inferenceRequestFromPrompt(prompt, model, context);
      const turnId = currentTurnId();
      const publisher = turnStreamHub.replyPublisher(context.accountId, turnId);
      if (deviceLocal) publisher?.event({ type: "device", modelId: model.id });
      const response = await router.generate(request, {
        ...(turnId === undefined ? {} : { turnId }),
        // Device-local text is rendered by the device itself as it generates.
        ...(publisher === null || deviceLocal ? {} : { onText: publisher }),
        agentId: context.agentId,
        tenantId: context.shopId,
        userId: context.accountId ?? null,
        ...(context.conversationId === undefined ? {} : { conversationId: context.conversationId }),
        ...(context.runtimeBindingId === undefined
          ? {}
          : { runtimeBindingId: context.runtimeBindingId }),
        ...(context.signal === undefined ? {} : { signal: context.signal })
      });
      const text = canonicalOutputText(response.output, prompt.allowedTools);
      if (text === "") {
        throw new InferenceError("INVALID_PROVIDER_RESPONSE", {
          providerId: response.providerId,
          modelId: response.modelId,
          diagnostic: "Empty model output."
        });
      }
      return {
        text,
        modelId: response.modelId,
        provider: response.providerId,
        executionTarget,
        ...(response.usage?.inputTokens === undefined
          ? {}
          : { promptTokens: response.usage.inputTokens }),
        ...(response.usage?.outputTokens === undefined
          ? {}
          : { completionTokens: response.usage.outputTokens }),
        latencyMs: response.latency?.totalMs ?? 0,
        ...(response.finishReason === undefined ? {} : { finishReason: response.finishReason }),
        inferenceRequestId: response.providerRequestId ?? response.requestId
      };
    }
  };
}

/**
 * RuntimeModelPrompt (Grogoni's agent prompt) -> canonical chat request. The system message carries
 * the same instructions every other model gets; history becomes real chat turns. Business context
 * that the agent runtime already minimized (compiled instructions, retrieved context) arrives
 * inside `prompt.message` exactly as for the Vercel adapter - nothing extra is added here.
 */
export function inferenceRequestFromPrompt(
  prompt: RuntimeModelPrompt,
  model: ModelDefinition,
  context: Pick<ModelRuntimeContext, "conversationId">
): InferenceRequest {
  const messages: InferenceMessage[] = [
    { role: "system", content: buildInferenceInstructions(prompt) },
    ...(prompt.conversationHistory ?? []).map((message) => ({
      role: message.role,
      content: message.content
    })),
    { role: "user", content: prompt.message }
  ];
  const tools = model.capabilities.tools === true ? toolDefinitionsFor(prompt.allowedTools) : [];
  return {
    requestId: randomUUID(),
    modelId: model.id,
    messages,
    generation: { temperature: 0.2 },
    ...(tools.length === 0 ? {} : { tools }),
    ...(model.capabilities.structuredOutput === true && tools.length === 0
      ? { responseFormat: { type: "json_object" as const } }
      : {}),
    metadata: { conversationId: context.conversationId ?? null }
  };
}

export function toolDefinitionsFor(allowedTools: readonly RuntimeToolName[]): ToolDefinition[] {
  return [...new Set(allowedTools)].flatMap((name) => {
    const definition = runtimeToolRegistry[name];
    if (definition === undefined) return [];
    const required = Object.entries(definition.inputSchema.properties)
      .filter(([, field]) => field.required === true)
      .map(([field]) => field);
    return [
      {
        name,
        description: definition.description,
        inputSchema: {
          type: "object",
          properties: Object.fromEntries(
            Object.entries(definition.inputSchema.properties).map(([field, schema]) => [
              field,
              { type: schema.type, description: schema.description }
            ])
          ),
          ...(required.length === 0 ? {} : { required })
        }
      }
    ];
  });
}

/**
 * Canonical output -> the runtime's structured JSON text. A native tool call wins over prose, and
 * only tools the agent actually offered are accepted - anything else becomes a plain response and
 * is never proposed for execution.
 */
export function canonicalOutputText(
  output: { text: string; toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> },
  allowedTools: readonly RuntimeToolName[]
): string {
  const call = output.toolCalls.find((candidate) =>
    (allowedTools as readonly string[]).includes(candidate.name)
  );
  if (call !== undefined) {
    return JSON.stringify({
      type: "tool",
      toolName: call.name,
      input: call.arguments,
      reason:
        output.text.trim() === ""
          ? "Model proposed a runtime tool."
          : output.text.trim().slice(0, 500)
    });
  }
  return normalizeModelText(output.text);
}
