import type {
  InferenceChunk,
  InferenceFinishReason,
  InferenceMessage,
  InferenceProvider,
  InferenceRequest,
  InferenceResponse,
  InferenceUsage,
  ModelDefinition,
  ProviderHealth,
  ProviderHealthContext,
  ResolvedCredential,
  ToolCall
} from "./contract.js";
import { requiredCapabilities } from "./contract.js";
import {
  strictEndpointPolicy,
  validateProviderEndpoint,
  type EndpointPolicy
} from "./endpoint-policy.js";
import {
  healthStatusForError,
  InferenceError,
  inferenceErrorFromHttp,
  toInferenceError
} from "./errors.js";
import type { DeviceInferenceBroker } from "../device-inference-broker.js";
import type { ProviderTransport } from "./http-transport.js";
import { createDeadline, readBodyText, withProviderDeadline } from "./provider-call.js";
import type { InferenceProviderConfig } from "./provider-config.js";
import { readSse } from "./sse.js";
import { decodeToolName, encodeToolName, parseToolArguments } from "./tool-names.js";

export interface ProviderAdapterDeps {
  /** Returns a transport enforcing the given endpoint policy (see http-transport.ts). */
  transportFor: (policy: EndpointPolicy) => ProviderTransport;
  now?: () => number;
  /** Hands device-local generation to members' devices (local provider only). */
  deviceBroker?: DeviceInferenceBroker;
}

/**
 * One implementation for every server that speaks the OpenAI chat-completions wire format:
 * OpenAI itself, Z.ai's general API, llama.cpp's llama-server, vLLM, LocalAI, SGLang, and
 * third-party gateways. Vendor differences are configuration (base URL, max-tokens parameter name,
 * verification method), never a code branch per vendor.
 */
