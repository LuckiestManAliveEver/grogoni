import { describe, expect, it, vi } from "vitest";

import type { NativeRuntimeAgentSummary, RuntimeModelCompletionResult } from "@grogoni/shared-types";
import {
  AgentRuntimeAdapterRegistry,
  type AgentRuntimeAdapter
} from "../services/api/src/agent-harness/agent-runtime-adapter";
import { createPiAgentRuntimeAdapter } from "../services/api/src/agent-harness/pi-agent-runtime-adapter";

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
