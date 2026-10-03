import { timingSafeEqual } from "node:crypto";
import type {
  InferenceExecutionEvent,
  InferenceExecutionRequest,
  ResolvedModelArtifact
} from "@grogoni/shared-types";

import { downloadVerifiedArtifact } from "./artifact-loader.js";
import { generateWithHuggingFace, type HuggingFaceRuntimeConfig } from "./huggingface-runtime.js";
import { loadLlamaRuntime, type LoadedLlamaRuntime } from "./llama-runtime.js";
import { RuntimeCache } from "./runtime-cache.js";
import { InferenceServiceError } from "./service-error.js";

export interface VercelInferenceConfig {
  serviceToken: string;
  /**
   * The default engine for any model id that Hugging Face routing (below) does not claim. Kept as
   * a top-level field (not folded into `huggingFace`) for backward compatibility with the
   * pre-hybrid deployment-wide switch: setting `INFERENCE_PROVIDER=huggingface` still means "route
   * everything through Hugging Face, falling back to HF_MODEL_ID for unmapped ids" exactly as
   * before. `HF_MODEL_MAP` now works standalone under the *default* `llama-cpp` provider too: any
   * model id present in it is routed to Hugging Face for that one request while every other id
   * keeps using the local GGUF/llama.cpp path in the same deployment - see resolveInferenceEngine.
   */
  provider: "llama-cpp" | "huggingface";
  artifactAllowedHosts: ReadonlySet<string>;
  maximumArtifactBytes: number;
  maximumInputCharacters: number;
  maximumOutputTokens: number;
  cacheEntries: number;
  huggingFace:
    | (Omit<HuggingFaceRuntimeConfig, "modelId"> & {
        defaultModelId: string | null;
        models: ReadonlyMap<string, string>;
      })
    | null;
  /**
   * When true, a confirmed Hugging Face budget-exhaustion response (HTTP 402) permanently disables
   * further Hugging Face requests for the lifetime of this process instead of continuing to spend.
   * This is an application-side backstop only - it does not talk to Hugging Face's billing API and
   * cannot enforce a dollar limit there, does not coordinate across concurrent serverless
   * instances, and resets on cold start. The administrator must additionally configure a real
   * spending limit in the Hugging Face billing dashboard; see docs/architecture/huggingface-inference.md.
   */
  huggingFaceFreeTierOnly: boolean;
}

/** `resolveInferenceEngine`'s per-request routing decision. See VercelInferenceConfig.provider. */
export type InferenceEngineResolution =
  { engine: "llama-cpp" } | { engine: "huggingface"; huggingFaceModelId: string };

/**
 * Decides, per request, which engine actually serves a given Grogoni model id - the concurrency this
 * module adds over the pre-hybrid design, where the whole deployment was hard-wired to exactly one
 * engine. A model id present in HF_MODEL_MAP always routes to Hugging Face regardless of
 * `config.provider`. When `config.provider === "huggingface"` (the legacy exclusive mode), an
 * unmapped id still falls back to HF_MODEL_ID if one is configured, preserving that mode's original
 * behavior exactly. Otherwise (the default `llama-cpp` provider with an unmapped id) the request
 * proceeds down the GGUF/llama.cpp path, unchanged from before Hugging Face routing existed at all.
 */
export function resolveInferenceEngine(
  config: Pick<VercelInferenceConfig, "provider" | "huggingFace">,
  modelId: string
): InferenceEngineResolution {
  if (config.huggingFace !== null) {
    const mapped = config.huggingFace.models.get(modelId);
    if (mapped !== undefined) return { engine: "huggingface", huggingFaceModelId: mapped };
    if (config.provider === "huggingface" && config.huggingFace.defaultModelId !== null) {
      return { engine: "huggingface", huggingFaceModelId: config.huggingFace.defaultModelId };
    }
    if (config.provider === "huggingface") {
      throw new InferenceServiceError(
        "MODEL_NOT_FOUND",
        `No Hugging Face model is configured for ${modelId}.`,
        false,
        422
      );
    }
  }
  return { engine: "llama-cpp" };
}

