import { describe, expect, it } from "vitest";

import type {
  InferenceChunk,
  InferenceRequest,
  ModelDefinition,
  ResolvedCredential
} from "../services/api/src/inference/providers/contract";
import {
  createAnthropicProvider,
  fromAnthropicMessage,
  toAnthropicBody
} from "../services/api/src/inference/providers/anthropic-provider";
import { builtinProviderConfigs } from "../services/api/src/inference/providers/environment";
import { InferenceError } from "../services/api/src/inference/providers/errors";
import { transportFromFetch } from "../services/api/src/inference/providers/http-transport";
import {
  createOpenAiCompatibleProvider,
  createOpenAiProvider,
  createZaiProvider,
  fromChatCompletion,
  toChatCompletionBody
} from "../services/api/src/inference/providers/openai-compatible-provider";
import type { InferenceProviderConfig } from "../services/api/src/inference/providers/provider-config";
import { SecretValue } from "../services/api/src/inference/providers/secret-value";
import {
  anthropicMessage,
  jsonResponse,
  openAiCompletion,
  scriptedFetch,
  sseResponse
} from "./fixtures/inference-provider-fakes";

const secret = "sk-unit-test-secret-value-0123456789WXYZ";
const credential: ResolvedCredential = {
  scope: "platform",
  credentialId: null,
  secret: new SecretValue(secret)
};

