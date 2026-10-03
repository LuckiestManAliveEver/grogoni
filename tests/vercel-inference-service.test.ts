import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedModelArtifact } from "@grogoni/shared-types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadVerifiedArtifact } from "../services/ai-runtime/src/artifact-loader";
import { RuntimeCache, type DisposableRuntime } from "../services/ai-runtime/src/runtime-cache";
import { InferenceServiceError } from "../services/ai-runtime/src/service-error";
import {
  createVercelHealthHandler,
  createVercelInferenceHandler,
  createVercelReadyHandler,
  readVercelInferenceConfig,
  resolveInferenceEngine,
  type VercelInferenceConfig
} from "../services/ai-runtime/src/vercel-handler";
import { readEnvironment } from "../services/api/src/config";

const token = "test-inference-token-that-is-at-least-32-characters";

function baseConfig(overrides: Partial<VercelInferenceConfig> = {}): VercelInferenceConfig {
  return {
    serviceToken: token,
    provider: "llama-cpp",
    artifactAllowedHosts: new Set(["models.example.neon.tech"]),
    maximumArtifactBytes: 450_000_000,
    maximumInputCharacters: 64_000,
    maximumOutputTokens: 512,
    cacheEntries: 1,
    huggingFace: null,
    huggingFaceFreeTierOnly: false,
    ...overrides
  };
}

function artifact(overrides: Partial<ResolvedModelArtifact> = {}): ResolvedModelArtifact {
  return {
    id: "builtin:smollm2-360m:q4_0:gguf",
    modelId: "smollm2-360m",
    storageProvider: "neon-object-storage",
    bucket: "grogoni-model-artifacts",
    objectKey: "models/smollm2-360m/SmolLM2-360M-Instruct-Q4_0.gguf",
    format: "gguf",
    quantization: "Q4_0",
    sizeBytes: 12,
    sha256: null,
    contentType: "application/octet-stream",
    status: "available",
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    downloadUrl: "https://models.example.neon.tech/grogoni-model-artifacts/model.gguf",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides
  };
}

function requestBody(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "11111111-1111-1111-1111-111111111111",
    conversationId: "conversation-1",
    runtimeBindingId: "runtime-binding-1",
    executionHostId: "builtin:vercel-inference:v1",
    agent: { id: "builtin:pi:v1", adapterId: "pi" },
    model: { id: "smollm2-360m", runtimeContractVersion: "1" },
    artifact: artifact(),
    prompt: "Say hello.",
    generation: { maxTokens: 64, temperature: 0.2, jsonOutput: false },
    ...overrides
  };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://vercel-inference.example/v1/inference", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