export function createOpenAiCompatibleProvider(
  config: InferenceProviderConfig,
  deps: ProviderAdapterDeps
): InferenceProvider {
  const now = deps.now ?? Date.now;
  const configuredPolicy: EndpointPolicy = {
    allowHttp: config.allowHttp,
    allowPrivateNetwork: config.allowPrivateNetwork
  };
  const maxTokensParameter = config.options.maxTokensParameter ?? "max_tokens";

  function endpointFor(credential: ResolvedCredential | null): {
    base: URL;
    transport: ProviderTransport;
  } {
    if (credential?.baseUrlOverride !== undefined) {
      if (!config.allowCredentialEndpoint) {
        throw new InferenceError("ENDPOINT_FORBIDDEN", {
          providerId: config.id,
          diagnostic: "This provider does not accept per-credential endpoints."
        });
      }
      return {
        base: validateProviderEndpoint(credential.baseUrlOverride, strictEndpointPolicy),
        transport: deps.transportFor(strictEndpointPolicy)
      };
    }
    if (config.baseUrl === null) {
      throw new InferenceError("PROVIDER_MISCONFIGURED", {
        providerId: config.id,
        diagnostic: "Provider has no base URL."
      });
    }
    return {
      base: validateProviderEndpoint(config.baseUrl, configuredPolicy),
      transport: deps.transportFor(configuredPolicy)
    };
  }

  function headers(credential: ResolvedCredential | null, stream = false): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
      "user-agent": "grogoni-inference",
      ...(credential === null ? {} : { authorization: `Bearer ${credential.secret.reveal()}` })
    };
  }

  function secretsOf(credential: ResolvedCredential | null): string[] {
    return credential === null ? [] : [credential.secret.reveal()];
  }

  function requireCredentialIfManagedProvider(context: { credential: ResolvedCredential | null }) {
    // Self-hosted compatible servers may legitimately run without auth (llama-server without
    // --api-key on a private network). Hosted vendors always need a key.
    if (context.credential === null && (config.type === "openai" || config.type === "zai")) {
      throw new InferenceError("CREDENTIAL_MISSING", { providerId: config.id });
    }
  }

  async function post(
    path: string,
    body: Record<string, unknown>,
    context: { credential: ResolvedCredential | null; signal: AbortSignal; stream?: boolean },
    modelId: string
  ): Promise<Response> {
    const { base, transport } = endpointFor(context.credential);
    const response = await transport(new URL(path, base), {
      method: "POST",
      headers: headers(context.credential, context.stream === true),
      body: JSON.stringify(body),
      signal: context.signal
    });
    if (!response.ok) {
      throw inferenceErrorFromHttp({
        providerId: config.id,
        modelId,
        status: response.status,
        bodyText: await readBodyText(response),
        retryAfterHeader: response.headers.get("retry-after"),
        secrets: secretsOf(context.credential)
      });
    }
    return response;
  }

  const provider: InferenceProvider = {
    id: config.id,

    async supports(model: ModelDefinition, request?: InferenceRequest) {
      if (!config.enabled || model.providerId !== config.id || !model.enabled) return false;
      if (model.executionTarget !== config.executionTarget) return false;
      const needed = request === undefined ? (["text"] as const) : requiredCapabilities(request);
      return needed.every(
        (capability) =>
          model.capabilities[capability] === true && config.capabilities[capability] !== false
      );
    },

    async health(context?: ProviderHealthContext): Promise<ProviderHealth> {
      const startedAt = now();
      const checkedAt = new Date(startedAt).toISOString();
      const credential = context?.credential ?? null;
      if (!config.enabled) {
        return {
          providerId: config.id,
          status: "UNAVAILABLE",
          checkedAt,
          errorCode: "PROVIDER_DISABLED"
        };
      }
      try {
        requireCredentialIfManagedProvider({ credential });
        endpointFor(credential);
        if (config.verification === "none") {
          return { providerId: config.id, status: "AVAILABLE", checkedAt, latencyMs: 0 };
        }
        await withProviderDeadline(
          {
            timeoutMs: context?.timeoutMs ?? 10_000,
            ...(context?.signal === undefined ? {} : { signal: context.signal }),
            providerId: config.id,
            secrets: secretsOf(credential)
          },
          async (signal) => {
            if (config.verification === "models-endpoint") {
              const { base, transport } = endpointFor(credential);
              const response = await transport(new URL("models", base), {
                method: "GET",
                headers: headers(credential),
                signal
              });
              if (!response.ok) {
                throw inferenceErrorFromHttp({
                  providerId: config.id,
                  status: response.status,
                  bodyText: await readBodyText(response),
                  retryAfterHeader: response.headers.get("retry-after"),
                  secrets: secretsOf(credential)
                });
              }
              await readBodyText(response, 1_000);
              return;
            }
            if (context?.probeModelId === undefined) {
              throw new InferenceError("PROVIDER_MISCONFIGURED", {
                providerId: config.id,
                diagnostic: "Minimal-completion verification needs a probe model."
              });
            }
            // Cheapest safe verification this provider offers: one output token, no tools.
            const response = await post(
              "chat/completions",
              {
                model: context.probeModelId,
                messages: [{ role: "user", content: "ping" }],
                [maxTokensParameter]: 1
              },
              { credential, signal },
              context.probeModelId
            );
            await readBodyText(response, 1_000);
          }
        );
        return {
          providerId: config.id,
          status: "AVAILABLE",
          checkedAt,
          latencyMs: now() - startedAt
        };
      } catch (error) {
        const normalized = toInferenceError(error, {
          providerId: config.id,
          secrets: secretsOf(credential)
        });
        return {
          providerId: config.id,
          status: healthStatusForError(normalized),
          checkedAt,
          latencyMs: now() - startedAt,
          errorCode: normalized.code,
          message: normalized.message
        };
      }
    },

    async generate(request, context) {
      requireCredentialIfManagedProvider(context);
      const startedAt = now();
      return withProviderDeadline(
        {
          timeoutMs: context.timeoutMs,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          providerId: config.id,
          modelId: context.model.id,
          secrets: secretsOf(context.credential)
        },
        async (signal) => {
          const response = await post(
            "chat/completions",
            toChatCompletionBody(request, context.model, maxTokensParameter, false),
            { credential: context.credential, signal },
            context.model.id
          );
          let json: unknown;
          try {
            json = await response.json();
          } catch (error) {
            throw new InferenceError("INVALID_PROVIDER_RESPONSE", {
              providerId: config.id,
              modelId: context.model.id,
              cause: error
            });
          }
          return fromChatCompletion(json, {
            request,
            providerId: config.id,
            providerRequestId: response.headers.get("x-request-id"),
            totalMs: now() - startedAt
          });
        }
      );
    },

    async *stream(request, context): AsyncIterable<InferenceChunk> {
      requireCredentialIfManagedProvider(context);
      const startedAt = now();
      const deadline = createDeadline(context.timeoutMs, context.signal);
      const secrets = secretsOf(context.credential);
      try {
        const response = await post(
          "chat/completions",
          toChatCompletionBody(request, context.model, maxTokensParameter, true),
          { credential: context.credential, signal: deadline.signal, stream: true },
          context.model.id
        );
        if (response.body === null) {
          throw new InferenceError("INVALID_PROVIDER_RESPONSE", {
            providerId: config.id,
            modelId: context.model.id
          });
        }
        const accumulator = createStreamAccumulator();
        let firstTokenMs: number | undefined;
        let providerRequestId = response.headers.get("x-request-id");
        for await (const message of readSse(response.body)) {
          if (message.data === "[DONE]") break;
          const chunk = parseJsonObject(message.data);
          if (chunk === null) continue;
          if (isRecord(chunk.error)) {
            throw inferenceErrorFromHttp({
              providerId: config.id,
              modelId: context.model.id,
              status: 502,
              bodyText: JSON.stringify(chunk.error),
              secrets
            });
          }
          if (providerRequestId === null && typeof chunk.id === "string")
            providerRequestId = chunk.id;
          for (const event of accumulator.push(chunk)) {
            if (firstTokenMs === undefined && event.type !== "usage")
              firstTokenMs = now() - startedAt;
            yield event;
          }
        }
        yield {
          type: "completed",
          response: accumulator.finish({
            request,
            providerId: config.id,
            providerRequestId,
            totalMs: now() - startedAt,
            ...(firstTokenMs === undefined ? {} : { firstTokenMs })
          })
        };
      } catch (error) {
        throw toInferenceError(error, {
          providerId: config.id,
          modelId: context.model.id,
          secrets,
          timedOut: deadline.timedOut()
        });
      } finally {
        deadline.dispose();
      }
    }
  };
  return provider;
}