export interface VercelInferenceDependencies {
  cache?: RuntimeCache<LoadedLlamaRuntime>;
  downloadArtifact?: typeof downloadVerifiedArtifact;
  loadRuntime?: typeof loadLlamaRuntime;
  generateWithHuggingFace?: typeof generateWithHuggingFace;
  request?: typeof fetch;
  now?: () => number;
}

export function readVercelInferenceConfig(
  environment: NodeJS.ProcessEnv = process.env
): VercelInferenceConfig {
  const serviceToken = environment.GROGONI_INFERENCE_SERVICE_TOKEN?.trim() ?? "";
  if (serviceToken.length < 32) {
    throw new Error("GROGONI_INFERENCE_SERVICE_TOKEN must contain at least 32 characters.");
  }
  const provider = providerValue(environment.INFERENCE_PROVIDER);
  const hosts = (environment.MODEL_ARTIFACT_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (provider === "llama-cpp" && hosts.length === 0) {
    throw new Error("MODEL_ARTIFACT_ALLOWED_HOSTS must contain at least one hostname.");
  }
  // Hugging Face config is built whenever HF_TOKEN is set, not only when it is the sole/exclusive
  // provider - this is what makes hybrid concurrent routing possible under the default `llama-cpp`
  // provider (see resolveInferenceEngine). Deployments that never set HF_TOKEN see byte-for-byte
  // the same config shape as before this change (huggingFace: null).
  const huggingFaceTokenConfigured = (environment.HF_TOKEN?.trim() ?? "") !== "";
  return {
    serviceToken,
    provider,
    artifactAllowedHosts: new Set(hosts),
    maximumArtifactBytes: positiveInteger(environment.VERCEL_MAX_ARTIFACT_BYTES, 450_000_000),
    maximumInputCharacters: positiveInteger(environment.INFERENCE_MAX_INPUT_CHARACTERS, 64_000),
    maximumOutputTokens: positiveInteger(environment.INFERENCE_MAX_OUTPUT_TOKENS, 512),
    cacheEntries: positiveInteger(environment.INFERENCE_RUNTIME_CACHE_ENTRIES, 1),
    huggingFace:
      provider === "huggingface" || huggingFaceTokenConfigured
        ? {
            token: requiredSecret(environment.HF_TOKEN, "HF_TOKEN"),
            defaultModelId: optionalText(environment.HF_MODEL_ID),
            models: huggingFaceModelMap(environment.HF_MODEL_MAP, environment.HF_MODEL_ID),
            baseUrl: optionalUrl(
              environment.HF_INFERENCE_BASE_URL,
              "https://router.huggingface.co/v1/"
            )
          }
        : null,
    huggingFaceFreeTierOnly: booleanFlag(environment.HF_FREE_TIER_ONLY)
  };
}

export function createVercelInferenceHandler(
  config: VercelInferenceConfig,
  dependencies: VercelInferenceDependencies = {}
): (request: Request) => Promise<Response> {
  const cache = dependencies.cache ?? new RuntimeCache<LoadedLlamaRuntime>(config.cacheEntries);
  const downloadArtifact = dependencies.downloadArtifact ?? downloadVerifiedArtifact;
  const loadRuntime = dependencies.loadRuntime ?? loadLlamaRuntime;
  const generateHf = dependencies.generateWithHuggingFace ?? generateWithHuggingFace;
  const now = dependencies.now ?? Date.now;
  // Process-lifetime latch for HF_FREE_TIER_ONLY (see VercelInferenceConfig.huggingFaceFreeTierOnly).
  // Deliberately outside the per-request closure below so it persists across requests handled by
  // this same warm serverless instance, and deliberately not reset by anything short of a redeploy
  // or cold start - "stop when spending cannot be bounded reliably" means stop, not back off and
  // retry the paid path again on the next message.
  let huggingFaceBudgetExhausted = false;

  return async (request) => {
    if (request.method !== "POST")
      return errorResponse(405, "METHOD_NOT_ALLOWED", "Use POST.", false);
    if (!validBearer(request.headers.get("authorization"), config.serviceToken)) {
      return errorResponse(
        401,
        "INFERENCE_AUTHENTICATION_FAILED",
        "Inference service authentication failed.",
        false
      );
    }
    const maximumBodyBytes = config.maximumInputCharacters * 4 + 8_192;
    const declaredBodyBytes = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredBodyBytes) && declaredBodyBytes > maximumBodyBytes) {
      return errorResponse(413, "INVALID_INFERENCE_REQUEST", "Request body is too large.", false);
    }
    let input: InferenceExecutionRequest;
    let routing: InferenceEngineResolution;
    try {
      const parsed = parseRequest(await request.json(), config);
      input = parsed.request;
      routing = parsed.routing;
      if (
        routing.engine === "huggingface" &&
        config.huggingFaceFreeTierOnly &&
        huggingFaceBudgetExhausted
      ) {
        throw new InferenceServiceError(
          "INFERENCE_BUDGET_EXHAUSTED",
          "Hugging Face free-tier inference credit was already exhausted this session; refusing " +
            "further requests instead of spending beyond it. An administrator must raise the " +
            "budget or disable HF_FREE_TIER_ONLY to resume.",
          false,
          402
        );
      }
    } catch (error) {
      return serviceErrorResponse(error);
    }
    const startedAt = now();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (event: InferenceExecutionEvent) =>
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        void (async () => {
          let firstTokenAt: number | null = null;
          try {
            emit({ type: "status", state: "INITIALIZING" });
            const loadStartedAt = now();
            const acquired =
              routing.engine === "huggingface"
                ? null
                : await cache.acquire(
                    `${input.model.id}:${input.artifact!.sha256 ?? input.artifact!.id}`,
                    async () => {
                      emit({ type: "status", state: "MODEL_LOADING" });
                      const downloaded = await downloadArtifact({
                        artifact: input.artifact!,
                        allowedHosts: config.artifactAllowedHosts,
                        maximumBytes: config.maximumArtifactBytes,
                        ...(dependencies.request === undefined
                          ? {}
                          : { request: dependencies.request }),
                        signal: request.signal
                      });
                      return loadRuntime(downloaded.path);
                    }
                  );
            const modelLoadMs = routing.engine === "huggingface" ? 0 : now() - loadStartedAt;
            emit({ type: "status", state: "READY", cacheHit: acquired?.cacheHit ?? false });
            const inferenceStartedAt = now();
            const onText = (text: string) => {
              firstTokenAt ??= now();
              emit({ type: "delta", text });
            };
            const result =
              routing.engine === "huggingface"
                ? await generateHf(
                    {
                      ...config.huggingFace!,
                      modelId: routing.huggingFaceModelId,
                      // A business's own authorized credential (input.providerCredential) takes
                      // priority over the platform's configured HF_TOKEN for this one request -
                      // never the reverse, and never a silent fallback between the two (Part G/H).
                      token: input.providerCredential?.token ?? config.huggingFace!.token
                    },
                    {
                      prompt: input.prompt,
                      maximumTokens: input.generation.maxTokens,
                      temperature: input.generation.temperature,
                      jsonOutput: input.generation.jsonOutput,
                      signal: request.signal,
                      onText
                    },
                    dependencies.request
                  ).catch((error: unknown) => {
                    if (
                      config.huggingFaceFreeTierOnly &&
                      error instanceof InferenceServiceError &&
                      error.code === "INFERENCE_BUDGET_EXHAUSTED"
                    ) {
                      huggingFaceBudgetExhausted = true;
                    }
                    throw error;
                  })
                : await acquired!.runtime.generate({
                    prompt: input.prompt,
                    maximumTokens: input.generation.maxTokens,
                    temperature: input.generation.temperature,
                    signal: request.signal,
                    onText
                  });
            const completedAt = now();
            const cacheHit = acquired?.cacheHit ?? false;
            const metrics = {
              modelDownloadMs: cacheHit ? 0 : modelLoadMs,
              modelLoadMs,
              firstTokenMs: firstTokenAt === null ? null : firstTokenAt - startedAt,
              inferenceMs: completedAt - inferenceStartedAt,
              totalMs: completedAt - startedAt,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              cacheHit
            };
            emit({
              type: "result",
              requestId: input.requestId,
              text: result.text,
              finishReason: result.finishReason,
              usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
              metrics
            });
            console.info(
              JSON.stringify({
                event: "inference.completed",
                requestId: input.requestId,
                conversationId: input.conversationId,
                runtimeBindingId: input.runtimeBindingId,
                agentId: input.agent.id,
                modelId: input.model.id,
                provider: routing.engine,
                usedOwnCredential: input.providerCredential !== undefined,
                artifactId: input.artifact?.id ?? null,
                executionHostId: input.executionHostId,
                ...metrics
              })
            );
          } catch (error) {
            const normalized = normalizeError(error);
            emit({
              type: "error",
              code: normalized.code,
              message: normalized.message,
              retryable: normalized.retryable
            });
          } finally {
            controller.close();
          }
        })();
      },
      cancel() {
        // Request.signal is propagated into download and generation by the platform.
      }
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store, no-transform",
        "x-content-type-options": "nosniff",
        "x-request-id": input.requestId
      }
    });
  };
}

