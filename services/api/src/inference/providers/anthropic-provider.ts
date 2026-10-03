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
  ResolvedCredential,
  ToolCall
} from "./contract.js";
import { messageText, requiredCapabilities } from "./contract.js";
import { validateProviderEndpoint, type EndpointPolicy } from "./endpoint-policy.js";
import {
  healthStatusForError,
  InferenceError,
  inferenceErrorFromHttp,
  toInferenceError
} from "./errors.js";
import { clampMaxTokens, type ProviderAdapterDeps } from "./openai-compatible-provider.js";
import { createDeadline, readBodyText, withProviderDeadline } from "./provider-call.js";
import type { InferenceProviderConfig } from "./provider-config.js";
import { readSse } from "./sse.js";
import { decodeToolName, encodeToolName, parseToolArguments } from "./tool-names.js";

const defaultAnthropicVersion = "2023-06-01";
// The Messages API requires max_tokens. Used only when neither the request nor the model record
// states a limit; the router normally supplies INFERENCE_MAX_OUTPUT_TOKENS.
const fallbackMaxTokens = 1024;

/**
 * Anthropic Messages API adapter. All Anthropic-specific semantics - top-level `system`, content
 * blocks, `tool_use`/`tool_result`, `input_schema`, SSE event names, `x-api-key` - are translated
 * here and nowhere else.
 */
