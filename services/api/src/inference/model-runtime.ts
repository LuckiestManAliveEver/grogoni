import { randomUUID } from "node:crypto";
import type {
  InferenceExecutionEvent,
  InferenceExecutionRequest,
  ModelExecutionTarget,
  RuntimeModelCompletionResult,
  RuntimeModelPrompt,
  RuntimeModelProvider
} from "@grogoni/shared-types";
import {
  renderRuntimeModelFewShotExamples,
  renderRuntimeModelOutputInstructions
} from "@grogoni/tool-core";
import {
  type Bulkhead,
  BulkheadRejectedError,
  type CircuitBreaker,
  CircuitOpenError
} from "@grogoni/resource-control";

import type { ModelArtifactStore } from "./model-artifact-store.js";
import { currentTurnId, turnStreamHub } from "./turn-stream.js";

export interface ModelRuntimeContext {
  agentId: string;
  agentAdapterId?: string;
  shopId: string;
  modelId: string;
  conversationId?: string;
  runtimeBindingId?: string;
  executionHostId?: string;
  runtimeContractVersion?: string;
  signal?: AbortSignal;
  /**
   * Set only when the business has explicitly authorized spending its own connected provider
   * credential on this call (see ExternalConnectionsDomain.resolveInferenceToken). Never resolved
   * inside this file - callers that want user-connected billing must resolve and pass it in.
   */
  providerCredential?: { token: string } | null;
  /**
   * The account the turn runs for. Only the multi-provider router reads it, to resolve that
   * account's own (user-scoped) BYOK credential; the business is `shopId`. Never forwarded to any
   * provider.
   */
  accountId?: string;
}

export interface ModelRuntimeAvailability {
  available: boolean;
  errorCode: string | null;
  message: string | null;
}

export interface ModelRuntimeHealthResult extends ModelRuntimeAvailability {
  modelId: string;
  provider: string;
  executionTarget: ModelExecutionTarget;
  latencyMs: number;
  responsePreview: string | null;
  retryable: boolean;
}

export interface ModelRuntimeGenerationResult {
  text: string;
  modelId: string;
  provider: string;
  executionTarget: ModelExecutionTarget;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs: number;
  finishReason?: string;
  inferenceRequestId?: string;
}

export interface ModelRuntimeAdapter {
  readonly provider: string;
  readonly executionTarget: ModelExecutionTarget;
  canRun(context: ModelRuntimeContext): Promise<ModelRuntimeAvailability>;
  healthCheck(context: ModelRuntimeContext): Promise<ModelRuntimeHealthResult>;
  generate(input: {
    context: ModelRuntimeContext;
    prompt: RuntimeModelPrompt;
  }): Promise<ModelRuntimeGenerationResult>;
}

export class ModelRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ModelRuntimeError";
  }
}

export interface VercelInferenceClient {
  health(signal?: AbortSignal): Promise<void>;
  infer(
    request: InferenceExecutionRequest,
    options?: { signal?: AbortSignal; onDelta?: (text: string) => void }
  ): Promise<Extract<InferenceExecutionEvent, { type: "result" }>>;
}

export interface OllamaHealthResult {
  provider: "ollama";
  available: boolean;
  endpoint: string;
  model: string;
  modelInstalled: boolean;
  errorCode: string | null;
  message: string | null;
}

interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OllamaInferenceClient {
  health(signal?: AbortSignal): Promise<OllamaHealthResult>;
  chat(
    messages: OllamaChatMessage[],
    options?: { signal?: AbortSignal; onDelta?: (text: string) => void }
  ): Promise<{ text: string; promptTokens?: number; completionTokens?: number; finishReason?: string }>;
}

