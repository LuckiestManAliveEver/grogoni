import { describe, expect, it, vi } from "vitest";
import type { InferenceExecutionRequest, RuntimeModelPrompt } from "@grogoni/shared-types";
import { createBulkhead, createCircuitBreaker } from "@grogoni/resource-control";
import {
  boundModelRuntimeAdapter,
  createVercelModelAdapter,
  ModelRuntimeError,
  type ModelRuntimeAdapter,
  type ModelRuntimeGenerationResult,
  type VercelInferenceClient
} from "./model-runtime.js";
import type { ModelArtifactStore } from "./model-artifact-store.js";

const prompt: RuntimeModelPrompt = {
  message: "hi",
  allowedTools: [],
  schemaVersion: "cp11-runtime-model-v1"
};

function generationResult(): ModelRuntimeGenerationResult {
  return {
    text: "hello",
    modelId: "smollm2-360m",
    provider: "llama.cpp",
    executionTarget: "vercel",
    latencyMs: 1
  };
}

function fakeAdapter(overrides: Partial<ModelRuntimeAdapter> = {}): ModelRuntimeAdapter {
  return {
    provider: "llama.cpp",
    executionTarget: "vercel",
    canRun: vi.fn(async () => ({ available: true, errorCode: null, message: null })),
    healthCheck: vi.fn(async () => ({
      available: true,
      errorCode: null,
      message: null,
      modelId: "smollm2-360m",
      provider: "llama.cpp",
      executionTarget: "vercel" as const,
      latencyMs: 1,
      responsePreview: null,
      retryable: false
    })),
    generate: vi.fn(async () => generationResult()),
    ...overrides
  };
}

const context = { agentId: "agent-1", shopId: "shop-1", modelId: "smollm2-360m" };

describe("boundModelRuntimeAdapter", () => {
  it("passes canRun/healthCheck straight through, unbounded", async () => {
    const adapter = fakeAdapter();
    const bounded = boundModelRuntimeAdapter(adapter, {
      bulkhead: createBulkhead({
        name: "inference",
        workloadClass: "important",
        maxConcurrency: 1,
        maxQueue: 0
      }),
      breaker: createCircuitBreaker({
        name: "inference",
        failureThreshold: 1,
        resetTimeoutMs: 1000
      })
    });

    await bounded.canRun(context);
    await bounded.healthCheck(context);
    expect(adapter.canRun).toHaveBeenCalledTimes(1);
    expect(adapter.healthCheck).toHaveBeenCalledTimes(1);
  });

  it("lets generate() through under the concurrency budget", async () => {
    const adapter = fakeAdapter();
    const bounded = boundModelRuntimeAdapter(adapter, {
      bulkhead: createBulkhead({
        name: "inference",
        workloadClass: "important",
        maxConcurrency: 2,
        maxQueue: 0
      }),
      breaker: createCircuitBreaker({
        name: "inference",
        failureThreshold: 5,
        resetTimeoutMs: 1000
      })
    });

    const result = await bounded.generate({ context, prompt });
    expect(result.text).toBe("hello");
  });

  it("rejects generate() with a retryable INFERENCE_BUSY error once the bulkhead is saturated", async () => {
    let releaseHold!: () => void;
    const adapter = fakeAdapter({
      generate: vi.fn(
        () =>
          new Promise<ModelRuntimeGenerationResult>((resolve) => {
            releaseHold = () => resolve(generationResult());
          })
      )
    });
    const bounded = boundModelRuntimeAdapter(adapter, {
      bulkhead: createBulkhead({
        name: "inference",
        workloadClass: "important",
        maxConcurrency: 1,
        maxQueue: 0
      }),
      breaker: createCircuitBreaker({
        name: "inference",
        failureThreshold: 5,
        resetTimeoutMs: 1000
      })
    });

    const first = bounded.generate({ context, prompt });
    await Promise.resolve();

    await expect(bounded.generate({ context, prompt })).rejects.toMatchObject({
      code: "INFERENCE_BUSY",
      retryable: true
    });

    releaseHold();
    await first;
  });

  it("does not call the adapter again once the breaker is open, and reports INFERENCE_CIRCUIT_OPEN", async () => {
    const adapter = fakeAdapter({
      generate: vi.fn(async () => {
        throw new ModelRuntimeError("INFERENCE_SERVICE_UNREACHABLE", "down", true);
      })
    });
    const bounded = boundModelRuntimeAdapter(adapter, {
      bulkhead: createBulkhead({
        name: "inference",
        workloadClass: "important",
        maxConcurrency: 5,
        maxQueue: 5
      }),
      breaker: createCircuitBreaker({
        name: "inference",
        failureThreshold: 1,
        resetTimeoutMs: 60_000
      })
    });

    await expect(bounded.generate({ context, prompt })).rejects.toThrow("down");
    expect(adapter.generate).toHaveBeenCalledTimes(1);

    await expect(bounded.generate({ context, prompt })).rejects.toMatchObject({
      code: "INFERENCE_CIRCUIT_OPEN",
      retryable: true
    });
    // The circuit stayed open, so the adapter itself is never called a second time - this is what
    // "fail fast without calling the dependency" means in practice.
    expect(adapter.generate).toHaveBeenCalledTimes(1);
  });
});

function fakeArtifactStore(overrides: Partial<ModelArtifactStore> = {}): ModelArtifactStore {
  return {
    resolveArtifact: vi.fn(async () => {
      throw new Error("resolveArtifact should not be called for a model that requires no artifact");
    }),
    createDownloadUrl: vi.fn(async () => {
      throw new Error(
        "createDownloadUrl should not be called for a model that requires no artifact"
      );
    }),
    verifyArtifact: vi.fn(async () => {
      throw new Error("verifyArtifact should not be called for a model that requires no artifact");
    }),
    ...overrides
  };
}