export function createAnthropicProvider(
  config: InferenceProviderConfig,
  deps: ProviderAdapterDeps
): InferenceProvider {
  const now = deps.now ?? Date.now;
  const policy: EndpointPolicy = {
    allowHttp: config.allowHttp,
    allowPrivateNetwork: config.allowPrivateNetwork
  };
  const transport = deps.transportFor(policy);
  const version = config.options.anthropicVersion ?? defaultAnthropicVersion;

  function base(): URL {
    return validateProviderEndpoint(config.baseUrl ?? "https://api.anthropic.com/v1", policy);
  }

  function headers(credential: ResolvedCredential, stream = false): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
      "anthropic-version": version,
      "x-api-key": credential.secret.reveal(),
      "user-agent": "grogoni-inference"
    };
  }

  function requireCredential(credential: ResolvedCredential | null): ResolvedCredential {
    if (credential === null)
      throw new InferenceError("CREDENTIAL_MISSING", { providerId: config.id });
    return credential;
  }

  async function postMessages(
    body: Record<string, unknown>,
    credential: ResolvedCredential,
    signal: AbortSignal,
    modelId: string,
    stream: boolean
  ): Promise<Response> {
    const response = await transport(new URL("messages", base()), {
      method: "POST",
      headers: headers(credential, stream),
      body: JSON.stringify(body),
      signal
    });
    if (!response.ok) {
      throw inferenceErrorFromHttp({
        providerId: config.id,
        modelId,
        status: response.status,
        bodyText: await readBodyText(response),
        retryAfterHeader: response.headers.get("retry-after"),
        secrets: [credential.secret.reveal()]
      });
    }
    return response;
  }

  return {
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

    async health(context): Promise<ProviderHealth> {
      const startedAt = now();
      const checkedAt = new Date(startedAt).toISOString();
      if (!config.enabled) {
        return {
          providerId: config.id,
          status: "UNAVAILABLE",
          checkedAt,
          errorCode: "PROVIDER_DISABLED"
        };
      }
      const credential = context?.credential ?? null;
      try {
        const resolved = requireCredential(credential);
        // GET /v1/models is free and verifies the key without generating anything.
        await withProviderDeadline(
          {
            timeoutMs: context?.timeoutMs ?? 10_000,
            ...(context?.signal === undefined ? {} : { signal: context.signal }),
            providerId: config.id,
            secrets: [resolved.secret.reveal()]
          },
          async (signal) => {
            const response = await transport(new URL("models", base()), {
              method: "GET",
              headers: headers(resolved),
              signal
            });
            if (!response.ok) {
              throw inferenceErrorFromHttp({
                providerId: config.id,
                status: response.status,
                bodyText: await readBodyText(response),
                retryAfterHeader: response.headers.get("retry-after"),
                secrets: [resolved.secret.reveal()]
              });
            }
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
          secrets: credential === null ? [] : [credential.secret.reveal()]
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
      const credential = requireCredential(context.credential);
      const startedAt = now();
      return withProviderDeadline(
        {
          timeoutMs: context.timeoutMs,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          providerId: config.id,
          modelId: context.model.id,
          secrets: [credential.secret.reveal()]
        },
        async (signal) => {
          const response = await postMessages(
            toAnthropicBody(request, context.model, false),
            credential,
            signal,
            context.model.id,
            false
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
          return fromAnthropicMessage(json, {
            request,
            providerId: config.id,
            providerRequestId: response.headers.get("request-id"),
            totalMs: now() - startedAt
          });
        }
      );
    },

    async *stream(request, context): AsyncIterable<InferenceChunk> {
      const credential = requireCredential(context.credential);
      const startedAt = now();
      const deadline = createDeadline(context.timeoutMs, context.signal);
      const secrets = [credential.secret.reveal()];
      try {
        const response = await postMessages(
          toAnthropicBody(request, context.model, true),
          credential,
          deadline.signal,
          context.model.id,
          true
        );
        if (response.body === null) {
          throw new InferenceError("INVALID_PROVIDER_RESPONSE", {
            providerId: config.id,
            modelId: context.model.id
          });
        }
        let text = "";
        let finishReason: InferenceFinishReason = "unknown";
        const usage: InferenceUsage = {};
        let providerRequestId = response.headers.get("request-id");
        let firstTokenMs: number | undefined;
        const blocks = new Map<number, { id: string; name: string; json: string }>();
        for await (const message of readSse(response.body)) {
          const event = parseJson(message.data);
          if (event === null) continue;
          switch (event.type) {
            case "message_start": {
              const started = isRecord(event.message) ? event.message : {};
              if (providerRequestId === null && typeof started.id === "string") {
                providerRequestId = started.id;
              }
              Object.assign(usage, anthropicUsage(started.usage));
              break;
            }
            case "content_block_start": {
              const block = isRecord(event.content_block) ? event.content_block : {};
              const index = typeof event.index === "number" ? event.index : 0;
              if (block.type === "tool_use" && typeof block.name === "string") {
                const id = typeof block.id === "string" ? block.id : `toolu_${index}`;
                blocks.set(index, { id, name: block.name, json: "" });
                firstTokenMs ??= now() - startedAt;
                yield { type: "tool-call-delta", index, id, name: decodeToolName(block.name) };
              }
              break;
            }
            case "content_block_delta": {
              const delta = isRecord(event.delta) ? event.delta : {};
              const index = typeof event.index === "number" ? event.index : 0;
              if (delta.type === "text_delta" && typeof delta.text === "string") {
                text += delta.text;
                firstTokenMs ??= now() - startedAt;
                yield { type: "text-delta", text: delta.text };
              }
              if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
                const block = blocks.get(index);
                if (block !== undefined) block.json += delta.partial_json;
                yield { type: "tool-call-delta", index, argumentsDelta: delta.partial_json };
              }
              break;
            }
            case "message_delta": {
              const delta = isRecord(event.delta) ? event.delta : {};
              if (typeof delta.stop_reason === "string")
                finishReason = stopReason(delta.stop_reason);
              Object.assign(usage, anthropicUsage(event.usage));
              yield { type: "usage", usage: withTotal(usage) };
              break;
            }
            case "error": {
              throw inferenceErrorFromHttp({
                providerId: config.id,
                modelId: context.model.id,
                status: isOverloaded(event) ? 529 : 502,
                bodyText: JSON.stringify(event.error ?? {}),
                secrets
              });
            }
            default:
              break;
          }
        }
        const toolCalls: ToolCall[] = [...blocks.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, block]) => ({
            id: block.id,
            name: decodeToolName(block.name),
            arguments: parseToolArguments(block.json === "" ? "{}" : block.json)
          }));
        yield {
          type: "completed",
          response: {
            requestId: request.requestId,
            providerId: config.id,
            modelId: request.modelId,
            output: { text, toolCalls },
            finishReason,
            usage: withTotal(usage),
            latency: {
              totalMs: now() - startedAt,
              ...(firstTokenMs === undefined ? {} : { firstTokenMs })
            },
            ...(providerRequestId === null ? {} : { providerRequestId })
          }
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
}

/** Canonical request -> Anthropic Messages body. Exported for adapter tests. */
export function toAnthropicBody(
  request: InferenceRequest,
  model: ModelDefinition,
  stream: boolean
): Record<string, unknown> {
  const generation = request.generation ?? {};
  const systemParts = request.messages
    .filter((message) => message.role === "system")
    .map((message) => messageText(message.content));
  if (request.responseFormat !== undefined && request.responseFormat.type !== "text") {
    // The Messages API has no json_object switch; the contract is expressed as an instruction and
    // the router/agent validates the result exactly as it does for every other provider.
    systemParts.push(
      request.responseFormat.type === "json_schema"
        ? `Respond with only one JSON object matching this JSON Schema: ${JSON.stringify(request.responseFormat.schema)}`
        : "Respond with only one JSON object and no surrounding text."
    );
  }
  const messages = mergeConsecutiveRoles(
    request.messages.filter((message) => message.role !== "system").map(toAnthropicMessage)
  );
  return {
    model: model.providerModelId,
    max_tokens:
      clampMaxTokens(generation.maxOutputTokens, model.maxOutputTokens) ?? fallbackMaxTokens,
    messages,
    ...(systemParts.length === 0 ? {} : { system: systemParts.join("\n\n") }),
    ...(generation.temperature === undefined ? {} : { temperature: generation.temperature }),
    ...(generation.topP === undefined ? {} : { top_p: generation.topP }),
    ...(generation.stop === undefined || generation.stop.length === 0
      ? {}
      : { stop_sequences: generation.stop }),
    ...(request.tools === undefined || request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            name: encodeToolName(tool.name),
            description: tool.description,
            input_schema: tool.inputSchema
          }))
        }),
    ...(stream ? { stream: true } : {})
  };
}