export function createOllamaInferenceClient(options: {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  request?: typeof fetch;
}): OllamaInferenceClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl, "OLLAMA_BASE_URL");
  const model = options.model;
  const invoke = async (path: string, init: RequestInit, signal?: AbortSignal) => {
    const controller = new AbortController();
    let externallyAborted = signal?.aborted === true;
    const abort = () => {
      externallyAborted = true;
      controller.abort(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      return await (options.request ?? fetch)(new URL(path, baseUrl), {
        ...init,
        headers: {
          accept: "application/x-ndjson, application/json",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...init.headers
        },
        signal: controller.signal,
        credentials: "omit"
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ModelRuntimeError(
          externallyAborted ? "INFERENCE_CANCELLED" : "INFERENCE_TIMEOUT",
          externallyAborted ? "Inference was cancelled." : "Local Ollama inference timed out.",
          true,
          { cause: error }
        );
      }
      throw new ModelRuntimeError(
        "OLLAMA_UNREACHABLE",
        "Local Ollama is unreachable at the configured endpoint.",
        true,
        { cause: error }
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  };
  return {
    async health(signal) {
      try {
        const response = await invoke("/api/tags", { method: "GET" }, signal);
        if (!response.ok) throw responseError(response.status, await response.json().catch(() => null));
        const body = (await response.json().catch(() => ({}))) as { models?: Array<{ name?: string }> };
        const modelInstalled = (body.models ?? []).some((entry) => entry.name === model);
        return {
          provider: "ollama",
          available: modelInstalled,
          endpoint: baseUrl.toString().replace(/\/+$/u, ""),
          model,
          modelInstalled,
          errorCode: modelInstalled ? null : "MODEL_NOT_INSTALLED",
          message: modelInstalled ? null : `Ollama model ${model} is not installed.`
        };
      } catch (error) {
        const normalized = asModelRuntimeError(error);
        return {
          provider: "ollama",
          available: false,
          endpoint: baseUrl.toString().replace(/\/+$/u, ""),
          model,
          modelInstalled: false,
          errorCode: normalized.code,
          message: normalized.message
        };
      }
    },
    async chat(messages, callOptions = {}) {
      const response = await invoke(
        "/api/chat",
        {
          method: "POST",
          body: JSON.stringify({ model, messages, stream: true, options: { temperature: 0.2 } })
        },
        callOptions.signal
      );
      if (!response.ok) throw responseError(response.status, await response.json().catch(() => null));
      if (response.body === null) {
        throw new ModelRuntimeError("INFERENCE_FAILED", "Ollama returned no stream.", true);
      }
      let buffer = "";
      let text = "";
      let promptTokens: number | undefined;
      let completionTokens: number | undefined;
      let finishReason: string | undefined;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.trim() === "") continue;
            const event = parseOllamaChatEvent(line);
            const delta = event.message?.content ?? "";
            if (delta !== "") {
              text += delta;
              callOptions.onDelta?.(delta);
            }
            if (event.done === true) {
              promptTokens = event.prompt_eval_count;
              completionTokens = event.eval_count;
              finishReason = event.done_reason;
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
      if (buffer.trim() !== "") {
        const event = parseOllamaChatEvent(buffer);
        const delta = event.message?.content ?? "";
        text += delta;
        if (delta !== "") callOptions.onDelta?.(delta);
        if (event.done === true) {
          promptTokens = event.prompt_eval_count;
          completionTokens = event.eval_count;
          finishReason = event.done_reason;
        }
      }
      if (text.trim() === "") {
        throw new ModelRuntimeError("INFERENCE_FAILED", "Ollama returned an empty response.", true);
      }
      return {
        text,
        ...(promptTokens === undefined ? {} : { promptTokens }),
        ...(completionTokens === undefined ? {} : { completionTokens }),
        ...(finishReason === undefined ? {} : { finishReason })
      };
    }
  };
}

export function createVercelInferenceClient(options: {
  baseUrl: string;
  serviceToken: string;
  timeoutMs: number;
  request?: typeof fetch;
}): VercelInferenceClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl, "VERCEL_INFERENCE_URL");
  if (options.serviceToken.length < 32) throw new Error("Inference service token is too short.");
  const invoke = async (path: string, init: RequestInit, signal?: AbortSignal) => {
    const controller = new AbortController();
    let externallyAborted = signal?.aborted === true;
    const abort = () => {
      externallyAborted = true;
      controller.abort(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      return await (options.request ?? fetch)(new URL(path, baseUrl), {
        ...init,
        headers: {
          accept: "application/x-ndjson, application/json",
          authorization: `Bearer ${options.serviceToken}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...init.headers
        },
        signal: controller.signal,
        credentials: "omit"
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ModelRuntimeError(
          externallyAborted ? "INFERENCE_CANCELLED" : "INFERENCE_TIMEOUT",
          externallyAborted ? "Inference was cancelled." : "Vercel inference timed out.",
          true,
          { cause: error }
        );
      }
      throw new ModelRuntimeError(
        "INFERENCE_SERVICE_UNREACHABLE",
        "Vercel inference is unreachable.",
        true,
        { cause: error }
      );
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  };
  return {
    async health(signal) {
      const response = await invoke("/health", { method: "GET" }, signal);
      if (!response.ok)
        throw responseError(response.status, await response.json().catch(() => null));
    },
    async infer(request, callOptions = {}) {
      const response = await invoke(
        "/v1/inference",
        { method: "POST", body: JSON.stringify(request) },
        callOptions.signal
      );
      if (!response.ok)
        throw responseError(response.status, await response.json().catch(() => null));
      if (response.body === null) {
        throw new ModelRuntimeError(
          "INVALID_INFERENCE_RESPONSE",
          "Vercel returned no stream.",
          true
        );
      }
      let buffer = "";
      let result: Extract<InferenceExecutionEvent, { type: "result" }> | null = null;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.trim() === "") continue;
            const event = parseEvent(line);
            if (event.type === "delta") callOptions.onDelta?.(event.text);
            if (event.type === "error") {
              throw new ModelRuntimeError(event.code, event.message, event.retryable);
            }
            if (event.type === "result") result = event;
          }
        }
      } finally {
        reader.releaseLock();
      }
      if (buffer.trim() !== "") {
        const event = parseEvent(buffer);
        if (event.type === "result") result = event;
        if (event.type === "error")
          throw new ModelRuntimeError(event.code, event.message, event.retryable);
      }
      if (result === null || result.requestId !== request.requestId || result.text.trim() === "") {
        throw new ModelRuntimeError(
          "INVALID_INFERENCE_RESPONSE",
          "Vercel returned an invalid result.",
          true
        );
      }
      return result;
    }
  };
}

export function createVercelModelAdapter(input: {
  modelId: string;
  artifactStore: ModelArtifactStore;
  client: VercelInferenceClient;
  /**
   * False for models with no GGUF artifact to verify (e.g. Hugging Face-routed models) - see
   * RuntimeModelDefinition.requiresArtifact. Defaults to true so every adapter registered before
   * this option existed keeps verifying an artifact exactly as before.
   */
  requiresArtifact?: boolean;
}): ModelRuntimeAdapter {
  const requiresArtifact = input.requiresArtifact ?? true;
  // "llama.cpp" only accurately describes artifact-backed models; a model routed through a remote
  // chat-completions provider (Hugging Face today) never touches llama.cpp at all, so mislabeling
  // it would corrupt provider attribution in usage accounting and health reporting.
  const provider = requiresArtifact ? "llama.cpp" : "remote-chat-completions";
  return {
    provider,
    executionTarget: "vercel",
    async canRun(context) {
      if (context.modelId !== input.modelId) {
        return {
          available: false,
          errorCode: "MODEL_IDENTITY_MISMATCH",
          message: "The adapter does not serve this model."
        };
      }
      try {
        if (requiresArtifact) {
          const artifact = await input.artifactStore.resolveArtifact(context.modelId);
          const verification = await input.artifactStore.verifyArtifact(artifact, context.signal);
          if (!verification.ok) {
            return {
              available: false,
              errorCode: verification.errorCode,
              message: "The model artifact is unavailable."
            };
          }
        }
        await input.client.health(context.signal);
        return { available: true, errorCode: null, message: null };
      } catch (error) {
        const normalized = asModelRuntimeError(error);
        return { available: false, errorCode: normalized.code, message: normalized.message };
      }
    },
    async healthCheck(context) {
      const startedAt = Date.now();
      const availability = await this.canRun(context);
      return {
        ...availability,
        modelId: context.modelId,
        provider: this.provider,
        executionTarget: this.executionTarget,
        latencyMs: Date.now() - startedAt,
        responsePreview: null,
        retryable: availability.available || availability.errorCode === "ARTIFACT_NOT_FOUND"
      };
    },
    async generate({ context, prompt }) {
      const startedAt = Date.now();
      const resolvedArtifact = requiresArtifact
        ? await input.artifactStore.createDownloadUrl(
            await input.artifactStore.resolveArtifact(context.modelId)
          )
        : undefined;
      const requestId = randomUUID();
      const publisher = turnStreamHub.replyPublisher(context.accountId, currentTurnId());
      const result = await input.client.infer(
        {
          requestId,
          conversationId: context.conversationId ?? `runtime:${context.shopId}`,
          runtimeBindingId: context.runtimeBindingId ?? "runtime-unbound",
          executionHostId: context.executionHostId ?? "builtin:vercel-inference:v1",
          agent: { id: context.agentId, adapterId: context.agentAdapterId ?? "pi" },
          model: {
            id: context.modelId,
            runtimeContractVersion: context.runtimeContractVersion ?? "1"
          },
          ...(resolvedArtifact === undefined ? {} : { artifact: resolvedArtifact }),
          prompt: buildInferencePrompt(prompt),
          generation: { maxTokens: 256, temperature: 0.2, jsonOutput: true },
          ...(context.providerCredential === undefined
            ? {}
            : { providerCredential: context.providerCredential })
        },
        {
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          // Live reply preview for a watching client (see inference/turn-stream.ts).
          ...(publisher === null ? {} : { onDelta: (delta: string) => publisher.raw(delta) })
        }
      );
      const text = normalizeModelText(result.text);
      if (text === "")
        throw new ModelRuntimeError(
          "INVALID_INFERENCE_RESPONSE",
          "The model returned malformed output.",
          true
        );
      return {
        text,
        modelId: context.modelId,
        provider,
        executionTarget: "vercel",
        ...(result.usage.inputTokens === null ? {} : { promptTokens: result.usage.inputTokens }),
        ...(result.usage.outputTokens === null
          ? {}
          : { completionTokens: result.usage.outputTokens }),
        latencyMs: Date.now() - startedAt,
        ...(result.finishReason === null ? {} : { finishReason: result.finishReason }),
        inferenceRequestId: requestId
      };
    }
  };
}

export function createOllamaModelAdapter(input: {
  modelId: string;
  ollamaModel: string;
  client: OllamaInferenceClient;
}): ModelRuntimeAdapter {
  return {
    provider: "ollama",
    executionTarget: "local",
    async canRun(context) {
      if (context.modelId !== input.modelId) {
        return {
          available: false,
          errorCode: "MODEL_IDENTITY_MISMATCH",
          message: "The adapter does not serve this model."
        };
      }
      const health = await input.client.health(context.signal);
      return {
        available: health.available,
        errorCode: health.errorCode,
        message: health.message
      };
    },
    async healthCheck(context) {
      const startedAt = Date.now();
      const health = await input.client.health(context.signal);
      return {
        available: health.available,
        errorCode: health.errorCode,
        message: health.message,
        modelId: context.modelId,
        provider: this.provider,
        executionTarget: this.executionTarget,
        latencyMs: Date.now() - startedAt,
        responsePreview: null,
        retryable: !health.available
      };
    },
    async generate({ context, prompt }) {
      const startedAt = Date.now();
      const publisher = turnStreamHub.replyPublisher(context.accountId, currentTurnId());
      const result = await input.client.chat(buildOllamaMessages(prompt), {
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        ...(publisher === null ? {} : { onDelta: (delta: string) => publisher.raw(delta) })
      });
      const text = normalizeModelText(result.text);
      if (text === "") {
        throw new ModelRuntimeError(
          "INFERENCE_FAILED",
          "The local model returned malformed output.",
          true
        );
      }
      return {
        text,
        modelId: context.modelId,
        provider: "ollama",
        executionTarget: "local",
        ...(result.promptTokens === undefined ? {} : { promptTokens: result.promptTokens }),
        ...(result.completionTokens === undefined
          ? {}
          : { completionTokens: result.completionTokens }),
        latencyMs: Date.now() - startedAt,
        ...(result.finishReason === undefined ? {} : { finishReason: result.finishReason }),
        inferenceRequestId: randomUUID()
      };
    }
  };
}

/**
 * Gates `generate()` behind a bulkhead (bounded concurrency + bounded wait queue) and a circuit
 * breaker, both shared across every model adapter targeting the same execution host - see
 * docs/architecture/resource-isolation.md §3/§7. This closes the highest-priority gap found in
 * the resource-isolation audit: before this wrapper existed, services/api placed no bound at all
 * on concurrent inference calls, relying entirely on ai-runtime's own single-generation-at-a-time
 * `busy` flag (services/ai-runtime/src/http-server.ts) to reject overload - which produced a burst
 * of user-visible failures under concurrent load instead of smooth, bounded queuing, and never
 * stopped repeatedly hammering an `ai-runtime` instance that was clearly down.
 *
 * `canRun`/`healthCheck` are intentionally left unwrapped: they're lightweight diagnostic calls
 * (health-check/model-artifact verification), not the expensive generation the budget protects,
 * and health checks must keep working even while the generation bulkhead is fully saturated.
 */
export function boundModelRuntimeAdapter(
  adapter: ModelRuntimeAdapter,
  controls: { bulkhead: Bulkhead; breaker: CircuitBreaker }
): ModelRuntimeAdapter {
  return {
    provider: adapter.provider,
    executionTarget: adapter.executionTarget,
    canRun: (context) => adapter.canRun(context),
    healthCheck: (context) => adapter.healthCheck(context),
    async generate(input) {
      try {
        return await controls.bulkhead.run(() =>
          controls.breaker.run(() => adapter.generate(input))
        );
      } catch (error) {
        if (error instanceof BulkheadRejectedError) {
          throw new ModelRuntimeError(
            "INFERENCE_BUSY",
            "Inference is at capacity; please retry shortly.",
            true,
            { cause: error }
          );
        }
        if (error instanceof CircuitOpenError) {
          throw new ModelRuntimeError(
            "INFERENCE_CIRCUIT_OPEN",
            "Inference is temporarily disabled after repeated failures.",
            true,
            { cause: error }
          );
        }
        throw error;
      }
    }
  };
}

export function runtimeProviderFromAdapter(input: {
  adapter: ModelRuntimeAdapter;
  context: Omit<ModelRuntimeContext, "signal">;
}): RuntimeModelProvider {
  return {
    name: input.adapter.provider as RuntimeModelProvider["name"],
    async complete(prompt, signal) {
      const startedAt = Date.now();
      try {
        const result = await input.adapter.generate({
          context: { ...input.context, ...(signal === undefined ? {} : { signal }) },
          prompt
        });
        return {
          provider: result.provider as RuntimeModelCompletionResult["provider"],
          status: "available",
          outputText: result.text,
          durationMs: result.latencyMs,
          errorCode: null,
          metadata: {
            modelId: result.modelId,
            executionTarget: result.executionTarget,
            ...(result.promptTokens === undefined ? {} : { promptTokens: result.promptTokens }),
            ...(result.completionTokens === undefined
              ? {}
              : { completionTokens: result.completionTokens }),
            ...(result.finishReason === undefined ? {} : { finishReason: result.finishReason }),
            ...(result.inferenceRequestId === undefined
              ? {}
              : { inferenceRequestId: result.inferenceRequestId })
          }
        };
      } catch (error) {
        const normalized = asModelRuntimeError(error);
        return {
          provider: input.adapter.provider as RuntimeModelCompletionResult["provider"],
          status: normalized.code === "INFERENCE_TIMEOUT" ? "timeout" : "unavailable",
          outputText: null,
          durationMs: Date.now() - startedAt,
          errorCode: normalized.code,
          metadata: {
            modelId: input.context.modelId,
            executionTarget: input.adapter.executionTarget
          }
        };
      }
    }
  };
}

export function asModelRuntimeError(error: unknown): ModelRuntimeError {
  return error instanceof ModelRuntimeError
    ? error
    : new ModelRuntimeError(
        "RUNTIME_UNAVAILABLE",
        error instanceof Error ? error.message : "The model runtime is unavailable.",
        true,
        { cause: error }
      );
}

export function buildInferencePrompt(prompt: RuntimeModelPrompt): string {
  const history = (prompt.conversationHistory ?? [])
    .map((message) => `${message.role === "assistant" ? "Assistant" : "User"}: ${message.content}`)
    .join("\n");
  return [
    buildInferenceInstructions(prompt),
    ...(history === "" ? [] : [`Recent conversation (oldest first):\n${history}`]),
    prompt.message
  ].join("\n");
}

/**
 * The system-level part of the runtime prompt (role, output contract, few-shot examples, template
 * recipe) without history or the user's message. Chat-message providers
 * (inference/providers/routed-model-adapter.ts) send this as the system message and the history
 * as real turns; single-string providers get it through buildInferencePrompt above.
 */
export function buildInferenceInstructions(prompt: RuntimeModelPrompt): string {
  const fewShotExamples = renderRuntimeModelFewShotExamples(prompt.allowedTools);
  const templateRecipe = renderModelTemplateRecipe(prompt);
  return [
    "You are the model behind the Grogoni agent runtime.",
    renderRuntimeModelOutputInstructions(prompt.allowedTools),
    ...(fewShotExamples === "" ? [] : [fewShotExamples]),
    ...(templateRecipe === "" ? [] : [templateRecipe])
  ].join("\n");
}

function buildOllamaMessages(prompt: RuntimeModelPrompt): OllamaChatMessage[] {
  return [
    { role: "system", content: buildInferenceInstructions(prompt) },
    ...(prompt.conversationHistory ?? []).map((message): OllamaChatMessage => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content
    })),
    { role: "user", content: prompt.message }
  ];
}

function renderModelTemplateRecipe(prompt: RuntimeModelPrompt): string {
  const recipe = prompt.modelTemplate;
  if (recipe === undefined) return "";
  return [
    "# Grogoni model template recipe",
    `Template: ${recipe.templateId}@${recipe.version} (${recipe.templateVersionId})`,
    ...(recipe.task === null ? [] : [`Task: ${recipe.task}`]),
    `Allowed template tools: ${recipe.allowedTools.join(", ") || "none"}`,
    ...(recipe.contextRequirements.length === 0
      ? []
      : [`Context requirements: ${recipe.contextRequirements.join(", ")}`]),
    ...(recipe.outputSchema === undefined
      ? []
      : [`Required output schema: ${JSON.stringify(recipe.outputSchema)}`]),
    ...(Object.keys(recipe.constraints).length === 0
      ? []
      : [`Execution constraints: ${JSON.stringify(recipe.constraints)}`]),
    `Vocabulary snapshots: template=${recipe.templateVocabularySnapshot}, current=${recipe.currentVocabularySnapshot}`
  ].join("\n");
}

function parseEvent(line: string): InferenceExecutionEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new ModelRuntimeError(
      "INVALID_INFERENCE_RESPONSE",
      "Vercel returned malformed stream data.",
      true
    );
  }
  if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
    throw new ModelRuntimeError(
      "INVALID_INFERENCE_RESPONSE",
      "Vercel returned malformed stream data.",
      true
    );
  }
  return parsed as InferenceExecutionEvent;
}

function parseOllamaChatEvent(line: string): {
  message?: { content?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
} {
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed === "object" && parsed !== null) return parsed;
  } catch {
    // Converted below.
  }
  throw new ModelRuntimeError("INFERENCE_FAILED", "Ollama returned malformed stream data.", true);
}

function responseError(status: number, body: unknown): ModelRuntimeError {
  const error = typeof body === "object" && body !== null && "error" in body ? body.error : null;
  const record =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  return new ModelRuntimeError(
    typeof record.code === "string"
      ? record.code
      : status === 401
        ? "INFERENCE_AUTHENTICATION_FAILED"
        : "INFERENCE_SERVICE_UNAVAILABLE",
    typeof record.message === "string" ? record.message : "Vercel inference rejected the request.",
    typeof record.retryable === "boolean" ? record.retryable : status >= 500
  );
}

function normalizeBaseUrl(value: string, name: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    !(process.env.NODE_ENV !== "production" && url.protocol === "http:")
  ) {
    throw new Error(`${name} must use https.`);
  }
  if (url.username !== "" || url.password !== "")
    throw new Error(`${name} must not include credentials.`);
  return url;
}

export function normalizeModelText(content: string): string {
  if (content.trim() === "") return "";
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.type === "tool" && typeof parsed.toolName === "string") return content;
    if (
      (parsed.type === "response" || parsed.type === "clarification") &&
      typeof parsed.message === "string"
    )
      return content;
    if (typeof parsed.toolName === "string") return JSON.stringify({ ...parsed, type: "tool" });
    const message = [
      parsed.message,
      parsed.response,
      parsed.content,
      parsed.text,
      parsed.answer
    ].find((value): value is string => typeof value === "string" && value.trim() !== "");
    return message === undefined
      ? content
      : JSON.stringify({ type: "response", message: message.trim() });
  } catch {
    return JSON.stringify({ type: "response", message: content.trim() });
  }
}