function fakeVercelClient(overrides: Partial<VercelInferenceClient> = {}): VercelInferenceClient & {
  lastInferRequest: InferenceExecutionRequest | null;
} {
  const state: { lastInferRequest: InferenceExecutionRequest | null } = { lastInferRequest: null };
  return {
    health: vi.fn(async () => undefined),
    infer: vi.fn(async (request: InferenceExecutionRequest) => {
      state.lastInferRequest = request;
      return {
        type: "result" as const,
        requestId: request.requestId,
        text: "hello",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
        metrics: {
          modelDownloadMs: 0,
          modelLoadMs: 0,
          firstTokenMs: 0,
          inferenceMs: 1,
          totalMs: 1,
          inputTokens: 1,
          outputTokens: 1,
          cacheHit: false
        }
      };
    }),
    ...overrides,
    get lastInferRequest() {
      return state.lastInferRequest;
    }
  };
}

describe("createVercelModelAdapter (requiresArtifact: false - Hugging Face-routed models)", () => {
  it("skips artifact resolution/verification entirely and still reports available from a health check", async () => {
    const artifactStore = fakeArtifactStore();
    const client = fakeVercelClient();
    const adapter = createVercelModelAdapter({
      modelId: "qwen3-4b",
      artifactStore,
      client,
      requiresArtifact: false
    });

    const availability = await adapter.canRun({
      agentId: "agent-1",
      shopId: "shop-1",
      modelId: "qwen3-4b"
    });

    expect(availability).toEqual({ available: true, errorCode: null, message: null });
    expect(artifactStore.resolveArtifact).not.toHaveBeenCalled();
    expect(artifactStore.verifyArtifact).not.toHaveBeenCalled();
    expect(client.health).toHaveBeenCalledTimes(1);
  });

  it("sends no artifact field at all in the wire request", async () => {
    const artifactStore = fakeArtifactStore();
    const client = fakeVercelClient();
    const adapter = createVercelModelAdapter({
      modelId: "qwen3-4b",
      artifactStore,
      client,
      requiresArtifact: false
    });

    await adapter.generate({
      context: { agentId: "agent-1", shopId: "shop-1", modelId: "qwen3-4b" },
      prompt
    });

    expect(artifactStore.resolveArtifact).not.toHaveBeenCalled();
    expect(artifactStore.createDownloadUrl).not.toHaveBeenCalled();
    expect(client.lastInferRequest).not.toHaveProperty("artifact");
  });

  it("reports a distinct provider identity from the artifact-backed llama.cpp adapter", async () => {
    const adapter = createVercelModelAdapter({
      modelId: "qwen3-4b",
      artifactStore: fakeArtifactStore(),
      client: fakeVercelClient(),
      requiresArtifact: false
    });
    expect(adapter.provider).not.toBe("llama.cpp");

    const result = await adapter.generate({
      context: { agentId: "agent-1", shopId: "shop-1", modelId: "qwen3-4b" },
      prompt
    });
    expect(result.provider).toBe(adapter.provider);
  });

  it("forwards an explicitly authorized user-connected credential to the wire request", async () => {
    const client = fakeVercelClient();
    const adapter = createVercelModelAdapter({
      modelId: "qwen3-4b",
      artifactStore: fakeArtifactStore(),
      client,
      requiresArtifact: false
    });

    await adapter.generate({
      context: {
        agentId: "agent-1",
        shopId: "shop-1",
        modelId: "qwen3-4b",
        providerCredential: { token: "hf_user_owned_token" }
      },
      prompt
    });

    expect(client.lastInferRequest?.providerCredential).toEqual({ token: "hf_user_owned_token" });
  });

  it("omits providerCredential from the wire request when the business has not authorized one", async () => {
    const client = fakeVercelClient();
    const adapter = createVercelModelAdapter({
      modelId: "qwen3-4b",
      artifactStore: fakeArtifactStore(),
      client,
      requiresArtifact: false
    });

    await adapter.generate({
      context: { agentId: "agent-1", shopId: "shop-1", modelId: "qwen3-4b" },
      prompt
    });

    expect(client.lastInferRequest).not.toHaveProperty("providerCredential");
  });
});

describe("createVercelModelAdapter (requiresArtifact defaults to true - unchanged llama.cpp behavior)", () => {
  it("still resolves, verifies, and downloads an artifact exactly as before this option existed", async () => {
    const artifact = {
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
      status: "available" as const,
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z"
    };
    const artifactStore = fakeArtifactStore({
      resolveArtifact: vi.fn(async () => artifact),
      verifyArtifact: vi.fn(async () => ({
        ok: true as const,
        sizeMatches: true,
        hashMatches: true,
        errorCode: null
      })),
      createDownloadUrl: vi.fn(async () => ({
        ...artifact,
        downloadUrl: "https://models.example.neon.tech/model.gguf",
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      }))
    });
    const client = fakeVercelClient();
    const adapter = createVercelModelAdapter({ modelId: "smollm2-360m", artifactStore, client });

    await adapter.canRun({ agentId: "agent-1", shopId: "shop-1", modelId: "smollm2-360m" });
    expect(artifactStore.resolveArtifact).toHaveBeenCalledTimes(1);
    expect(artifactStore.verifyArtifact).toHaveBeenCalledTimes(1);

    await adapter.generate({
      context: { agentId: "agent-1", shopId: "shop-1", modelId: "smollm2-360m" },
      prompt
    });
    expect(artifactStore.createDownloadUrl).toHaveBeenCalledTimes(1);
    expect(client.lastInferRequest).toHaveProperty("artifact");
    expect(adapter.provider).toBe("llama.cpp");
  });
});