async function readNdjson(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("Vercel inference request handler", () => {
  it("rejects non-POST methods", async () => {
    const handler = createVercelInferenceHandler(baseConfig());
    const response = await handler(new Request("https://x/v1/inference", { method: "GET" }));
    expect(response.status).toBe(405);
  });

  it("rejects missing or incorrect bearer tokens without leaking timing", async () => {
    const handler = createVercelInferenceHandler(baseConfig());
    const missing = await handler(
      new Request("https://x/v1/inference", { method: "POST", body: "{}" })
    );
    expect(missing.status).toBe(401);
    expect((await missing.json()).error.code).toBe("INFERENCE_AUTHENTICATION_FAILED");

    const wrong = await handler(
      new Request("https://x/v1/inference", {
        method: "POST",
        headers: { authorization: "Bearer wrong-token-that-is-also-32-characters" },
        body: "{}"
      })
    );
    expect(wrong.status).toBe(401);
  });

  it("validates the request schema before starting the stream", async () => {
    const handler = createVercelInferenceHandler(baseConfig());

    const missingPrompt = await handler(post(requestBody({ prompt: "" })));
    expect(missingPrompt.status).toBe(400);
    expect((await missingPrompt.json()).error.code).toBe("INVALID_INFERENCE_REQUEST");

    const wrongHarness = await handler(
      post(requestBody({ agent: { id: "builtin:pi:v1", adapterId: "not-pi" } }))
    );
    expect(wrongHarness.status).toBe(422);
    expect((await wrongHarness.json()).error.code).toBe("AGENT_INITIALIZATION_FAILED");

    const mismatchedArtifact = await handler(
      post(requestBody({ artifact: artifact({ modelId: "a-different-model" }) }))
    );
    expect(mismatchedArtifact.status).toBe(400);

    const tooManyTokens = await handler(
      post(
        requestBody({ generation: { maxTokens: 1_000_000, temperature: 0.2, jsonOutput: false } })
      )
    );
    expect(tooManyTokens.status).toBe(400);

    const invalidSize = await handler(post(requestBody({ artifact: artifact({ sizeBytes: -1 }) })));
    expect(invalidSize.status).toBe(400);

    const invalidTemperature = await handler(
      post(requestBody({ generation: { maxTokens: 64, temperature: 5, jsonOutput: false } }))
    );
    expect(invalidTemperature.status).toBe(400);
  });

  it("streams status, delta, and result NDJSON events on success", async () => {
    const runtime: DisposableRuntime & {
      generate: ReturnType<typeof vi.fn>;
    } = {
      dispose: vi.fn(async () => undefined),
      generate: vi.fn(async ({ onText }: { onText: (text: string) => void }) => {
        onText("Hel");
        onText("lo.");
        return { text: "Hello.", finishReason: "stop", inputTokens: 4, outputTokens: 2 };
      })
    };
    const handler = createVercelInferenceHandler(baseConfig(), {
      loadRuntime: vi.fn(async () => runtime as never),
      downloadArtifact: vi.fn(async () => ({ path: "/tmp/model.gguf", downloadMs: 5 }))
    });

    const response = await handler(post(requestBody()));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");

    const events = await readNdjson(response);
    expect(events[0]).toMatchObject({ type: "status", state: "INITIALIZING" });
    expect(events.some((event) => event.type === "status" && event.state === "MODEL_LOADING")).toBe(
      true
    );
    expect(events.some((event) => event.type === "delta" && event.text === "Hel")).toBe(true);
    expect(events.some((event) => event.type === "delta" && event.text === "lo.")).toBe(true);
    const result = events.at(-1) as Record<string, unknown>;
    expect(result).toMatchObject({
      type: "result",
      requestId: "11111111-1111-1111-1111-111111111111",
      text: "Hello.",
      finishReason: "stop",
      usage: { inputTokens: 4, outputTokens: 2 }
    });
    expect((result.metrics as Record<string, unknown>).cacheHit).toBe(false);
  });

  it("can stream through Hugging Face Inference Providers without downloading a GGUF artifact", async () => {
    const downloadArtifact = vi.fn();
    const handler = createVercelInferenceHandler(
      baseConfig({
        provider: "huggingface",
        artifactAllowedHosts: new Set(),
        huggingFace: {
          token: "hf_test_token",
          defaultModelId: null,
          models: new Map([["smollm2-360m", "openai/gpt-oss-20b"]]),
          baseUrl: "https://router.huggingface.co/v1/"
        }
      }),
      {
        downloadArtifact,
        request: vi.fn(async () => {
          const encoder = new TextEncoder();
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    'data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n\n'
                  )
                );
                controller.enqueue(
                  encoder.encode(
                    'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n'
                  )
                );
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
              }
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } }
          );
        }) as unknown as typeof fetch
      }
    );

    const response = await handler(post(requestBody()));
    const events = await readNdjson(response);
    expect(downloadArtifact).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "delta" && event.text === "Hel")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "result",
      text: "Hello",
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 2 }
    });
  });

  it("selects the mapped Hugging Face model for each requested Grogoni model", async () => {
    const requestedModels: string[] = [];
    const handler = createVercelInferenceHandler(
      baseConfig({
        provider: "huggingface",
        artifactAllowedHosts: new Set(),
        huggingFace: {
          token: "hf_test_token",
          defaultModelId: null,
          models: new Map([
            ["smollm2-360m", "HuggingFaceTB/SmolLM2-1.7B-Instruct"],
            ["gpt-oss-20b", "openai/gpt-oss-20b"]
          ]),
          baseUrl: "https://router.huggingface.co/v1/"
        }
      }),
      {
        request: vi.fn(async (_url, init) => {
          requestedModels.push((JSON.parse(String(init?.body)) as { model: string }).model);
          return new Response(
            'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { status: 200 }
          );
        }) as unknown as typeof fetch
      }
    );

    await readNdjson(await handler(post(requestBody())));
    await readNdjson(
      await handler(
        post(
          requestBody({
            model: { id: "gpt-oss-20b", runtimeContractVersion: "1" },
            artifact: artifact({ modelId: "gpt-oss-20b" })
          })
        )
      )
    );

    expect(requestedModels).toEqual(["HuggingFaceTB/SmolLM2-1.7B-Instruct", "openai/gpt-oss-20b"]);
  });

  it("hybrid mode: routes a mapped model id to Hugging Face while the default llama-cpp provider still serves everything else in the same deployment", async () => {
    const downloadArtifact = vi.fn(async () => ({ path: "/tmp/model.gguf", downloadMs: 5 }));
    const loadRuntime = vi.fn(async () => ({
      dispose: vi.fn(async () => undefined),
      generate: vi.fn(async ({ onText }: { onText: (text: string) => void }) => {
        onText("gguf-reply");
        return { text: "gguf-reply", finishReason: "stop", inputTokens: 1, outputTokens: 1 };
      })
    }));
    const hfRequest = vi.fn(
      async () =>
        new Response(
          'data: {"choices":[{"delta":{"content":"hf-reply"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { status: 200 }
        )
    ) as unknown as typeof fetch;

    // Default provider is llama-cpp (the deployment-wide default is unchanged), but HF_MODEL_MAP
    // is also configured - this is the hybrid case this feature adds: both engines live in the
    // same deployment, chosen per model id, with no redeploy needed to move a model between them.
    const config = baseConfig({
      provider: "llama-cpp",
      huggingFace: {
        token: "hf_test_token",
        defaultModelId: null,
        models: new Map([["qwen3-4b", "Qwen/Qwen3-4B"]]),
        baseUrl: "https://router.huggingface.co/v1/"
      }
    });
    const handler = createVercelInferenceHandler(config, {
      downloadArtifact,
      loadRuntime: loadRuntime as never,
      request: hfRequest
    });

    const gguf = await readNdjson(await handler(post(requestBody())));
    expect((gguf.at(-1) as Record<string, unknown>).text).toBe("gguf-reply");
    expect(downloadArtifact).toHaveBeenCalledTimes(1);

    const hf = await readNdjson(
      await handler(
        post(
          requestBody({
            model: { id: "qwen3-4b", runtimeContractVersion: "1" },
            artifact: undefined
          })
        )
      )
    );
    expect((hf.at(-1) as Record<string, unknown>).text).toBe("hf-reply");
    expect(hfRequest).toHaveBeenCalledTimes(1);
    // The GGUF path was never touched by the HF-routed request.
    expect(downloadArtifact).toHaveBeenCalledTimes(1);
  });

  it("hybrid mode: rejects an HF-routed request with no artifact host allowlist configured, since the llama-cpp path is still the default for unmapped models", () => {
    expect(() =>
      readVercelInferenceConfig({
        GROGONI_INFERENCE_SERVICE_TOKEN: token,
        MODEL_ARTIFACT_ALLOWED_HOSTS: "",
        HF_TOKEN: "hf_test_token",
        HF_MODEL_MAP: '{"qwen3-4b":"Qwen/Qwen3-4B"}'
      })
    ).toThrow(/MODEL_ARTIFACT_ALLOWED_HOSTS/u);
  });

  it("forwards a business's own authorized credential to Hugging Face instead of the platform token", async () => {
    const authorizationHeaders: string[] = [];
    const handler = createVercelInferenceHandler(
      baseConfig({
        provider: "huggingface",
        artifactAllowedHosts: new Set(),
        huggingFace: {
          token: "platform-token",
          defaultModelId: null,
          models: new Map([["smollm2-360m", "Qwen/Qwen3-4B"]]),
          baseUrl: "https://router.huggingface.co/v1/"
        }
      }),
      {
        request: vi.fn(async (_url, init) => {
          authorizationHeaders.push(
            String((init?.headers as Record<string, string>).authorization)
          );
          return new Response(
            'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { status: 200 }
          );
        }) as unknown as typeof fetch
      }
    );

    await readNdjson(
      await handler(post(requestBody({ providerCredential: { token: "business-owned-token" } })))
    );

    expect(authorizationHeaders).toEqual(["Bearer business-owned-token"]);
  });

  it("uses the platform token when no business-owned credential is present on the request", async () => {
    const authorizationHeaders: string[] = [];
    const handler = createVercelInferenceHandler(
      baseConfig({
        provider: "huggingface",
        artifactAllowedHosts: new Set(),
        huggingFace: {
          token: "platform-token",
          defaultModelId: null,
          models: new Map([["smollm2-360m", "Qwen/Qwen3-4B"]]),
          baseUrl: "https://router.huggingface.co/v1/"
        }
      }),
      {
        request: vi.fn(async (_url, init) => {
          authorizationHeaders.push(
            String((init?.headers as Record<string, string>).authorization)
          );
          return new Response(
            'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { status: 200 }
          );
        }) as unknown as typeof fetch
      }
    );

    await readNdjson(await handler(post(requestBody())));

    expect(authorizationHeaders).toEqual(["Bearer platform-token"]);
  });

  it("classifies a 402 from Hugging Face as a non-retryable budget-exhaustion error, not a generic failure", async () => {
    const handler = createVercelInferenceHandler(
      baseConfig({
        provider: "huggingface",
        artifactAllowedHosts: new Set(),
        huggingFace: {
          token: "hf_test_token",
          defaultModelId: null,
          models: new Map([["smollm2-360m", "Qwen/Qwen3-4B"]]),
          baseUrl: "https://router.huggingface.co/v1/"
        }
      }),
      {
        request: vi.fn(
          async () => new Response("budget exhausted", { status: 402 })
        ) as unknown as typeof fetch
      }
    );

    const events = await readNdjson(await handler(post(requestBody())));
    const errorEvent = events.find((event) => event.type === "error");
    expect(errorEvent).toMatchObject({
      type: "error",
      code: "INFERENCE_BUDGET_EXHAUSTED",
      retryable: false
    });
  });

  it("in strict free-tier mode, refuses further Hugging Face requests after one confirmed budget-exhaustion response instead of continuing to spend", async () => {
    let calls = 0;
    const handler = createVercelInferenceHandler(
      baseConfig({
        provider: "huggingface",
        artifactAllowedHosts: new Set(),
        huggingFaceFreeTierOnly: true,
        huggingFace: {
          token: "hf_test_token",
          defaultModelId: null,
          models: new Map([["smollm2-360m", "Qwen/Qwen3-4B"]]),
          baseUrl: "https://router.huggingface.co/v1/"
        }
      }),
      {
        request: vi.fn(async () => {
          calls += 1;
          return new Response("budget exhausted", { status: 402 });
        }) as unknown as typeof fetch
      }
    );

    const first = await readNdjson(
      await handler(post(requestBody({ requestId: "11111111-1111-1111-1111-111111111111" })))
    );
    expect(first.find((event) => event.type === "error")).toMatchObject({
      code: "INFERENCE_BUDGET_EXHAUSTED"
    });
    expect(calls).toBe(1);

    // The second request must fail fast on the application-side latch, without calling Hugging
    // Face again - "protection against repeated requests after budget exhaustion" from the brief.
    const second = await handler(
      post(requestBody({ requestId: "22222222-2222-2222-2222-222222222222" }))
    );
    expect(second.status).toBe(402);
    expect(calls).toBe(1);
  });

  it("without HF_FREE_TIER_ONLY, a budget-exhaustion response does not block subsequent requests", async () => {
    let calls = 0;
    const handler = createVercelInferenceHandler(
      baseConfig({
        provider: "huggingface",
        artifactAllowedHosts: new Set(),
        huggingFaceFreeTierOnly: false,
        huggingFace: {
          token: "hf_test_token",
          defaultModelId: null,
          models: new Map([["smollm2-360m", "Qwen/Qwen3-4B"]]),
          baseUrl: "https://router.huggingface.co/v1/"
        }
      }),
      {
        request: vi.fn(async () => {
          calls += 1;
          return new Response("budget exhausted", { status: 402 });
        }) as unknown as typeof fetch
      }
    );

    await handler(post(requestBody({ requestId: "11111111-1111-1111-1111-111111111111" })));
    await handler(post(requestBody({ requestId: "22222222-2222-2222-2222-222222222222" })));
    expect(calls).toBe(2);
  });

  it("reuses a warm runtime from the cache on a second request for the same model", async () => {
    const loadRuntime = vi.fn(async () => ({
      dispose: vi.fn(async () => undefined),
      generate: vi.fn(async ({ onText }: { onText: (text: string) => void }) => {
        onText("hi");
        return { text: "hi", finishReason: "stop", inputTokens: 1, outputTokens: 1 };
      })
    }));
    const cache = new RuntimeCache(1);
    const handler = createVercelInferenceHandler(baseConfig(), {
      cache: cache as never,
      loadRuntime: loadRuntime as never,
      downloadArtifact: vi.fn(async () => ({ path: "/tmp/model.gguf", downloadMs: 5 }))
    });

    await handler(post(requestBody({ requestId: "11111111-1111-1111-1111-111111111111" })));
    const secondResponse = await handler(
      post(requestBody({ requestId: "22222222-2222-2222-2222-222222222222" }))
    );
    const events = await readNdjson(secondResponse);
    expect(loadRuntime).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === "status" && event.state === "MODEL_LOADING")).toBe(
      false
    );
    const result = events.at(-1) as Record<string, unknown>;
    expect((result.metrics as Record<string, unknown>).cacheHit).toBe(true);
  });

  it("emits a typed error event, not an HTTP failure, when generation fails mid-stream", async () => {
    const handler = createVercelInferenceHandler(baseConfig(), {
      downloadArtifact: vi.fn(async () => {
        throw new InferenceServiceError("ARTIFACT_DOWNLOAD_FAILED", "download failed", true, 502);
      })
    });

    const response = await handler(post(requestBody()));
    expect(response.status).toBe(200);
    const events = await readNdjson(response);
    const errorEvent = events.find((event) => event.type === "error");
    expect(errorEvent).toMatchObject({
      type: "error",
      code: "ARTIFACT_DOWNLOAD_FAILED",
      retryable: true
    });
  });

  it("rejects an oversized request body before parsing it", async () => {
    const handler = createVercelInferenceHandler(baseConfig());
    const response = await handler(
      post(requestBody(), { "content-length": String(64_000 * 4 + 8_192 + 1) })
    );
    expect(response.status).toBe(413);
  });

  it("recovers on the next request after a failed initialization instead of staying poisoned", async () => {
    const cache = new RuntimeCache<DisposableRuntime & { generate: ReturnType<typeof vi.fn> }>(1);
    const downloadArtifact = vi
      .fn()
      .mockRejectedValueOnce(
        new InferenceServiceError("ARTIFACT_DOWNLOAD_FAILED", "download failed", true, 502)
      )
      .mockResolvedValueOnce({ path: "/tmp/model.gguf", downloadMs: 5 });
    const loadRuntime = vi.fn(async () => ({
      dispose: vi.fn(async () => undefined),
      generate: vi.fn(async ({ onText }: { onText: (text: string) => void }) => {
        onText("ok");
        return { text: "ok", finishReason: "stop", inputTokens: 1, outputTokens: 1 };
      })
    }));
    const handler = createVercelInferenceHandler(baseConfig(), {
      cache: cache as never,
      downloadArtifact: downloadArtifact as never,
      loadRuntime: loadRuntime as never
    });

    const first = await handler(
      post(requestBody({ requestId: "11111111-1111-1111-1111-111111111111" }))
    );
    const firstEvents = await readNdjson(first);
    expect(firstEvents.some((event) => event.type === "error")).toBe(true);
    expect(cache.size).toBe(0);

    const second = await handler(
      post(requestBody({ requestId: "22222222-2222-2222-2222-222222222222" }))
    );
    const secondEvents = await readNdjson(second);
    const result = secondEvents.at(-1) as Record<string, unknown>;
    expect(result).toMatchObject({ type: "result", text: "ok" });
    expect(cache.size).toBe(1);
  });

  it("does not share a mutable conversation/session across unrelated requests to the same model", async () => {
    const seenPrompts: string[] = [];
    const runtime: DisposableRuntime & { generate: ReturnType<typeof vi.fn> } = {
      dispose: vi.fn(async () => undefined),
      generate: vi.fn(
        async ({ prompt, onText }: { prompt: string; onText: (t: string) => void }) => {
          seenPrompts.push(prompt);
          onText(prompt);
          return { text: prompt, finishReason: "stop", inputTokens: 1, outputTokens: 1 };
        }
      )
    };
    const handler = createVercelInferenceHandler(baseConfig(), {
      loadRuntime: vi.fn(async () => runtime as never),
      downloadArtifact: vi.fn(async () => ({ path: "/tmp/model.gguf", downloadMs: 5 }))
    });

    const first = await handler(
      post(requestBody({ requestId: "11111111-1111-1111-1111-111111111111", prompt: "Prompt A" }))
    );
    const second = await handler(
      post(requestBody({ requestId: "22222222-2222-2222-2222-222222222222", prompt: "Prompt B" }))
    );
    const firstResult = (await readNdjson(first)).at(-1) as Record<string, unknown>;
    const secondResult = (await readNdjson(second)).at(-1) as Record<string, unknown>;
    expect(firstResult.text).toBe("Prompt A");
    expect(secondResult.text).toBe("Prompt B");
    expect(seenPrompts).toHaveLength(2);
    expect(new Set(seenPrompts)).toEqual(new Set(["Prompt A", "Prompt B"]));
  });
});

