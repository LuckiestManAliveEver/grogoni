import { describe, expect, it } from "vitest";
import type { OssAgentSummary } from "../packages/shared-types/src";

import {
  applyOssAgent,
  rankPortableOssAgents,
  selectLeastMemoryOssAgent
} from "../apps/web/src/agent-catalog";
import type { AgentSettings } from "../apps/web/src/grogoni-application-shared";

const hostedAgent: OssAgentSummary = {
  id: "huggingface:example/store-agent",
  label: "Store Agent",
  description: "A callable retail agent Space.",
  source: "huggingface",
  sourceId: "example/store-agent",
  sourceUrl: "https://huggingface.co/spaces/example/store-agent",
  license: "apache-2.0",
  licenseUrl: "https://huggingface.co/spaces/example/store-agent/blob/main/LICENSE",
  licenseVerified: true,
  runtime: "gradio",
  executionMode: "hosted-api",
  minimumDeviceTier: "low",
  minimumMemoryGb: 2,
  requiresGpu: true,
  popularity: 420,
  capabilities: ["agent", "retail"],
  updatedAt: "2026-08-01T00:00:00.000Z"
};

const githubAgent: OssAgentSummary = {
  id: "github:example/agent-framework",
  label: "agent-framework",
  description: "An established agent framework.",
  source: "github",
  sourceId: "example/agent-framework",
  sourceUrl: "https://github.com/example/agent-framework",
  license: "MIT",
  licenseUrl: "https://github.com/example/agent-framework/blob/main/LICENSE",
  licenseVerified: true,
  runtime: "python",
  executionMode: "backend-adapter",
  minimumDeviceTier: "medium",
  minimumMemoryGb: 6,
  requiresGpu: false,
  popularity: 12_000,
  capabilities: ["agent", "tools"],
  updatedAt: "2026-08-01T00:00:00.000Z"
};

describe("device-independent OSS agent catalogue", () => {
  it("prioritizes callable Hugging Face agents when no backend adapter is configured", () => {
    const ranked = rankPortableOssAgents({
      agents: [githubAgent, hostedAgent],
      backendAvailable: false
    });

    expect(ranked[0]).toMatchObject({ agent: { id: hostedAgent.id }, status: "hosted-ready" });
    expect(ranked[1]).toMatchObject({ agent: { id: githubAgent.id }, status: "unavailable" });
  });

  it("allows a GitHub project once its backend adapter is ready, independent of device hardware", () => {
    const ranked = rankPortableOssAgents({
      agents: [githubAgent],
      backendAvailable: true
    });

    expect(ranked[0]).toMatchObject({ status: "backend-assisted" });
  });

  it("keeps a public source unavailable when its OSS license is not verified", () => {
    const ranked = rankPortableOssAgents({
      agents: [{ ...hostedAgent, license: "unknown", licenseVerified: false }],
      backendAvailable: true
    });

    expect(ranked[0]).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("no recognized open-source license")
    });
  });

  it("selects the runnable agent with the smallest declared memory footprint by default", () => {
    const popularButLarge = { ...githubAgent, minimumMemoryGb: 12, popularity: 100_000 };
    const ranked = rankPortableOssAgents({
      agents: [popularButLarge, hostedAgent],
      backendAvailable: true
    });

    expect(selectLeastMemoryOssAgent(ranked)).toMatchObject({
      agent: { id: hostedAgent.id, minimumMemoryGb: 2 },
      status: "hosted-ready"
    });
  });

  it("records OSS provenance without changing the model, policies, or tool permissions", () => {
    const current = {
      agentDefinitionId: "builtin:shopkeeper",
      name: "Shopkeeper",
      description: "Current agent",
      model: "qwen2.5-0.5b-android",
      role: "Shopkeeper",
      personality: "Warm",
      personalityConfig: { responseLength: "brief", additionalGuidance: "Warm" },
      instructions: "Help the shop.",
      instructionPolicy: { generalOperatingRules: ["Help the shop."] },
      knowledge: "Saved records",
      tools: ["Products"],
      integrations: ["Grogoni storefront"],
      skillBindings: [{ skillId: "invoice.draft", enabled: true }]
    } as AgentSettings;

    const next = applyOssAgent(current, hostedAgent);

    expect(next).toMatchObject({
      agentDefinitionId: hostedAgent.id,
      name: hostedAgent.label,
      model: current.model,
      instructions: current.instructions,
      tools: current.tools,
      skillBindings: current.skillBindings
    });
    expect(next.integrations).toContain(`OSS agent: ${hostedAgent.sourceUrl}`);
  });
});
