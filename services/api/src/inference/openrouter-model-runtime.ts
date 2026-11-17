import { randomUUID } from "node:crypto";
import type { AiModelSummary } from "@grogoni/shared-types";
import {
  buildInferenceInstructions,
  ModelRuntimeError,
  normalizeModelText,
  type ModelRuntimeAdapter
} from "./model-runtime.js";
import { hostedEventStreamRequest, hostedJsonRequest } from "./hosted-http.js";
import { currentTurnId, turnStreamHub } from "./turn-stream.js";

export const lunaModel: AiModelSummary = {
  id: "gpt-6-luna",
  label: "GPT-6 Luna",
  provider: "openrouter",
  description:
    "GPT-6 Luna served through OpenRouter. Platform-funded within deployment usage limits.",
  capabilities: ["chat", "multilingual", "reasoning", "instruction-following", "vision"],
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

/**
 * How much the model reasons before it answers. Reasoning tokens come before the first visible
 * token and count against max_tokens, so they are most of a chat turn's wait. "default" sends no
 * setting and leaves the provider's own default. Calls that carry images (receipt and chat image
 * transcription, on every path) use imageReasoningEffort instead, "default" unless configured:
 * they feed money and stock, where accuracy outweighs speed.
 */
export const openRouterReasoningEfforts = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high"
] as const;
export type OpenRouterReasoningEffort = (typeof openRouterReasoningEfforts)[number];
/** Chat turns are short JSON replies and tool proposals; low still reasons, just briefly. */
export const defaultOpenRouterReasoningEffort: OpenRouterReasoningEffort = "low";
export const defaultOpenRouterImageReasoningEffort: OpenRouterReasoningEffort = "default";

/**
 * Which host of the SAME model OpenRouter tries first. With allow_fallbacks, a host that fails
 * hands the call to the next host of that model in this order (never another model: the
 * request names one model and the answer's model is checked). The host that answered is recorded
 * as providerHost. "none" keeps OpenRouter's default load balancing.
 */
export const openRouterProviderSorts = ["none", "latency", "throughput", "price"] as const;
export type OpenRouterProviderSort = (typeof openRouterProviderSorts)[number];
export const defaultOpenRouterProviderSort: OpenRouterProviderSort = "latency";

/** The request body for one chat-completions call; exported so its shape is tested directly. */
export function openRouterChatRequestBody(input: {
  providerModelId: string;
  messages: unknown[];
  maxOutputTokens: number;
  reasoningEffort: OpenRouterReasoningEffort;
  providerSort: OpenRouterProviderSort;
}): Record<string, unknown> {
  return {
    model: input.providerModelId,
    messages: input.messages,
    max_tokens: input.maxOutputTokens,
    response_format: { type: "json_object" },
    // exclude: the runtime never reads the reasoning text, so it is not sent back over the wire.
    ...(input.reasoningEffort === "default"
      ? {}
      : { reasoning: { effort: input.reasoningEffort, exclude: true } }),
    provider: {
      allow_fallbacks: true,
      ...(input.providerSort === "none" ? {} : { sort: input.providerSort })
    }
  };
}