describe("resolveInferenceEngine", () => {
  it("routes a model id present in HF_MODEL_MAP to Hugging Face regardless of the default provider", () => {
    const resolution = resolveInferenceEngine(
      {
        provider: "llama-cpp",
        huggingFace: {
          token: "t",
          defaultModelId: null,
          models: new Map([["qwen3-4b", "Qwen/Qwen3-4B"]]),
          baseUrl: "https://router.huggingface.co/v1/"
        }
      },
      "qwen3-4b"
    );
    expect(resolution).toEqual({ engine: "huggingface", huggingFaceModelId: "Qwen/Qwen3-4B" });
  });

  it("falls through to llama-cpp for an unmapped model id when the default provider is llama-cpp", () => {
    const resolution = resolveInferenceEngine(
      {
        provider: "llama-cpp",
        huggingFace: {
          token: "t",
          defaultModelId: null,
          models: new Map([["qwen3-4b", "Qwen/Qwen3-4B"]]),
          baseUrl: "https://router.huggingface.co/v1/"
        }
      },
      "smollm2-360m"
    );
    expect(resolution).toEqual({ engine: "llama-cpp" });
  });

  it("uses HF_MODEL_ID as the exclusive-mode fallback only when provider is huggingface", () => {
    const config = {
      provider: "huggingface" as const,
      huggingFace: {
        token: "t",
        defaultModelId: "openai/gpt-oss-20b",
        models: new Map<string, string>(),
        baseUrl: "https://router.huggingface.co/v1/"
      }
    };
    expect(resolveInferenceEngine(config, "anything")).toEqual({
      engine: "huggingface",
      huggingFaceModelId: "openai/gpt-oss-20b"
    });
  });

  it("throws MODEL_NOT_FOUND when provider is the exclusive huggingface mode with no map or fallback match", () => {
    expect(() =>
      resolveInferenceEngine(
        {
          provider: "huggingface",
          huggingFace: {
            token: "t",
            defaultModelId: null,
            models: new Map([["other-model", "org/other"]]),
            baseUrl: "https://router.huggingface.co/v1/"
          }
        },
        "unmapped-model"
      )
    ).toThrow(/No Hugging Face model is configured/u);
  });

  it("returns llama-cpp when Hugging Face is not configured at all", () => {
    expect(
      resolveInferenceEngine({ provider: "llama-cpp", huggingFace: null }, "any-model")
    ).toEqual({ engine: "llama-cpp" });
  });
});