function config(id: string): InferenceProviderConfig {
  const found = builtinProviderConfigs().find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no builtin ${id}`);
  return found;
}

function llamaConfig(): InferenceProviderConfig {
  return {
    ...config("openai"),
    id: "grogoni-llama",
    displayName: "Grogoni Cloud",
    type: "openai-compatible",
    baseUrl: "https://inference.grogoni.example/v1",
    billingProduct: "grogoni-hosted",
    source: "environment"
  };
}

function model(providerId: string, overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    id: `${providerId}-model`,
    displayName: "Test model",
    providerId,
    providerModelId: `${providerId}/vendor-model-id`,
    executionTarget: "remote-inference",
    capabilities: { text: true, tools: true, structuredOutput: true, streaming: true },
    enabled: true,
    ...overrides
  };
}

const toolRequest: InferenceRequest = {
  requestId: "req-1",
  modelId: "any",
  messages: [
    { role: "system", content: "You are Grogoni." },
    { role: "user", content: "show my products" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_prev", name: "products.list", arguments: {} }]
    },
    { role: "tool", toolCallId: "call_prev", content: '{"count":2}' },
    { role: "user", content: "and customers?" }
  ],
  generation: { temperature: 0.1, maxOutputTokens: 5_000, topP: 0.9, stop: ["END"] },
  tools: [
    {
      name: "products.list",
      description: "List products",
      inputSchema: { type: "object", properties: {} }
    }
  ],
  metadata: { conversationId: "conversation-should-not-be-forwarded" }
};

async function collect(stream: AsyncIterable<InferenceChunk>): Promise<InferenceChunk[]> {
  const chunks: InferenceChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("OpenAI-compatible wire translation", () => {
  it("translates canonical requests into chat-completions bodies without leaking metadata", () => {
    const body = toChatCompletionBody(
      toolRequest,
      model("openai", { maxOutputTokens: 800 }),
      "max_completion_tokens",
      false
    );
    expect(body).toMatchObject({
      model: "openai/vendor-model-id",
      temperature: 0.1,
      top_p: 0.9,
      stop: ["END"],
      // min(request 5000, model 800)
      max_completion_tokens: 800,
      tool_choice: "auto",
      tools: [
        {
          type: "function",
          function: {
            name: "products__list",
            description: "List products",
            parameters: { type: "object", properties: {} }
          }
        }
      ]
    });
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[2]).toMatchObject({
      role: "assistant",
      tool_calls: [
        { id: "call_prev", type: "function", function: { name: "products__list", arguments: "{}" } }
      ]
    });
    expect(messages[3]).toEqual({
      role: "tool",
      tool_call_id: "call_prev",
      content: '{"count":2}'
    });
    expect(JSON.stringify(body)).not.toContain("conversation-should-not-be-forwarded");
    expect(body).not.toHaveProperty("metadata");
  });

  it("normalizes chat-completions responses, decoding tool names and usage", () => {
    const response = fromChatCompletion(
      openAiCompletion({
        content: null,
        toolCalls: [{ id: "call_1", name: "customers__list", arguments: '{"limit":5}' }],
        finishReason: "tool_calls",
        usage: { prompt_tokens: 100, completion_tokens: 20, cached: 40 }
      }),
      { request: toolRequest, providerId: "openai", providerRequestId: "req_abc", totalMs: 12 }
    );
    expect(response).toEqual({
      requestId: "req-1",
      providerId: "openai",
      modelId: "any",
      output: {
        text: "",
        toolCalls: [{ id: "call_1", name: "customers.list", arguments: { limit: 5 } }]
      },
      finishReason: "tool_calls",
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 40 },
      latency: { totalMs: 12 },
      providerRequestId: "req_abc"
    });
  });

  it("rejects malformed provider responses with a normalized error", () => {
    expect(() =>
      fromChatCompletion(
        { unexpected: true },
        { request: toolRequest, providerId: "openai", providerRequestId: null, totalMs: 1 }
      )
    ).toThrow(InferenceError);
  });
});

describe("OpenAIProvider", () => {
  it("calls the configured base URL with a bearer key and normalizes the result", async () => {
    const { fetch, requests } = scriptedFetch(() =>
      jsonResponse(openAiCompletion({ content: '{"type":"response","message":"hi"}' }), 200, {
        "x-request-id": "req_openai_1"
      })
    );
    const provider = createOpenAiProvider(config("openai"), {
      transportFor: (policy) => transportFromFetch(fetch, policy)
    });
    const response = await provider.generate(toolRequest, {
      model: model("openai"),
      credential,
      timeoutMs: 1_000
    });
    expect(requests[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${secret}`);
    expect(requests[0]?.body).toHaveProperty("max_completion_tokens");
    expect(response.providerRequestId).toBe("req_openai_1");
    expect(response.output.text).toBe('{"type":"response","message":"hi"}');
  });

  it("verifies credentials through GET /models, never a paid completion", async () => {
    const { fetch, requests } = scriptedFetch(() => jsonResponse({ data: [] }));
    const provider = createOpenAiProvider(config("openai"), {
      transportFor: (policy) => transportFromFetch(fetch, policy)
    });
    const health = await provider.health({ credential, timeoutMs: 1_000 });
    expect(health.status).toBe("AVAILABLE");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "GET", url: "https://api.openai.com/v1/models" });
  });

  it("maps 401, 429 and 5xx to normalized health/errors without echoing the key", async () => {
    for (const [status, expected] of [
      [401, "INVALID_CREDENTIAL"],
      [429, "RATE_LIMITED"],
      [503, "PROVIDER_UNAVAILABLE"]
    ] as const) {
      const { fetch } = scriptedFetch(() =>
        jsonResponse({ error: { message: `Incorrect API key provided: ${secret}` } }, status, {
          "retry-after": "3"
        })
      );
      const provider = createOpenAiProvider(config("openai"), {
        transportFor: (policy) => transportFromFetch(fetch, policy)
      });
      const error = await provider
        .generate(toolRequest, { model: model("openai"), credential, timeoutMs: 1_000 })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(InferenceError);
      const inferenceError = error as InferenceError;
      expect(inferenceError.code).toBe(expected);
      expect(inferenceError.message).not.toContain(secret);
      expect(inferenceError.diagnostic ?? "").not.toContain(secret);
      expect(JSON.stringify(inferenceError)).not.toContain(secret);
      if (status === 429) expect(inferenceError.retryAfterMs).toBe(3_000);
    }
  });

  it("maps context-length failures to CONTEXT_TOO_LARGE", async () => {
    const { fetch } = scriptedFetch(() =>
      jsonResponse(
        { error: { code: "context_length_exceeded", message: "maximum context length" } },
        400
      )
    );
    const provider = createOpenAiProvider(config("openai"), {
      transportFor: (policy) => transportFromFetch(fetch, policy)
    });
    await expect(
      provider.generate(toolRequest, { model: model("openai"), credential, timeoutMs: 1_000 })
    ).rejects.toMatchObject({ code: "CONTEXT_TOO_LARGE", retryable: false });
  });

  it("times out with REQUEST_TIMEOUT and honors caller cancellation with REQUEST_CANCELLED", async () => {
    const hanging = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
        );
      })) as typeof fetch;
    const provider = createOpenAiProvider(config("openai"), {
      transportFor: (policy) => transportFromFetch(hanging, policy)
    });
    await expect(
      provider.generate(toolRequest, { model: model("openai"), credential, timeoutMs: 20 })
    ).rejects.toMatchObject({ code: "REQUEST_TIMEOUT", retryable: true });

    const controller = new AbortController();
    const pending = provider.generate(toolRequest, {
      model: model("openai"),
      credential,
      timeoutMs: 5_000,
      signal: controller.signal
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "REQUEST_CANCELLED", retryable: false });
  });

  it("normalizes streamed text, tool-call deltas and usage into canonical chunks", async () => {
    const { fetch } = scriptedFetch(() =>
      sseResponse([
        {
          data: {
            id: "chunk-1",
            choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }]
          }
        },
        { data: { id: "chunk-1", choices: [{ index: 0, delta: { content: "lo" } }] } },
        {
          data: {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_9",
                      function: { name: "products__list", arguments: '{"li' }
                    }
                  ]
                }
              }
            ]
          }
        },
        {
          data: {
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { arguments: 'mit":3}' } }] },
                finish_reason: "tool_calls"
              }
            ]
          }
        },
        {
          data: { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } }
        },
        { data: "[DONE]" }
      ])
    );
    const provider = createOpenAiProvider(config("openai"), {
      transportFor: (policy) => transportFromFetch(fetch, policy)
    });
    const chunks = await collect(
      provider.stream!(toolRequest, { model: model("openai"), credential, timeoutMs: 1_000 })
    );
    expect(
      chunks
        .filter((chunk) => chunk.type === "text-delta")
        .map((chunk) => (chunk as { text: string }).text)
    ).toEqual(["Hel", "lo"]);
    expect(chunks).toContainEqual({
      type: "tool-call-delta",
      index: 0,
      id: "call_9",
      name: "products.list",
      argumentsDelta: '{"li'
    });
    expect(chunks).toContainEqual({
      type: "usage",
      usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 }
    });
    const completed = chunks.at(-1);
    expect(completed).toMatchObject({
      type: "completed",
      response: {
        output: {
          text: "Hello",
          toolCalls: [{ id: "call_9", name: "products.list", arguments: { limit: 3 } }]
        },
        finishReason: "tool_calls",
        usage: { inputTokens: 9, outputTokens: 4 }
      }
    });
  });

  it("refuses to run without a credential", async () => {
    const { fetch, requests } = scriptedFetch(() => jsonResponse({}));
    const provider = createOpenAiProvider(config("openai"), {
      transportFor: (policy) => transportFromFetch(fetch, policy)
    });
    await expect(
      provider.generate(toolRequest, { model: model("openai"), credential: null, timeoutMs: 1_000 })
    ).rejects.toMatchObject({ code: "CREDENTIAL_MISSING" });
    expect(requests).toHaveLength(0);
  });
});