/** Canonical request -> OpenAI chat-completions body. Exported for adapter tests. */
export function toChatCompletionBody(
  request: InferenceRequest,
  model: ModelDefinition,
  maxTokensParameter: "max_tokens" | "max_completion_tokens",
  stream: boolean
): Record<string, unknown> {
  const generation = request.generation ?? {};
  const maxTokens = clampMaxTokens(generation.maxOutputTokens, model.maxOutputTokens);
  return {
    model: model.providerModelId,
    messages: request.messages.map(toWireMessage),
    ...(generation.temperature === undefined ? {} : { temperature: generation.temperature }),
    ...(generation.topP === undefined ? {} : { top_p: generation.topP }),
    ...(generation.stop === undefined || generation.stop.length === 0
      ? {}
      : { stop: generation.stop }),
    ...(maxTokens === undefined ? {} : { [maxTokensParameter]: maxTokens }),
    ...(request.tools === undefined || request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: {
              name: encodeToolName(tool.name),
              description: tool.description,
              parameters: tool.inputSchema
            }
          })),
          tool_choice: "auto"
        }),
    ...(request.responseFormat === undefined || request.responseFormat.type === "text"
      ? {}
      : request.responseFormat.type === "json_object"
        ? { response_format: { type: "json_object" } }
        : {
            response_format: {
              type: "json_schema",
              json_schema: {
                name: request.responseFormat.name,
                schema: request.responseFormat.schema,
                strict: false
              }
            }
          }),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {})
  };
}