describe("Vercel inference health handler", () => {
  it("reports bare liveness without requiring authentication or configuration", () => {
    const handler = createVercelHealthHandler();
    const response = handler();
    expect(response.status).toBe(200);
  });

  it("does not claim the model or runtime is initialized", async () => {
    const handler = createVercelHealthHandler();
    const body = await handler().json();
    expect(body).toEqual({ ok: true, service: "grogoni-ai-runtime" });
  });
});

describe("Vercel inference ready handler", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports 200 ready when configuration is valid, without downloading anything", async () => {
    const handler = createVercelReadyHandler({
      GROGONI_INFERENCE_SERVICE_TOKEN: token,
      MODEL_ARTIFACT_ALLOWED_HOSTS: "models.example.neon.tech"
    });
    const response = handler();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, ready: true, configured: true, artifactHosts: 1 });
  });

  it("reports Hugging Face provider readiness without requiring artifact hosts", async () => {
    const handler = createVercelReadyHandler({
      GROGONI_INFERENCE_SERVICE_TOKEN: token,
      INFERENCE_PROVIDER: "huggingface",
      HF_TOKEN: "hf_test_token",
      HF_MODEL_MAP: '{"smollm2-360m":"openai/gpt-oss-20b"}'
    });
    const response = handler();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      ready: true,
      provider: "huggingface",
      huggingFaceModel: null,
      huggingFaceModels: { "smollm2-360m": "openai/gpt-oss-20b" },
      capabilities: { formats: ["huggingface-chat-completions"] },
      artifactHosts: 0
    });
  });

  it("reports 503 not-ready when required configuration is missing, without leaking the token", async () => {
    const handler = createVercelReadyHandler({ GROGONI_INFERENCE_SERVICE_TOKEN: "too-short" });
    const response = handler();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, ready: false });
    expect(JSON.stringify(body)).not.toContain("too-short");
  });
});