/**
 * Bare process/function liveness. Deliberately takes no configuration and cannot fail because of
 * environment misconfiguration - it answers "is this Vercel function executing at all", nothing
 * about whether inference can actually run. See createVercelReadyHandler for that.
 */
export function createVercelHealthHandler(): () => Response {
  return () =>
    Response.json(
      { ok: true, service: "grogoni-ai-runtime" },
      { headers: { "cache-control": "no-store" } }
    );
}

/**
 * Reports whether this function's own preconditions for serving inference are satisfied:
 * configuration parses (service token, artifact host allowlist, size/token limits). It does NOT
 * report per-model or per-artifact readiness - `/v1/inference` is a standalone Vercel serverless
 * function with its own memory, so this process can never observe whether a model is warm in the
 * function serving `/v1/inference`, and there is no fixed "the" model to preload (Render resolves
 * and sends the artifact per request; Vercel is not a model registry). It also never triggers a
 * model download/load - probing readiness must stay cheap. Real per-request model readiness is
 * proven end-to-end by Render's `/health/ai`, which performs an actual signed-artifact inference
 * call (see docs/deployment/vercel-inference.md).
 */
export function createVercelReadyHandler(
  environment: NodeJS.ProcessEnv = process.env
): () => Response {
  return () => {
    let config: VercelInferenceConfig;
    try {
      config = readVercelInferenceConfig(environment);
    } catch (error) {
      return Response.json(
        {
          ok: false,
          ready: false,
          service: "grogoni-ai-runtime",
          reason: error instanceof Error ? error.message : "Configuration is invalid."
        },
        { status: 503, headers: { "cache-control": "no-store" } }
      );
    }
    return Response.json(
      {
        ok: true,
        ready: true,
        service: "grogoni-ai-runtime",
        configured: true,
        capabilities: {
          formats: [
            ...(config.provider === "huggingface" ? [] : ["gguf"]),
            ...(config.huggingFace === null ? [] : ["huggingface-chat-completions"])
          ],
          streaming: true,
          harnesses: ["pi"]
        },
        provider: config.provider,
        // True once any model id is concurrently routable to Hugging Face in this deployment,
        // whether that's the legacy exclusive `INFERENCE_PROVIDER=huggingface` mode or the hybrid
        // `llama-cpp` + HF_MODEL_MAP mode this module added - see resolveInferenceEngine.
        huggingFaceConfigured: config.huggingFace !== null,
        huggingFaceFreeTierOnly: config.huggingFaceFreeTierOnly,
        huggingFaceModel: config.huggingFace?.defaultModelId ?? null,
        huggingFaceModels:
          config.huggingFace === null ? null : Object.fromEntries(config.huggingFace.models),
        artifactHosts: config.artifactAllowedHosts.size,
        maximumOutputTokens: config.maximumOutputTokens,
        cacheCapacity: config.cacheEntries
      },
      { headers: { "cache-control": "no-store" } }
    );
  };
}