function toWireMessage(message: InferenceMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId ?? "",
      content:
        typeof message.content === "string" ? message.content : JSON.stringify(message.content)
    };
  }
  const content =
    typeof message.content === "string"
      ? message.content
      : message.content.map((part) =>
          part.type === "text"
            ? { type: "text", text: part.text }
            : { type: "image_url", image_url: { url: part.url } }
        );
  return {
    role: message.role,
    content,
    ...(message.role === "assistant" &&
    message.toolCalls !== undefined &&
    message.toolCalls.length > 0
      ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: encodeToolName(call.name), arguments: JSON.stringify(call.arguments) }
          }))
        }
      : {})
  };
}

/** OpenAI chat-completions JSON -> canonical response. Exported for adapter tests. */
export function fromChatCompletion(
  json: unknown,
  meta: {
    request: InferenceRequest;
    providerId: string;
    providerRequestId: string | null;
    totalMs: number;
  }
): InferenceResponse {
  const record = isRecord(json) ? json : null;
  const choice =
    Array.isArray(record?.choices) && isRecord(record.choices[0]) ? record.choices[0] : null;
  const message = choice !== null && isRecord(choice.message) ? choice.message : null;
  if (record === null || choice === null || message === null) {
    throw new InferenceError("INVALID_PROVIDER_RESPONSE", {
      providerId: meta.providerId,
      modelId: meta.request.modelId
    });
  }
  const toolCalls: ToolCall[] = Array.isArray(message.tool_calls)
    ? message.tool_calls.filter(isRecord).flatMap((call, index) => {
        const fn = isRecord(call.function) ? call.function : null;
        if (fn === null || typeof fn.name !== "string") return [];
        return [
          {
            id: typeof call.id === "string" ? call.id : `call_${index}`,
            name: decodeToolName(fn.name),
            arguments: parseToolArguments(fn.arguments)
          }
        ];
      })
    : [];
  const text = typeof message.content === "string" ? message.content : "";
  const usage = usageFrom(record.usage);
  const providerRequestId =
    meta.providerRequestId ?? (typeof record.id === "string" ? record.id : null);
  return {
    requestId: meta.request.requestId,
    providerId: meta.providerId,
    modelId: meta.request.modelId,
    output: { text, toolCalls },
    finishReason: finishReasonFrom(choice.finish_reason),
    ...(usage === undefined ? {} : { usage }),
    latency: { totalMs: meta.totalMs },
    ...(providerRequestId === null ? {} : { providerRequestId })
  };
}

function usageFrom(value: unknown): InferenceUsage | undefined {
  if (!isRecord(value)) return undefined;
  const details = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : {};
  return {
    ...(typeof value.prompt_tokens === "number" ? { inputTokens: value.prompt_tokens } : {}),
    ...(typeof value.completion_tokens === "number"
      ? { outputTokens: value.completion_tokens }
      : {}),
    ...(typeof value.total_tokens === "number" ? { totalTokens: value.total_tokens } : {}),
    ...(typeof details.cached_tokens === "number"
      ? { cachedInputTokens: details.cached_tokens }
      : {})
  };
}

function finishReasonFrom(value: unknown): InferenceFinishReason {
  switch (value) {
    case "stop":
    case "length":
    case "tool_calls":
    case "content_filter":
      return value;
    case "function_call":
      return "tool_calls";
    default:
      return "unknown";
  }
}