describe("readVercelInferenceConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects a service token shorter than 32 characters", () => {
    expect(() => readVercelInferenceConfig({ GROGONI_INFERENCE_SERVICE_TOKEN: "too-short" })).toThrow(
      /at least 32 characters/u
    );
  });

  it("requires at least one allowed artifact host", () => {
    expect(() =>
      readVercelInferenceConfig({
        GROGONI_INFERENCE_SERVICE_TOKEN: token,
        MODEL_ARTIFACT_ALLOWED_HOSTS: ""
      })
    ).toThrow(/MODEL_ARTIFACT_ALLOWED_HOSTS/u);
  });

  it("supports Hugging Face-hosted OSS models without an artifact host allowlist", () => {
    const config = readVercelInferenceConfig({
      GROGONI_INFERENCE_SERVICE_TOKEN: token,
      INFERENCE_PROVIDER: "huggingface",
      HF_TOKEN: "hf_test_token",
      HF_MODEL_MAP:
        '{"smollm2-360m":"HuggingFaceTB/SmolLM2-1.7B-Instruct","gpt-oss-20b":"openai/gpt-oss-20b"}'
    });
    expect(config.provider).toBe("huggingface");
    expect(config.artifactAllowedHosts.size).toBe(0);
    expect(config.huggingFace?.defaultModelId).toBeNull();
    expect(config.huggingFace?.models).toEqual(
      new Map([
        ["smollm2-360m", "HuggingFaceTB/SmolLM2-1.7B-Instruct"],
        ["gpt-oss-20b", "openai/gpt-oss-20b"]
      ])
    );
    expect(config.huggingFace?.baseUrl).toBe("https://router.huggingface.co/v1/");
  });

  it("builds hybrid Hugging Face config under the default llama-cpp provider when HF_TOKEN is set", () => {
    const config = readVercelInferenceConfig({
      GROGONI_INFERENCE_SERVICE_TOKEN: token,
      MODEL_ARTIFACT_ALLOWED_HOSTS: "models.example.neon.tech",
      HF_TOKEN: "hf_test_token",
      HF_MODEL_MAP: '{"qwen3-4b":"Qwen/Qwen3-4B"}'
    });
    expect(config.provider).toBe("llama-cpp");
    expect(config.huggingFace).not.toBeNull();
    expect(config.huggingFace?.models.get("qwen3-4b")).toBe("Qwen/Qwen3-4B");
    // Unmapped ids must still require the artifact allowlist - the llama-cpp path is unaffected.
    expect(config.artifactAllowedHosts.size).toBe(1);
  });

  it("HF_FREE_TIER_ONLY defaults to false and is only true when explicitly set", () => {
    expect(
      readVercelInferenceConfig({
        GROGONI_INFERENCE_SERVICE_TOKEN: token,
        MODEL_ARTIFACT_ALLOWED_HOSTS: "models.example.neon.tech"
      }).huggingFaceFreeTierOnly
    ).toBe(false);
    expect(
      readVercelInferenceConfig({
        GROGONI_INFERENCE_SERVICE_TOKEN: token,
        MODEL_ARTIFACT_ALLOWED_HOSTS: "models.example.neon.tech",
        HF_FREE_TIER_ONLY: "true"
      }).huggingFaceFreeTierOnly
    ).toBe(true);
  });

  it("applies documented defaults", () => {
    const config = readVercelInferenceConfig({
      GROGONI_INFERENCE_SERVICE_TOKEN: token,
      MODEL_ARTIFACT_ALLOWED_HOSTS: "models.example.neon.tech, other.example.com"
    });
    expect(config.artifactAllowedHosts).toEqual(
      new Set(["models.example.neon.tech", "other.example.com"])
    );
    expect(config.maximumArtifactBytes).toBe(450_000_000);
    expect(config.maximumOutputTokens).toBe(512);
    expect(config.cacheEntries).toBe(1);
  });
});