function parseRequest(
  value: unknown,
  config: VercelInferenceConfig
): { request: InferenceExecutionRequest; routing: InferenceEngineResolution } {
  if (!record(value)) throw invalid("Request body must be an object.");
  const requestId = identifier(value.requestId, "requestId");
  const conversationId = identifier(value.conversationId, "conversationId");
  const runtimeBindingId = identifier(value.runtimeBindingId, "runtimeBindingId");
  const executionHostId = identifier(value.executionHostId, "executionHostId");
  if (!record(value.agent) || !record(value.model) || !record(value.generation)) {
    throw invalid("agent, model and generation are required.");
  }
  const agentId = identifier(value.agent.id, "agent.id");
  const adapterId = identifier(value.agent.adapterId, "agent.adapterId");
  if (adapterId !== "pi") {
    throw new InferenceServiceError(
      "AGENT_INITIALIZATION_FAILED",
      "The requested agent harness is unsupported.",
      false,
      422
    );
  }
  const modelId = identifier(value.model.id, "model.id");
  const routing = resolveInferenceEngine(config, modelId);
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  if (prompt === "" || prompt.length > config.maximumInputCharacters) {
    throw invalid("prompt is empty or too large.");
  }
  // Only the llama.cpp path needs a GGUF artifact to download; a Hugging Face-routed request has
  // nothing to fetch, so requiring one here would fail every hosted model that never had one to
  // begin with (see RuntimeModelDefinition.requiresArtifact).
  let artifact: ResolvedModelArtifact | undefined;
  if (routing.engine === "llama-cpp") {
    if (!record(value.artifact)) throw invalid("artifact is required for this model.");
    artifact = parseArtifact(value.artifact);
    if (artifact.modelId !== modelId) throw invalid("artifact.modelId must match model.id.");
  }
  const maxTokens = positiveIntegerValue(value.generation.maxTokens, "generation.maxTokens");
  if (maxTokens > config.maximumOutputTokens) throw invalid("generation.maxTokens is too large.");
  const temperature = value.generation.temperature;
  if (
    typeof temperature !== "number" ||
    !Number.isFinite(temperature) ||
    temperature < 0 ||
    temperature > 2
  ) {
    throw invalid("generation.temperature is invalid.");
  }
  if (value.generation.jsonOutput !== true && value.generation.jsonOutput !== false) {
    throw invalid("generation.jsonOutput must be boolean.");
  }
  const providerCredential = parseProviderCredential(value.providerCredential);
  return {
    request: {
      requestId,
      conversationId,
      runtimeBindingId,
      executionHostId,
      agent: { id: agentId, adapterId },
      model: {
        id: modelId,
        runtimeContractVersion: identifier(
          value.model.runtimeContractVersion,
          "model.runtimeContractVersion"
        )
      },
      ...(artifact === undefined ? {} : { artifact }),
      prompt,
      generation: { maxTokens, temperature, jsonOutput: value.generation.jsonOutput },
      ...(providerCredential === undefined ? {} : { providerCredential })
    },
    routing
  };
}