describe("ZaiProvider", () => {
  it("uses the general API endpoint by default and verifies with a 1-token completion", async () => {
    const { fetch, requests } = scriptedFetch(() =>
      jsonResponse(openAiCompletion({ content: "pong" }))
    );
    const provider = createZaiProvider(config("zai-general"), {
      transportFor: (policy) => transportFromFetch(fetch, policy)
    });
    const health = await provider.health({
      credential,
      timeoutMs: 1_000,
      probeModelId: "glm-test"
    });
    expect(health.status).toBe("AVAILABLE");
    expect(requests[0]?.url).toBe("https://api.z.ai/api/paas/v4/chat/completions");
    expect(requests[0]?.body).toMatchObject({ model: "glm-test", max_tokens: 1 });
    expect(requests[0]?.url).not.toContain("coding");
  });

  it("translates requests with the same compatible client", async () => {
    const { fetch, requests } = scriptedFetch(() =>
      jsonResponse(openAiCompletion({ content: "ok" }))
    );
    const provider = createZaiProvider(config("zai-general"), {
      transportFor: (policy) => transportFromFetch(fetch, policy)
    });
    const response = await provider.generate(toolRequest, {
      model: model("zai-general"),
      credential,
      timeoutMs: 1_000
    });
    expect(requests[0]?.body).toMatchObject({
      model: "zai-general/vendor-model-id",
      max_tokens: 5_000
    });
    expect(response).toMatchObject({ providerId: "zai-general", output: { text: "ok" } });
  });
});

