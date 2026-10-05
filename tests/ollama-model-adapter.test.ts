import { describe, expect, it, vi } from "vitest";

import type { RuntimeModelPrompt } from "../packages/shared-types/src";
import { parseRuntimeModelOutput } from "../packages/tool-core/src";
import {
  createOllamaInferenceClient,
  createOllamaModelAdapter
} from "../services/api/src/inference/model-runtime";
import { ollamaFetch } from "./fixtures/ollama-fakes";

// The Ollama adapter is the only server-side model runtime since the hosted inference service was
// removed (docs/local-first-cloud-audit.md); services/api/src/index.ts registers it as
// `local:<platform default model>`.

const modelId = "smollm2-360m";
const ollamaModel = "smollm2:360m";
const context = { agentId: "agent", shopId: "shop", modelId };

function prompt(message: string, extra: Partial<RuntimeModelPrompt> = {}): RuntimeModelPrompt {
  return { message, allowedTools: [], schemaVersion: "cp11-runtime-model-v1", ...extra };
}

function adapterFor(request: ReturnType<typeof ollamaFetch> | typeof fetch, timeoutMs = 1_000) {
  return createOllamaModelAdapter({
    modelId,
    ollamaModel,
    client: createOllamaInferenceClient({
      baseUrl: "http://127.0.0.1:11434",
      model: ollamaModel,
      timeoutMs,
      request: request as typeof fetch
    })
  });
}

describe("Ollama model adapter", () => {
  it("is available only when the configured model is installed", async () => {
    const installed = await adapterFor(ollamaFetch({ installed: [ollamaModel] })).healthCheck(
      context
    );
    expect(installed).toMatchObject({
      available: true,
      provider: "ollama",
      executionTarget: "local",
      modelId
    });

    const missing = await adapterFor(ollamaFetch({ installed: ["llama3:8b"] })).healthCheck(
      context
    );
    expect(missing).toMatchObject({
      available: false,
      errorCode: "MODEL_NOT_INSTALLED",
      retryable: true
    });
  });

  it("refuses a model it does not serve without calling Ollama", async () => {
    const request = ollamaFetch({ installed: [ollamaModel] });
    await expect(
      adapterFor(request).canRun({ ...context, modelId: "qwen2.5-0.5b-android" })
    ).resolves.toMatchObject({ available: false, errorCode: "MODEL_IDENTITY_MISMATCH" });
    expect(request).not.toHaveBeenCalled();
  });

  it("reports OLLAMA_UNREACHABLE when nothing listens on the endpoint", async () => {
    const refused = vi.fn(async () => {
      throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:11434");
    });
    await expect(adapterFor(refused).canRun(context)).resolves.toMatchObject({
      available: false,
      errorCode: "OLLAMA_UNREACHABLE"
    });
  });

  it("sends instructions, history and the message as chat turns, and captures usage", async () => {
    const request = ollamaFetch({
      chunks: ['{"type":"response",', '"message":"Sugar sells best."}'],
      usage: { promptTokens: 42, completionTokens: 9 }
    });
    const completion = await adapterFor(request).generate({
      context,
      prompt: prompt("What sells best?", {
        conversationHistory: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Habari!" }
        ]
      })
    });

    expect(JSON.parse(completion.text)).toEqual({
      type: "response",
      message: "Sugar sells best."
    });
    expect(completion).toMatchObject({
      provider: "ollama",
      executionTarget: "local",
      modelId,
      promptTokens: 42,
      completionTokens: 9,
      finishReason: "stop",
      inferenceRequestId: expect.any(String)
    });
    const chatCall = request.mock.calls.find(([url]) => String(url).endsWith("/api/chat"));
    const body = JSON.parse(String(chatCall?.[1]?.body)) as {
      model: string;
      stream: boolean;
      options: Record<string, number>;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe(ollamaModel);
    expect(body.stream).toBe(true);
    // Regression: without a reply budget a small model can generate for minutes.
    expect(body.options).toEqual({ temperature: 0.2, num_predict: 256 });
    expect(body.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user"
    ]);
    expect(body.messages[0]?.content).toContain(
      "You are the model behind the Grogoni agent runtime."
    );
    expect(body.messages.at(-1)?.content).toBe("What sells best?");
    expect(chatCall?.[1]).toMatchObject({ method: "POST", credentials: "omit" });
  });

  it("normalizes a plain-text reply into the runtime response contract", async () => {
    const completion = await adapterFor(ollamaFetch({ chunks: ["market"] })).generate({
      context,
      prompt: prompt("Reply with the word market")
    });
    expect(JSON.parse(completion.text)).toEqual({ type: "response", message: "market" });
  });

  it("accepts a small model's tool proposal that omits the type discriminator", async () => {
    // Small local models often answer {"toolName":...} without "type":"tool"; normalizeModelText
    // must keep that proposal usable rather than failing MODEL_RESPONSE_PARSE_FAILED.
    const completion = await adapterFor(
      ollamaFetch({ chunks: ['{"toolName":"products.list","input":{}}'] })
    ).generate({ context, prompt: prompt("list products") });
    expect(parseRuntimeModelOutput(completion.text)).toMatchObject({
      ok: true,
      output: { kind: "tool", proposal: { toolName: "products.list" } }
    });
  });

  it("rejects an empty reply and a failed generation without retrying", async () => {
    await expect(
      adapterFor(ollamaFetch({ chunks: [] })).generate({ context, prompt: prompt("hello") })
    ).rejects.toMatchObject({ code: "INFERENCE_FAILED" });

    const failing = ollamaFetch({ chatStatus: 500 });
    await expect(
      adapterFor(failing).generate({ context, prompt: prompt("hello") })
    ).rejects.toMatchObject({ code: "INFERENCE_SERVICE_UNAVAILABLE", retryable: true });
    expect(failing.mock.calls.filter(([url]) => String(url).endsWith("/api/chat"))).toHaveLength(1);
  });

  it("propagates a caller abort into an in-flight generation", async () => {
    const controller = new AbortController();
    const hanging = vi.fn(
      (_input: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true }
          );
        })
    );
    const pending = adapterFor(hanging, 60_000).generate({
      context: { ...context, signal: controller.signal },
      prompt: prompt("hello")
    });
    await vi.waitFor(() => expect(hanging).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "INFERENCE_CANCELLED" });
  });
});