function parseProviderCredential(value: unknown): { token: string } | undefined {
  if (value === undefined || value === null) return undefined;
  if (!record(value) || typeof value.token !== "string" || value.token.trim() === "") {
    throw invalid("providerCredential.token must be a non-empty string when provided.");
  }
  return { token: value.token };
}

function parseArtifact(value: Record<string, unknown>): ResolvedModelArtifact {
  const nullableText = (field: string) =>
    value[field] === null ? null : identifier(value[field], `artifact.${field}`);
  const sizeBytes =
    value.sizeBytes === null ? null : positiveIntegerValue(value.sizeBytes, "artifact.sizeBytes");
  const status = value.status;
  if (status !== "available") throw invalid("artifact.status must be available.");
  return {
    id: identifier(value.id, "artifact.id"),
    modelId: identifier(value.modelId, "artifact.modelId"),
    storageProvider: identifier(value.storageProvider, "artifact.storageProvider"),
    bucket: identifier(value.bucket, "artifact.bucket"),
    objectKey: identifier(value.objectKey, "artifact.objectKey"),
    format: identifier(value.format, "artifact.format"),
    quantization: nullableText("quantization"),
    sizeBytes,
    sha256: nullableText("sha256"),
    contentType: identifier(value.contentType, "artifact.contentType"),
    status,
    createdAt: isoTimestamp(value.createdAt, "artifact.createdAt"),
    updatedAt: isoTimestamp(value.updatedAt, "artifact.updatedAt"),
    downloadUrl: urlString(value.downloadUrl, "artifact.downloadUrl"),
    expiresAt: isoTimestamp(value.expiresAt, "artifact.expiresAt")
  };
}