describe("OpenAICompatibleProvider (llama.cpp and other self-hosted servers)", () => {
  it("serves a configured llama.cpp endpoint with no vendor-specific code", async () => {
    const { fetch, requests } = scriptedFetch(() =>
      jsonResponse(openAiCompletion({ content: "from llama" }))
    );
    const provider = createOpenAiCompatibleProvider(llamaConfig(), {
      transportFor: (policy) => transportFromFetch(fetch, policy)
    });
    const response = await provider.generate(toolRequest, {
      model: model("grogoni-llama"),
      credential,
      timeoutMs: 1_000
    });
    expect(requests[0]?.url).toBe("https://inference.grogoni.example/v1/chat/completions");
    expect(requests[0]?.body).toHaveProperty("max_tokens");
    expect(response.output.text).toBe("from llama");
  });

  it("allows an unauthenticated self-hosted server", async () => {
    const { fetch, requests } = scriptedFetch(() =>
      jsonResponse(openAiCompletion({ content: "ok" }))
    );
    const provider = createOpenAiCompatibleProvider(llamaConfig(), {
      transportFor: (policy) => transportFromFetch(fetch, policy)
    });
    await provider.generate(toolRequest, {
      model: model("grogoni-llama"),
      credential: null,
      timeoutMs: 1_000
    });
    expect(requests[0]?.headers).not.toHaveProperty("authorization");
  });

  it("only claims support when the model's declared capabilities cover the request", async () => {
    const { fetch } = scriptedFetch(() => jsonResponse({}));
    const provider = createOpenAiCompatibleProvider(llamaConfig(), {
      transportFor: (policy) => transportFromFetch(fetch, policy)
    });
    const textOnly = model("grogoni-llama", { capabilities: { text: true } });
    expect(await provider.supports(textOnly)).toBe(true);
    expect(await provider.supports(textOnly, toolRequest)).toBe(false);
    expect(await provider.supports(model("openai"))).toBe(false);
    expect(await provider.supports(model("grogoni-llama", { executionTarget: "browser-local" }))).toBe(
      false
    );
  });
});