describe("downloadVerifiedArtifact", () => {
  const allowedHosts = new Set(["models.example.neon.tech"]);

  it("rejects a non-GGUF format before any network call", async () => {
    const request = vi.fn();
    await expect(
      downloadVerifiedArtifact({
        artifact: artifact({ format: "onnx" }),
        allowedHosts,
        maximumBytes: 1_000,
        request
      })
    ).rejects.toMatchObject({ code: "UNSUPPORTED_MODEL_FORMAT" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a download URL host outside the allowlist (SSRF guard)", async () => {
    await expect(
      downloadVerifiedArtifact({
        artifact: artifact({ downloadUrl: "https://attacker.example/model.gguf" }),
        allowedHosts,
        maximumBytes: 1_000
      })
    ).rejects.toMatchObject({ code: "ARTIFACT_URL_FORBIDDEN" });
  });

  it("rejects a plain-http download URL", async () => {
    await expect(
      downloadVerifiedArtifact({
        artifact: artifact({ downloadUrl: "http://models.example.neon.tech/model.gguf" }),
        allowedHosts,
        maximumBytes: 1_000
      })
    ).rejects.toMatchObject({ code: "ARTIFACT_URL_FORBIDDEN" });
  });

  it("rejects an expired download URL", async () => {
    await expect(
      downloadVerifiedArtifact({
        artifact: artifact({ expiresAt: new Date(Date.now() - 1_000).toISOString() }),
        allowedHosts,
        maximumBytes: 1_000
      })
    ).rejects.toMatchObject({ code: "ARTIFACT_URL_EXPIRED" });
  });

  it("rejects a malformed checksum", async () => {
    await expect(
      downloadVerifiedArtifact({
        artifact: artifact({ sha256: "not-a-hash" }),
        allowedHosts,
        maximumBytes: 1_000
      })
    ).rejects.toMatchObject({ code: "ARTIFACT_METADATA_INVALID" });
  });

  it("downloads, verifies size and sha256, and atomically stores the artifact", async () => {
    const bytes = Buffer.from("gguf-model-bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const target = artifact({ sizeBytes: bytes.byteLength, sha256, id: `test:${sha256}` });
    const request = vi.fn(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: { "content-length": String(bytes.byteLength) }
        })
    );

    const result = await downloadVerifiedArtifact({
      artifact: target,
      allowedHosts,
      maximumBytes: 1_000,
      request: request as unknown as typeof fetch
    });
    expect(result.path).toContain(sha256);
    const stored = await readFile(result.path);
    expect(stored.equals(bytes)).toBe(true);
    await rm(result.path, { force: true });
  });

  it("rejects a downloaded artifact whose size does not match its metadata", async () => {
    const bytes = Buffer.from("gguf-model-bytes");
    const target = artifact({
      sizeBytes: bytes.byteLength + 1,
      sha256: null,
      id: "test:size-mismatch"
    });
    const request = vi.fn(async () => new Response(bytes, { status: 200 }));

    await expect(
      downloadVerifiedArtifact({
        artifact: target,
        allowedHosts,
        maximumBytes: 1_000,
        request: request as unknown as typeof fetch
      })
    ).rejects.toMatchObject({ code: "ARTIFACT_SIZE_MISMATCH" });
  });

  it("rejects a downloaded artifact whose checksum does not match its metadata", async () => {
    const bytes = Buffer.from("gguf-model-bytes");
    const target = artifact({
      sizeBytes: bytes.byteLength,
      sha256: "0".repeat(64),
      id: "test:hash-mismatch"
    });
    const request = vi.fn(async () => new Response(bytes, { status: 200 }));

    await expect(
      downloadVerifiedArtifact({
        artifact: target,
        allowedHosts,
        maximumBytes: 1_000,
        request: request as unknown as typeof fetch
      })
    ).rejects.toMatchObject({ code: "ARTIFACT_HASH_MISMATCH" });
  });

  it("reuses an already-downloaded artifact from the on-disk cache without a network call", async () => {
    const bytes = Buffer.from("cached-model-bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const path = join(tmpdir(), `grogoni-model-${sha256}.gguf`);
    await writeFile(path, bytes);
    const request = vi.fn();

    const result = await downloadVerifiedArtifact({
      artifact: artifact({ sizeBytes: bytes.byteLength, sha256, id: `test:${sha256}` }),
      allowedHosts,
      maximumBytes: 1_000,
      request: request as unknown as typeof fetch
    });
    expect(result.downloadMs).toBe(0);
    expect(request).not.toHaveBeenCalled();
    await rm(path, { force: true });
  });
});

describe("RuntimeCache", () => {
  function runtime(): DisposableRuntime & { dispose: ReturnType<typeof vi.fn> } {
    return { dispose: vi.fn(async () => undefined) };
  }

  it("only accepts a bounded size between 1 and 4", () => {
    expect(() => new RuntimeCache(0)).toThrow();
    expect(() => new RuntimeCache(5)).toThrow();
    expect(() => new RuntimeCache(1)).not.toThrow();
    expect(() => new RuntimeCache(4)).not.toThrow();
  });

  it("evicts and disposes the least-recently-used entry once at capacity", async () => {
    const cache = new RuntimeCache(2);
    const first = runtime();
    const second = runtime();
    const third = runtime();
    await cache.acquire("a", async () => first);
    await cache.acquire("b", async () => second);
    expect(cache.size).toBe(2);
    await cache.acquire("c", async () => third);
    expect(cache.size).toBe(2);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent loads for the same key into a single loader call", async () => {
    const cache = new RuntimeCache(1);
    let loaderCalls = 0;
    const loader = async () => {
      loaderCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return runtime();
    };
    const [a, b] = await Promise.all([cache.acquire("x", loader), cache.acquire("x", loader)]);
    expect(loaderCalls).toBe(1);
    expect(a.runtime).toBe(b.runtime);
  });

  it("disposes every entry on clear", async () => {
    const cache = new RuntimeCache(2);
    const first = runtime();
    await cache.acquire("a", async () => first);
    await cache.clear();
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(0);
  });
});

describe("Render inference configuration (services/api/src/config.ts)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to no Vercel inference host configured", () => {
    const config = readEnvironment();
    expect(config.vercelInferenceUrl).toBe("");
    expect(config.inferenceRequired).toBe(false);
  });

  it("requires VERCEL_INFERENCE_URL when INFERENCE_REQUIRED=true", () => {
    vi.stubEnv("INFERENCE_REQUIRED", "true");
    vi.stubEnv("VERCEL_INFERENCE_URL", "");
    expect(() => readEnvironment()).toThrow(/VERCEL_INFERENCE_URL is required/u);
  });

  it("requires a service token of at least 32 characters once a Vercel host is configured", () => {
    vi.stubEnv("VERCEL_INFERENCE_URL", "https://inference.example.vercel.app");
    vi.stubEnv("GROGONI_INFERENCE_SERVICE_TOKEN", "too-short");
    expect(() => readEnvironment()).toThrow(
      /GROGONI_INFERENCE_SERVICE_TOKEN must contain at least 32/u
    );
  });

  it("requires Neon model-storage credentials once a Vercel host is configured", () => {
    vi.stubEnv("VERCEL_INFERENCE_URL", "https://inference.example.vercel.app");
    vi.stubEnv("GROGONI_INFERENCE_SERVICE_TOKEN", token);
    vi.stubEnv("NEON_MODEL_STORAGE_ENDPOINT", "");
    expect(() => readEnvironment()).toThrow(/NEON_MODEL_STORAGE_ENDPOINT is required/u);

    vi.stubEnv("NEON_MODEL_STORAGE_ENDPOINT", "https://storage.example.neon.tech");
    vi.stubEnv("NEON_MODEL_STORAGE_ACCESS_KEY_ID", "");
    vi.stubEnv("NEON_MODEL_STORAGE_SECRET_ACCESS_KEY", "");
    expect(() => readEnvironment()).toThrow(/Neon model-storage credentials are required/u);
  });

  it("rejects a plain-http VERCEL_INFERENCE_URL in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_INFERENCE_URL", "http://inference.example.vercel.app");
    vi.stubEnv("GROGONI_INFERENCE_SERVICE_TOKEN", token);
    vi.stubEnv("NEON_MODEL_STORAGE_ENDPOINT", "https://storage.example.neon.tech");
    vi.stubEnv("NEON_MODEL_STORAGE_ACCESS_KEY_ID", "key-id");
    vi.stubEnv("NEON_MODEL_STORAGE_SECRET_ACCESS_KEY", "secret");
    expect(() => readEnvironment()).toThrow(/VERCEL_INFERENCE_URL must use https/u);
  });

  it("accepts a fully configured Vercel + Neon runtime", () => {
    vi.stubEnv("VERCEL_INFERENCE_URL", "https://inference.example.vercel.app");
    vi.stubEnv("GROGONI_INFERENCE_SERVICE_TOKEN", token);
    vi.stubEnv("NEON_MODEL_STORAGE_ENDPOINT", "https://storage.example.neon.tech");
    vi.stubEnv("NEON_MODEL_STORAGE_ACCESS_KEY_ID", "key-id");
    vi.stubEnv("NEON_MODEL_STORAGE_SECRET_ACCESS_KEY", "secret");
    vi.stubEnv("PLATFORM_DEFAULT_EXECUTION_TARGET", "vercel");
    const config = readEnvironment();
    expect(config.vercelInferenceUrl).toBe("https://inference.example.vercel.app");
    expect(config.platformDefaultRuntime.executionTarget).toBe("vercel");
  });
});