export function validBearer(header: string | null, expected: string): boolean {
  if (header === null || !header.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7), "utf8");
  const target = Buffer.from(expected, "utf8");
  return actual.length === target.length && timingSafeEqual(actual, target);
}

function serviceErrorResponse(error: unknown): Response {
  const normalized = normalizeError(error);
  return errorResponse(
    normalized.status,
    normalized.code,
    normalized.message,
    normalized.retryable
  );
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  retryable: boolean
): Response {
  return Response.json(
    { ok: false, error: { code, message, retryable } },
    { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } }
  );
}

function normalizeError(error: unknown): InferenceServiceError {
  return error instanceof InferenceServiceError
    ? error
    : new InferenceServiceError("INFERENCE_FAILED", "Inference failed.", true, 500, {
        cause: error
      });
}

function invalid(message: string): InferenceServiceError {
  return new InferenceServiceError("INVALID_INFERENCE_REQUEST", message, false, 400);
}

function identifier(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > 500 ||
    // eslint-disable-next-line no-control-regex -- deliberately rejects control characters
    /[\u0000-\u001f]/u.test(value)
  ) {
    throw invalid(`${name} is invalid.`);
  }
  return value;
}

function isoTimestamp(value: unknown, name: string): string {
  const text = identifier(value, name);
  if (!Number.isFinite(Date.parse(text))) throw invalid(`${name} is invalid.`);
  return text;
}

function urlString(value: unknown, name: string): string {
  const text = identifier(value, name);
  try {
    return new URL(text).toString();
  } catch {
    throw invalid(`${name} is invalid.`);
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  return positiveIntegerValue(Number(value), "configuration value");
}

function providerValue(value: string | undefined): VercelInferenceConfig["provider"] {
  const normalized = value?.trim().toLowerCase() || "llama-cpp";
  if (normalized === "llama-cpp" || normalized === "huggingface") return normalized;
  throw new Error("INFERENCE_PROVIDER must be either llama-cpp or huggingface.");
}

function booleanFlag(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function requiredSecret(value: string | undefined, name: string): string {
  const text = requiredText(value, name);
  if (text.length < 8) throw new Error(`${name} must be configured.`);
  return text;
}

function requiredText(value: string | undefined, name: string): string {
  const text = value?.trim() ?? "";
  if (text === "") throw new Error(`${name} must be configured.`);
  return text;
}

function optionalText(value: string | undefined): string | null {
  const text = value?.trim() ?? "";
  return text === "" ? null : text;
}

function huggingFaceModelMap(
  value: string | undefined,
  fallbackModelId: string | undefined
): ReadonlyMap<string, string> {
  const text = value?.trim() ?? "";
  if (text === "") {
    if (optionalText(fallbackModelId) === null) {
      throw new Error("HF_MODEL_MAP or HF_MODEL_ID must be configured.");
    }
    return new Map();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      "HF_MODEL_MAP must be a JSON object of Grogoni model IDs to Hugging Face model IDs."
    );
  }
  if (!record(parsed) || Object.keys(parsed).length === 0) {
    throw new Error("HF_MODEL_MAP must contain at least one model mapping.");
  }
  const models = new Map<string, string>();
  for (const [grogoniModelId, huggingFaceModelId] of Object.entries(parsed)) {
    if (
      grogoniModelId.trim() === "" ||
      typeof huggingFaceModelId !== "string" ||
      huggingFaceModelId.trim() === ""
    ) {
      throw new Error("HF_MODEL_MAP keys and values must be non-empty strings.");
    }
    models.set(grogoniModelId, huggingFaceModelId.trim());
  }
  return models;
}

function optionalUrl(value: string | undefined, fallback: string): string {
  const text = value?.trim() || fallback;
  return new URL(text).toString();
}

function positiveIntegerValue(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw invalid(`${name} must be a positive integer.`);
  }
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
