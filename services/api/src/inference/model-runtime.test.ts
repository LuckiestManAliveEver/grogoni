import { describe, expect, it, vi } from "vitest";
import type { RuntimeModelPrompt } from "@grogoni/shared-types";
import { createBulkhead, createCircuitBreaker } from "@grogoni/resource-control";
import {
  boundModelRuntimeAdapter,
  ModelRuntimeError,
  type ModelRuntimeAdapter,
  type ModelRuntimeGenerationResult
} from "./model-runtime.js";

const prompt: RuntimeModelPrompt = {
  message: "hi",
  allowedTools: [],
  schemaVersion: "cp11-runtime-model-v1"
};

function generationResult(): ModelRuntimeGenerationResult {
  return {
    text: "hello",
    modelId: "smollm2-360m",
    provider: "ollama",
    executionTarget: "local",
    latencyMs: 1
  };
}

function fakeAdapter(overrides: Partial<ModelRuntimeAdapter> = {}): ModelRuntimeAdapter {
  return {
    provider: "ollama",
    executionTarget: "local",
    canRun: vi.fn(async () => ({ available: true, errorCode: null, message: null })),
    healthCheck: vi.fn(async () => ({
      available: true,
      errorCode: null,
      message: null,
      modelId: "smollm2-360m",
      provider: "ollama",
      executionTarget: "local" as const,
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
