import type { AiModelSummary, AiModelInferenceRouting } from "../../packages/shared-types/src";
import { readInferenceEnvironment } from "../../services/api/src/inference/providers/environment";
import {
  createInferencePlatform,
  type CreateInferencePlatformOptions,
  type InferencePlatform
} from "../../services/api/src/inference/providers/platform";
import {
  createMemoryInferenceRepositories,
  type InferencePolicyRecord
} from "../../services/api/src/inference/providers/repositories";

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  rawBody: string | null;
}

/** A fetch fake that records every request (headers included) and answers from a handler. */
export function scriptedFetch(
  handler: (request: RecordedRequest) => Response | Promise<Response>
): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[name.toLowerCase()] = value;
    }
    const rawBody = typeof init?.body === "string" ? init.body : null;
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: rawBody === null ? null : (JSON.parse(rawBody) as Record<string, unknown>),
      rawBody
    };
    requests.push(request);
    if (init?.signal?.aborted === true) {
      throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    }
    return handler(request);
  }) as typeof fetch;
  return { fetch: fake, requests };
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

export function sseResponse(
  events: Array<{ event?: string; data: unknown }>,
  headers: Record<string, string> = {}
): Response {
  const text = events
    .map(
      (entry) =>
        `${entry.event === undefined ? "" : `event: ${entry.event}\n`}data: ${
          typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data)
        }\n\n`
    )
    .join("");
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...headers }
  });
}

export function catalogModel(input: {
  id: string;
  providerId: string;
  providerModelId: string;
  executionTarget?: AiModelInferenceRouting["executionTarget"];
  capabilities?: Partial<AiModelInferenceRouting["capabilities"]>;
  pricing?: AiModelInferenceRouting["pricing"];
  maxOutputTokens?: number | null;
  available?: boolean;
  enabled?: boolean;
  label?: string;
}): AiModelSummary {
  return {
    id: input.id,
    label: input.label ?? input.id,
    provider: input.providerId,
    description: `${input.id} served through ${input.providerId}.`,
    capabilities: ["chat"],
    available: input.available ?? true,
    source: "hosted",
    format: "remote",
    license: null,
    licenseUrl: null,
    modelCardUrl: null,
    downloadUrl: null,
    fileName: null,
    fileSizeBytes: null,
    minimumMemoryGb: null,
    recommended: false,
    contextWindow: 32_768,
    inference: {
      providerId: input.providerId,
      providerModelId: input.providerModelId,
      executionTarget: input.executionTarget ?? "remote-inference",
      capabilities: { text: true, ...input.capabilities },
      maxOutputTokens: input.maxOutputTokens ?? null,
      enabled: input.enabled ?? true,
      pricing: input.pricing ?? null
    }
  };
}

export const testSecrets = {
  openai: "sk-test-openai-managed-0000000000000000AAAA",
  anthropic: "sk-ant-test-managed-00000000000000000BBBB",
  zai: "zai-test-managed-key-000000000000000CCCC",
  llama: "llama-test-managed-key-0000000000000DDDD"
} as const;

/** Environment with every Grogoni-managed provider configured (fake keys) plus a llama.cpp host. */
export function managedEnvironment(extra: Record<string, string> = {}) {
  return readInferenceEnvironment({
    OPENAI_API_KEY: testSecrets.openai,
    ANTHROPIC_API_KEY: testSecrets.anthropic,
    ZAI_API_KEY: testSecrets.zai,
    GROGONI_LLAMA_BASE_URL: "https://inference.grogoni.example/v1",
    GROGONI_LLAMA_API_KEY: testSecrets.llama,
    INFERENCE_REQUEST_TIMEOUT_MS: "2000",
    ...extra
  });
}

export function createTestPlatform(input: {
  catalog: AiModelSummary[];
  fetch: typeof fetch;
  env?: Record<string, string>;
  policies?: InferencePolicyRecord[];
  options?: Omit<CreateInferencePlatformOptions, "environment" | "repositories" | "fetchImpl">;
}): {
  platform: InferencePlatform;
  repositories: ReturnType<typeof createMemoryInferenceRepositories>;
} {
  const repositories = createMemoryInferenceRepositories({
    ...(input.policies === undefined ? {} : { policies: input.policies })
  });
  const platform = createInferencePlatform({
    environment: managedEnvironment(input.env),
    repositories,
    fetchImpl: input.fetch,
    ...input.options
  });
  platform.setModelCatalog(() => input.catalog);
  return { platform, repositories };
}

export function openAiCompletion(input: {
  content?: string | null;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  finishReason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; cached?: number };
}) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: input.content ?? null,
          ...(input.toolCalls === undefined
            ? {}
            : {
                tool_calls: input.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: call.arguments }
                }))
              })
        },
        finish_reason: input.finishReason ?? "stop"
      }
    ],
    usage:
      input.usage === undefined
        ? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        : {
            prompt_tokens: input.usage.prompt_tokens,
            completion_tokens: input.usage.completion_tokens,
            total_tokens: input.usage.prompt_tokens + input.usage.completion_tokens,
            ...(input.usage.cached === undefined
              ? {}
              : { prompt_tokens_details: { cached_tokens: input.usage.cached } })
          }
  };
}

export function anthropicMessage(input: {
  text?: string;
  toolUse?: { id: string; name: string; input: Record<string, unknown> };
  stopReason?: string;
  usage?: { input_tokens: number; output_tokens: number };
}) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [
      ...(input.text === undefined ? [] : [{ type: "text", text: input.text }]),
      ...(input.toolUse === undefined ? [] : [{ type: "tool_use", ...input.toolUse }])
    ],
    stop_reason: input.stopReason ?? "end_turn",
    usage: input.usage ?? { input_tokens: 12, output_tokens: 6 }
  };
}
