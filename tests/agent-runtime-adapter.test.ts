import { describe, expect, it, vi } from "vitest";

import type {
  NativeRuntimeAgentSummary,
  RuntimeModelCompletionResult
} from "@grogoni/shared-types";
import {
  AgentRuntimeAdapterRegistry,
  type AgentRuntimeAdapter
} from "../services/api/src/agent-harness/agent-runtime-adapter";
import { createPiAgentRuntimeAdapter } from "../services/api/src/agent-harness/pi-agent-runtime-adapter";
import { createGrogoniAgentRuntimeAdapter } from "../services/api/src/agent-harness/grogoni-agent-runtime-adapter";
import type { AgentRuntimeExecutionInput } from "../services/api/src/agent-harness/agent-runtime-adapter";

const completion: RuntimeModelCompletionResult = {
  provider: "test-model",
  status: "available",
  outputText: '{"type":"response","message":"hello"}',
  durationMs: 4,
  errorCode: null,
  metadata: { promptTokens: 10, completionTokens: 4 }
};

describe("agent runtime adapter registry", () => {
  it("selects either registered agent implementation through the same contract", async () => {
    const registry = new AgentRuntimeAdapterRegistry()
      .register(fakeAdapter("alpha"))
      .register(fakeAdapter("beta"));

    expect(registry.resolve("alpha")?.id).toBe("alpha");
    expect(registry.resolve("beta")?.id).toBe("beta");
    expect(registry.list().map((adapter) => adapter.id)).toEqual(["alpha", "beta"]);
  });

  it("runs Pi's lifecycle around the already-resolved model capability", async () => {
    const complete = vi.fn(async () => completion);
    const adapter = createPiAgentRuntimeAdapter();
    const result = await adapter.execute({
      agent: piAgent(),
      bindingId: "binding-1",
      executionHostId: "host-1",
      modelId: "smollm2-360m",
      conversationId: "conversation-1",
      shopId: "shop-1",
      userMessage: "hello",
      prompt: {
        message: "protected prompt",
        allowedTools: [],
        schemaVersion: "cp11-runtime-model-v1"
      },
      model: { name: "test-model", complete },
      allowedTools: []
    });

    expect(complete).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ message: "protected prompt", allowedTools: [] }),
      undefined
    );
    expect(result.completion).toEqual(completion);
    expect(result.eventTypes.length).toBeGreaterThan(0);
  });
});

function fakeAdapter(id: string): AgentRuntimeAdapter {
  return {
    id,
    canRun: async () => ({ available: true, errorCode: null, message: null }),
    execute: async () => ({ completion, eventTypes: [`${id}.completed`] })
  };
}

function grogoniInput(): AgentRuntimeExecutionInput {
  return {
    agent: { ...piAgent(), configuration: { runtimeAdapterId: "grogoni" } },
    bindingId: "binding",
    executionHostId: null,
    modelId: "gpt-6-luna",
    conversationId: "conversation",
    shopId: "shop",
    userMessage: "hello",
    prompt: {
      message: "hello",
      allowedTools: [],
      schemaVersion: "cp11-runtime-model-v1",
      conversationHistory: [{ role: "user", content: "private history" }]
    },
    model: { name: "test-model", complete: vi.fn(async () => completion) },
    allowedTools: []
  };
}

describe("Grogoni request-scoped safeguards", () => {
  it("isolates invocation context, intersects tools, and preserves usage", async () => {
    const input = grogoniInput();
    input.prompt.allowedTools = ["untrusted-tool"] as unknown as typeof input.prompt.allowedTools;
    input.model.complete = vi.fn(async (prompt) => {
      expect(prompt.allowedTools).toEqual([]);
      prompt.conversationHistory![0]!.content = "mutated";
      return completion;
    });
    const result = await createGrogoniAgentRuntimeAdapter().execute(input);
    expect(input.prompt.conversationHistory![0]!.content).toBe("private history");
    expect(result.completion.metadata).toMatchObject({
      promptTokens: 10,
      completionTokens: 4,
      modelCalls: 1
    });
    expect(result.eventTypes).toEqual(["agent_start", "turn_start", "turn_end", "agent_end"]);
    expect(input.model.complete).toHaveBeenCalledOnce();
  });
  it("rejects inactive agents and oversized context before spending tokens", async () => {
    const input = grogoniInput();
    input.agent.status = "disabled" as typeof input.agent.status;
    expect((await createGrogoniAgentRuntimeAdapter().execute(input)).completion.errorCode).toBe(
      "AGENT_RUNTIME_UNAVAILABLE"
    );
    input.agent.status = "active";
    expect(
      (await createGrogoniAgentRuntimeAdapter({ maxPromptBytes: 1 }).execute(input)).completion
        .errorCode
    ).toBe("CONTEXT_TOO_LARGE");
    expect(input.model.complete).not.toHaveBeenCalled();
  });
  it("bounds output and does not retry", async () => {
    const input = grogoniInput();
    const result = await createGrogoniAgentRuntimeAdapter({ maxOutputBytes: 1 }).execute(input);
    expect(result.completion).toMatchObject({ outputText: null, errorCode: "OUTPUT_TOO_LARGE" });
    expect(input.model.complete).toHaveBeenCalledOnce();
  });
  it("enforces deadlines even when a model ignores cancellation", async () => {
    const input = grogoniInput();
    input.model.complete = vi.fn(() => new Promise(() => {}));
    const result = await createGrogoniAgentRuntimeAdapter({ timeoutMs: 5 }).execute(input);
    expect(result.completion).toMatchObject({
      status: "timeout",
      errorCode: "AGENT_RUNTIME_TIMEOUT"
    });
    expect(result.eventTypes).toContain("turn_error");
  });
  it("propagates cancellation to the selected model without sharing signals", async () => {
    const controller = new AbortController();
    const input = { ...grogoniInput(), signal: controller.signal };
    let modelSignal: AbortSignal | undefined;
    input.model.complete = vi.fn((_prompt, signal) => {
      modelSignal = signal;
      controller.abort(new Error("cancelled"));
      return new Promise(() => {});
    });
    await expect(createGrogoniAgentRuntimeAdapter().execute(input)).rejects.toThrow("cancelled");
    expect(modelSignal?.aborted).toBe(true);
    expect(modelSignal).not.toBe(controller.signal);
  });
});

function piAgent(): NativeRuntimeAgentSummary {
  return {
    id: "builtin:pi:v1",
    businessId: null,
    accountId: null,
    name: "Pi",
    provider: "pi",
    packageRef: "npm:@earendil-works/pi-agent-core@0.84.4",
    version: "0.84.4",
    runtimeContractVersion: "1",
    capabilities: ["tools", "mcp"],
    configuration: { runtimeAdapterId: "pi", requiredModelCapabilities: ["chat"] },
    status: "active",
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z"
  };
}