function toAnthropicMessage(message: InferenceMessage): { role: string; content: unknown[] } {
  if (message.role === "tool") {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: message.toolCallId ?? "",
          content: messageText(message.content)
        }
      ]
    };
  }
  const parts: unknown[] =
    typeof message.content === "string"
      ? message.content === ""
        ? []
        : [{ type: "text", text: message.content }]
      : message.content.map((part) =>
          part.type === "text"
            ? { type: "text", text: part.text }
            : part.url.startsWith("data:")
              ? {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: part.mediaType ?? mediaTypeOfDataUrl(part.url),
                    data: part.url.slice(part.url.indexOf(",") + 1)
                  }
                }
              : { type: "image", source: { type: "url", url: part.url } }
        );
  if (message.role === "assistant" && message.toolCalls !== undefined) {
    for (const call of message.toolCalls) {
      parts.push({
        type: "tool_use",
        id: call.id,
        name: encodeToolName(call.name),
        input: call.arguments
      });
    }
  }
  return { role: message.role === "assistant" ? "assistant" : "user", content: parts };
}

/** The Messages API requires alternating roles; adjacent same-role turns are merged. */
function mergeConsecutiveRoles(
  messages: Array<{ role: string; content: unknown[] }>
): Array<{ role: string; content: unknown[] }> {
  const merged: Array<{ role: string; content: unknown[] }> = [];
  for (const message of messages) {
    const previous = merged.at(-1);
    if (previous !== undefined && previous.role === message.role) {
      previous.content.push(...message.content);
    } else {
      merged.push({ role: message.role, content: [...message.content] });
    }
  }
  return merged;
}

/** Anthropic Messages JSON -> canonical response. Exported for adapter tests. */
export function fromAnthropicMessage(
  json: unknown,
  meta: {
    request: InferenceRequest;
    providerId: string;
    providerRequestId: string | null;
    totalMs: number;
  }
): InferenceResponse {
  if (!isRecord(json) || !Array.isArray(json.content)) {
    throw new InferenceError("INVALID_PROVIDER_RESPONSE", {
      providerId: meta.providerId,
      modelId: meta.request.modelId
    });
  }
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const block of json.content.filter(isRecord)) {
    if (block.type === "text" && typeof block.text === "string") text += block.text;
    if (block.type === "tool_use" && typeof block.name === "string") {
      toolCalls.push({
        id: typeof block.id === "string" ? block.id : `toolu_${toolCalls.length}`,
        name: decodeToolName(block.name),
        arguments: parseToolArguments(block.input)
      });
    }
  }
  const providerRequestId =
    meta.providerRequestId ?? (typeof json.id === "string" ? json.id : null);
  return {
    requestId: meta.request.requestId,
    providerId: meta.providerId,
    modelId: meta.request.modelId,
    output: { text, toolCalls },
    finishReason: stopReason(json.stop_reason),
    usage: withTotal(anthropicUsage(json.usage)),
    latency: { totalMs: meta.totalMs },
    ...(providerRequestId === null ? {} : { providerRequestId })
  };
}

function anthropicUsage(value: unknown): InferenceUsage {
  if (!isRecord(value)) return {};
  return {
    ...(typeof value.input_tokens === "number" ? { inputTokens: value.input_tokens } : {}),
    ...(typeof value.output_tokens === "number" ? { outputTokens: value.output_tokens } : {}),
    ...(typeof value.cache_read_input_tokens === "number"
      ? { cachedInputTokens: value.cache_read_input_tokens }
      : {})
  };
}

function withTotal(usage: InferenceUsage): InferenceUsage {
  return usage.inputTokens === undefined || usage.outputTokens === undefined
    ? usage
    : { ...usage, totalTokens: usage.inputTokens + usage.outputTokens };
}

function stopReason(value: unknown): InferenceFinishReason {
  switch (value) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return "stop";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      return "unknown";
  }
}

function isOverloaded(event: Record<string, unknown>): boolean {
  return isRecord(event.error) && event.error.type === "overloaded_error";
}

function mediaTypeOfDataUrl(url: string): string {
  const match = /^data:([^;,]+)/u.exec(url);
  return match?.[1] ?? "image/png";
}

function parseJson(text: string): Record<string, unknown> | null {
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