describe("AnthropicProvider", () => {
  it("translates system prompts, tool calls and tool results into Messages API semantics", () => {
    const body = toAnthropicBody(
      { ...toolRequest, responseFormat: { type: "json_object" } },
      model("anthropic", { maxOutputTokens: 2_000 }),
      false
    );
    expect(body).toMatchObject({
      model: "anthropic/vendor-model-id",
      max_tokens: 2_000,
      temperature: 0.1,
      top_p: 0.9,
      stop_sequences: ["END"],
      tools: [
        {
          name: "products__list",
          description: "List products",
          input_schema: { type: "object", properties: {} }
        }
      ]
    });
    expect(body.system).toContain("You are Grogoni.");
    expect(body.system).toContain("JSON object");
    const messages = body.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[1]?.content).toContainEqual({
      type: "tool_use",
      id: "call_prev",
      name: "products__list",
      input: {}
    });
    // The tool result and the following user text are merged into one alternating user turn.
    expect(messages[2]?.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "call_prev",
      content: '{"count":2}'
    });
    expect(messages[2]?.content[1]).toEqual({ type: "text", text: "and customers?" });
    expect(JSON.stringify(body)).not.toContain("conversation-should-not-be-forwarded");
  });

  it("normalizes Messages API responses back into the canonical shape", () => {
    const response = fromAnthropicMessage(
      anthropicMessage({
        text: "Listing customers.",
        toolUse: { id: "toolu_1", name: "customers__list", input: { limit: 2 } },
        stopReason: "tool_use",
        usage: { input_tokens: 30, output_tokens: 7 }
      }),
      { request: toolRequest, providerId: "anthropic", providerRequestId: null, totalMs: 5 }
    );
    expect(response).toEqual({
      requestId: "req-1",
      providerId: "anthropic",
      modelId: "any",
      output: {
        text: "Listing customers.",
        toolCalls: [{ id: "toolu_1", name: "customers.list", arguments: { limit: 2 } }]
      },
      finishReason: "tool_calls",
      usage: { inputTokens: 30, outputTokens: 7, totalTokens: 37 },
      latency: { totalMs: 5 },
      providerRequestId: "msg_test"
    });
  });

  it("sends x-api-key and anthropic-version, and verifies keys via GET /models", async () => {
    const { fetch, requests } = scriptedFetch((request) =>
      request.method === "GET"
        ? jsonResponse({ data: [] })
        : jsonResponse(anthropicMessage({ text: "hi" }), 200, { "request-id": "req_ant" })
    );
    const provider = createAnthropicProvider(config("anthropic"), {
      transportFor: (policy) => transportFromFetch(fetch, policy)
    });
    expect((await provider.health({ credential, timeoutMs: 1_000 })).status).toBe("AVAILABLE");
    const response = await provider.generate(toolRequest, {
      model: model("anthropic"),
      credential,
      timeoutMs: 1_000
    });
    expect(requests[0]).toMatchObject({
      method: "GET",
      url: "https://api.anthropic.com/v1/models"
    });
    expect(requests[1]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(requests[1]?.headers["x-api-key"]).toBe(secret);
    expect(requests[1]?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(requests[1]?.headers).not.toHaveProperty("authorization");
    expect(response.providerRequestId).toBe("req_ant");
  });

  it("normalizes the Anthropic event stream", async () => {
    const { fetch } = scriptedFetch(() =>
      sseResponse([
        {
          event: "message_start",
          data: {
            type: "message_start",
            message: { id: "msg_s", usage: { input_tokens: 11, output_tokens: 1 } }
          }
        },
        {
          event: "content_block_start",
          data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }
        },
        {
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Sure" }
          }
        },
        {
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "toolu_s", name: "products__list", input: {} }
          }
        },
        {
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: '{"limit":' }
          }
        },
        {
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: "4}" }
          }
        },
        {
          event: "message_delta",
          data: {
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 9 }
          }
        },
        { event: "message_stop", data: { type: "message_stop" } }
      ])
    );
    const provider = createAnthropicProvider(config("anthropic"), {
      transportFor: (policy) => transportFromFetch(fetch, policy)
    });
    const chunks = await collect(
      provider.stream!(toolRequest, { model: model("anthropic"), credential, timeoutMs: 1_000 })
    );
    expect(chunks).toContainEqual({ type: "text-delta", text: "Sure" });
    expect(chunks).toContainEqual({
      type: "tool-call-delta",
      index: 1,
      id: "toolu_s",
      name: "products.list"
    });
    expect(chunks.at(-1)).toMatchObject({
      type: "completed",
      response: {
        providerRequestId: "msg_s",
        finishReason: "tool_calls",
        output: {
          text: "Sure",
          toolCalls: [{ id: "toolu_s", name: "products.list", arguments: { limit: 4 } }]
        },
        usage: { inputTokens: 11, outputTokens: 9, totalTokens: 20 }
      }
    });
  });

  it("maps overloaded and rejected-key responses to normalized errors", async () => {
    const { fetch } = scriptedFetch(() =>
      jsonResponse({ type: "error", error: { type: "overloaded_error" } }, 529)
    );
    const provider = createAnthropicProvider(config("anthropic"), {
      transportFor: (policy) => transportFromFetch(fetch, policy)
    });
    await expect(
      provider.generate(toolRequest, { model: model("anthropic"), credential, timeoutMs: 1_000 })
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });

    const rejected = scriptedFetch(() =>
      jsonResponse({ type: "error", error: { type: "authentication_error" } }, 401)
    );
    const unauthorized = createAnthropicProvider(config("anthropic"), {
      transportFor: (policy) => transportFromFetch(rejected.fetch, policy)
    });
    expect((await unauthorized.health({ credential, timeoutMs: 1_000 })).status).toBe(
      "CREDENTIAL_INVALID"
    );
  });
});