export function createOpenRouterModelAdapter(input: {
  modelId: string;
  providerModelId: string;
  apiKey: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  reasoningEffort?: OpenRouterReasoningEffort;
  imageReasoningEffort?: OpenRouterReasoningEffort;
  /** A bad image-only setting: image calls fail with it, every other call is unaffected. */
  imageConfigurationError?: string;
  providerSort?: OpenRouterProviderSort;
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
    async generate({ context, prompt, images }) {
      const status = availability(context.modelId);
      if (!status.available) throw new ModelRuntimeError(status.errorCode!, status.message!, false);
      if (images?.length && input.imageConfigurationError !== undefined)
        throw new ModelRuntimeError(
          "MODEL_CONFIGURATION_INVALID",
          "The image reader configuration is invalid. Ask the service administrator to check it.",
          false
        );
      const started = Date.now();
      const requestBody = openRouterChatRequestBody({
        providerModelId: input.providerModelId,
        messages: [
          { role: "system", content: buildInferenceInstructions(prompt) },
          ...(prompt.conversationHistory ?? []).map((message) => ({
            role: message.role === "assistant" ? "assistant" : "user",
            content: message.content
          })),
          {
            role: "user",
            content: images?.length
              ? [
                  { type: "text", text: prompt.message },
                  ...images.map((image) => ({
                    type: "image_url",
                    image_url: { url: image.url, detail: "high" }
                  }))
                ]
              : prompt.message
          }
        ],
        maxOutputTokens: input.maxOutputTokens ?? 2048,
        reasoningEffort: images?.length
          ? (input.imageReasoningEffort ?? defaultOpenRouterImageReasoningEffort)
          : (input.reasoningEffort ?? defaultOpenRouterReasoningEffort),
        providerSort: input.providerSort ?? defaultOpenRouterProviderSort
      });
      const call = {
        url: new URL("https://openrouter.ai/api/v1/chat/completions"),
        timeoutMs: input.timeoutMs ?? 120_000,
        ...(context.signal ? { signal: context.signal } : {}),
        ...(input.request ? { request: input.request } : {})
      };
      const headers = {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json"
      };
      // Stream only when someone can watch: the turn has a live reply stream (turn-stream.ts).
      // Image transcription is never previewed and keeps the single-response path.
      const publisher = images?.length
        ? null
        : turnStreamHub.replyPublisher(context.accountId, currentTurnId());
      let firstTokenMs: number | undefined;
      let body: OpenRouterChatResponse | null;
      if (publisher === null) {
        body = (await hostedJsonRequest({
          ...call,
          init: { method: "POST", headers, body: JSON.stringify(requestBody) }
        })) as OpenRouterChatResponse | null;
      } else {
        try {
          body = await streamOpenRouterChat({
            call,
            init: {
              method: "POST",
              headers: { ...headers, accept: "text/event-stream" },
              body: JSON.stringify({ ...requestBody, stream: true })
            },
            providerModelId: input.providerModelId,
            // Per-token framing is far larger than the text: about 300-400 bytes per delta.
            maxBytes: Math.max(2_000_000, (input.maxOutputTokens ?? 2048) * 1_000),
            onText: (delta) => {
              if (firstTokenMs === undefined) firstTokenMs = Date.now() - started;
              try {
                publisher.raw(delta);
              } catch {
                // The preview is optional; a failing watcher never fails the model call.
              }
            }
          });
        } catch (error) {
          // Whatever was previewed is not a reply: clear it before the failure is reported.
          publisher.reset();
          throw error;
        }
      }
      let text: string;
      try {
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
        // Image extraction validates its structured response before accepting a transcription.
        const rawText = typeof content === "string" ? content : "";
        text = images?.length ? rawText.trim() : normalizeModelText(rawText);
        if (!text)
          throw new ModelRuntimeError(
            "INVALID_PROVIDER_RESPONSE",
            "OpenRouter returned no model output.",
            true
          );
      } catch (error) {
        // A streamed preview of an output that failed validation is not a reply either.
        publisher?.reset();
        throw error;
      }
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
        ...(typeof body.usage?.prompt_tokens_details?.cached_tokens === "number"
          ? { cachedPromptTokens: body.usage.prompt_tokens_details.cached_tokens }
          : {}),
        ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
        ...(typeof body.provider === "string" ? { providerHost: body.provider } : {}),
        ...(body.choices?.[0]?.finish_reason ? { finishReason: body.choices[0].finish_reason } : {})
      };
    }
  };
}

interface OpenRouterChatResponse {
  model?: string;
  /** The host that served the call (OpenRouter's provider name, e.g. "OpenAI", "Azure"). */
  provider?: string;
  id?: string;
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

interface OpenRouterStreamChunk {
  id?: string;
  model?: string;
  provider?: string;
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: OpenRouterChatResponse["usage"];
  error?: { code?: unknown; message?: unknown };
}

/**
 * One streamed chat completion (`stream: true`), folded back into the single-response shape so
 * the caller validates both the same way. Each content delta goes to `onText` as it arrives. A
 * chunk naming another model stops the call at once, before its own text is previewed; a stream
 * that never names its model fails the caller's identity check at the end, and the caller then
 * clears whatever it previewed. An error chunk mid-stream fails the call as the provider being
 * unavailable.
 */
async function streamOpenRouterChat(input: {
  call: { url: URL; timeoutMs: number; signal?: AbortSignal; request?: typeof fetch };
  init: RequestInit;
  providerModelId: string;
  maxBytes: number;
  onText: (delta: string) => void;
}): Promise<OpenRouterChatResponse> {
  let content = "";
  let id: string | undefined;
  let model: string | undefined;
  let finishReason: string | undefined;
  let host: string | undefined;
  let usage: OpenRouterChatResponse["usage"];
  await hostedEventStreamRequest({
    ...input.call,
    init: input.init,
    maxBytes: input.maxBytes,
    onEvent: (raw) => {
      if (raw === null || typeof raw !== "object") return;
      const chunk = raw as OpenRouterStreamChunk;
      if (chunk.error !== undefined)
        throw new ModelRuntimeError(
          "PROVIDER_UNAVAILABLE",
          "OpenRouter stopped the response with an error.",
          true
        );
      if (typeof chunk.model === "string") {
        if (chunk.model !== input.providerModelId)
          throw new ModelRuntimeError(
            "MODEL_IDENTITY_MISMATCH",
            "OpenRouter answered with a different model.",
            false
          );
        model = chunk.model;
      }
      if (typeof chunk.id === "string") id ??= chunk.id;
      if (typeof chunk.provider === "string") host = chunk.provider;
      if (chunk.usage !== undefined && chunk.usage !== null) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      const delta = choice?.delta?.content;
      if (typeof delta === "string" && delta !== "") {
        content += delta;
        input.onText(delta);
      }
      if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
    }
  });
  return {
    ...(model === undefined ? {} : { model }),
    ...(id === undefined ? {} : { id }),
    ...(host === undefined ? {} : { provider: host }),
    choices: [
      {
        message: { content },
        ...(finishReason === undefined ? {} : { finish_reason: finishReason })
      }
    ],
    ...(usage === undefined ? {} : { usage })
  };
}