function createStreamAccumulator() {
  let text = "";
  let finishReason: InferenceFinishReason = "unknown";
  let usage: InferenceUsage | undefined;
  const calls = new Map<number, { id: string; name: string; args: string }>();
  return {
    push(chunk: Record<string, unknown>): InferenceChunk[] {
      const events: InferenceChunk[] = [];
      const streamedUsage = usageFrom(chunk.usage);
      if (streamedUsage !== undefined) {
        usage = streamedUsage;
        events.push({ type: "usage", usage: streamedUsage });
      }
      const choice =
        Array.isArray(chunk.choices) && isRecord(chunk.choices[0]) ? chunk.choices[0] : null;
      if (choice === null) return events;
      if (typeof choice.finish_reason === "string")
        finishReason = finishReasonFrom(choice.finish_reason);
      const delta = isRecord(choice.delta) ? choice.delta : null;
      if (delta === null) return events;
      if (typeof delta.content === "string" && delta.content !== "") {
        text += delta.content;
        events.push({ type: "text-delta", text: delta.content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const raw of delta.tool_calls.filter(isRecord)) {
          const index = typeof raw.index === "number" ? raw.index : 0;
          const fn = isRecord(raw.function) ? raw.function : {};
          const existing = calls.get(index) ?? { id: "", name: "", args: "" };
          if (typeof raw.id === "string") existing.id = raw.id;
          if (typeof fn.name === "string") existing.name += fn.name;
          const argumentsDelta = typeof fn.arguments === "string" ? fn.arguments : undefined;
          if (argumentsDelta !== undefined) existing.args += argumentsDelta;
          calls.set(index, existing);
          events.push({
            type: "tool-call-delta",
            index,
            ...(typeof raw.id === "string" ? { id: raw.id } : {}),
            ...(typeof fn.name === "string" ? { name: decodeToolName(fn.name) } : {}),
            ...(argumentsDelta === undefined ? {} : { argumentsDelta })
          });
        }
      }
      return events;
    },
    finish(meta: {
      request: InferenceRequest;
      providerId: string;
      providerRequestId: string | null;
      totalMs: number;
      firstTokenMs?: number;
    }): InferenceResponse {
      const toolCalls: ToolCall[] = [...calls.entries()]
        .sort(([left], [right]) => left - right)
        .filter(([, call]) => call.name !== "")
        .map(([index, call]) => ({
          id: call.id === "" ? `call_${index}` : call.id,
          name: decodeToolName(call.name),
          arguments: parseToolArguments(call.args)
        }));
      return {
        requestId: meta.request.requestId,
        providerId: meta.providerId,
        modelId: meta.request.modelId,
        output: { text, toolCalls },
        finishReason,
        ...(usage === undefined ? {} : { usage }),
        latency: {
          totalMs: meta.totalMs,
          ...(meta.firstTokenMs === undefined ? {} : { firstTokenMs: meta.firstTokenMs })
        },
        ...(meta.providerRequestId === null ? {} : { providerRequestId: meta.providerRequestId })
      };
    }
  };
}

export function clampMaxTokens(
  requested: number | undefined,
  modelLimit: number | undefined
): number | undefined {
  if (requested === undefined) return modelLimit;
  return modelLimit === undefined ? requested : Math.min(requested, modelLimit);
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** OpenAI: the compatible adapter with OpenAI's defaults. No model ids are hardcoded here. */
export function createOpenAiProvider(
  config: InferenceProviderConfig,
  deps: ProviderAdapterDeps
): InferenceProvider {
  return createOpenAiCompatibleProvider(
    {
      ...config,
      baseUrl: config.baseUrl ?? "https://api.openai.com/v1",
      options: { maxTokensParameter: "max_completion_tokens", ...config.options }
    },
    deps
  );
}

/**
 * Z.ai (GLM) general API. Defaults to the general endpoint; a coding-subscription endpoint must be
 * configured as its own provider id with its own billingProduct and is never substituted here.
 */
export function createZaiProvider(
  config: InferenceProviderConfig,
  deps: ProviderAdapterDeps
): InferenceProvider {
  return createOpenAiCompatibleProvider(
    { ...config, baseUrl: config.baseUrl ?? "https://api.z.ai/api/paas/v4" },
    deps
  );
}
