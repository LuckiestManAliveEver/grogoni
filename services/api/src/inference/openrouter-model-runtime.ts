import { randomUUID } from "node:crypto";
import type { AiModelSummary } from "@grogoni/shared-types";
import {
  buildInferenceInstructions,
  ModelRuntimeError,
  normalizeModelText,
  type ModelRuntimeAdapter
} from "./model-runtime.js";
import { hostedJsonRequest } from "./hosted-http.js";

export const lunaModel: AiModelSummary = {
  id: "gpt-6-luna",
  label: "GPT-6 Luna",
  provider: "openrouter",
  description:
    "GPT-6 Luna served through OpenRouter. Platform-funded within deployment usage limits.",
  capabilities: ["chat", "multilingual", "reasoning", "instruction-following"],
  available: true,
  source: "hosted",
  format: "remote",
  license: null,
  licenseUrl: null,
  modelCardUrl: "https://openrouter.ai/openai/gpt-6-luna",
  downloadUrl: null,
  fileName: null,
  fileSizeBytes: null,
  minimumMemoryGb: null,
  recommended: true,
  contextWindow: 1_050_000,
  canonicalModelId: "openai/gpt-6-luna",
  supportsToolCalling: true,
  supportsStructuredOutput: true,
  costResponsibility: "platform-included"
};

export function createOpenRouterModelAdapter(input: {
  modelId: string;
  providerModelId: string;
  apiKey: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  request?: typeof fetch;
}): ModelRuntimeAdapter {
  const availability = (modelId: string) =>
    modelId !== input.modelId
      ? {
          available: false,
          errorCode: "MODEL_IDENTITY_MISMATCH",
          message: "The adapter does not serve this model."
        }
      : input.apiKey.trim() === ""
        ? {
            available: false,
            errorCode: "CREDENTIAL_MISSING",
            message: "OpenRouter is not configured."
          }
        : { available: true, errorCode: null, message: null };
  return {
    provider: "openrouter",
    executionTarget: "backend",
    async canRun(context) {
      return availability(context.modelId);
    },
    async healthCheck(context) {
      const started = Date.now();
      const status = availability(context.modelId);
      if (!status.available)
        return {
          ...status,
          provider: this.provider,
          modelId: context.modelId,
          executionTarget: this.executionTarget,
          latencyMs: 0,
          responsePreview: null,
          retryable: false
        };
      try {
        await hostedJsonRequest({
          url: new URL("https://openrouter.ai/api/v1/key"),
          init: { headers: { authorization: `Bearer ${input.apiKey}` } },
          timeoutMs: 10_000,
          ...(context.signal ? { signal: context.signal } : {}),
          ...(input.request ? { request: input.request } : {})
        });
        return {
          ...status,
          provider: this.provider,
          modelId: context.modelId,
          executionTarget: this.executionTarget,
          latencyMs: Date.now() - started,
          responsePreview: null,
          retryable: false
        };
      } catch (error) {
        return {
          available: false,
          errorCode: error instanceof ModelRuntimeError ? error.code : "PROVIDER_UNAVAILABLE",
          message: "OpenRouter authentication check failed.",
          provider: this.provider,
          modelId: context.modelId,
          executionTarget: this.executionTarget,
          latencyMs: Date.now() - started,
          responsePreview: null,
          retryable: true
        };
      }
    },
    async generate({ context, prompt }) {
      const status = availability(context.modelId);
      if (!status.available) throw new ModelRuntimeError(status.errorCode!, status.message!, false);
      const started = Date.now();
      const body = (await hostedJsonRequest({
        url: new URL("https://openrouter.ai/api/v1/chat/completions"),
        timeoutMs: input.timeoutMs ?? 120_000,
        ...(context.signal ? { signal: context.signal } : {}),
        ...(input.request ? { request: input.request } : {}),
        init: {
          method: "POST",
          headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: input.providerModelId,
            messages: [
              { role: "system", content: buildInferenceInstructions(prompt) },
              ...(prompt.conversationHistory ?? []).map((message) => ({
                role: message.role === "assistant" ? "assistant" : "user",
                content: message.content
              })),
              { role: "user", content: prompt.message }
            ],
            max_tokens: input.maxOutputTokens ?? 2048,
            response_format: { type: "json_object" },
            provider: { allow_fallbacks: false }
          })
        }
      })) as {
        model?: string;
        id?: string;
        choices?: { message?: { content?: string }; finish_reason?: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      if (!body || typeof body !== "object")
        throw new ModelRuntimeError(
          "INVALID_PROVIDER_RESPONSE",
          "OpenRouter returned an invalid response.",
          false
        );
      if (body.model !== input.providerModelId)
        throw new ModelRuntimeError(
          "MODEL_IDENTITY_MISMATCH",
          "OpenRouter answered with a different model.",
          false
        );
      const content = body.choices?.[0]?.message?.content;
      const text = normalizeModelText(typeof content === "string" ? content : "");
      if (!text)
        throw new ModelRuntimeError(
          "INVALID_PROVIDER_RESPONSE",
          "OpenRouter returned no model output.",
          true
        );
      return {
        text,
        modelId: input.modelId,
        provider: this.provider,
        executionTarget: this.executionTarget,
        latencyMs: Date.now() - started,
        inferenceRequestId: body.id ?? randomUUID(),
        ...(body.usage?.prompt_tokens === undefined
          ? {}
          : { promptTokens: body.usage.prompt_tokens }),
        ...(body.usage?.completion_tokens === undefined
          ? {}
          : { completionTokens: body.usage.completion_tokens }),
        ...(body.choices?.[0]?.finish_reason ? { finishReason: body.choices[0].finish_reason } : {})
      };
    }
  };
}
