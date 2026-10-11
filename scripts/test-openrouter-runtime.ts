import { createOpenRouterModelAdapter } from "../services/api/src/inference/openrouter-model-runtime.js";
import { createGrogoniAgentRuntimeAdapter } from "../services/api/src/agent-harness/grogoni-agent-runtime-adapter.js";
import { runtimeProviderFromAdapter } from "../services/api/src/inference/model-runtime.js";
import type { NativeRuntimeAgentSummary, RuntimeModelPrompt } from "@grogoni/shared-types";

const adapter = createOpenRouterModelAdapter({
  modelId: "gpt-6-luna",
  providerModelId: "openai/gpt-6-luna",
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
  maxOutputTokens: 256
});
const context = { modelId: "gpt-6-luna", agentId: "smoke", shopId: "smoke" };
const prompt: RuntimeModelPrompt = {
  message: "Reply with a brief greeting. Do not call any tools.",
  allowedTools: [],
  schemaVersion: "cp11-runtime-model-v1"
};
const direct = await adapter.generate({ context, prompt });
JSON.parse(direct.text);
console.log(
  JSON.stringify({
    path: "openrouter",
    model: direct.modelId,
    json: true,
    promptTokens: direct.promptTokens,
    completionTokens: direct.completionTokens
  })
);
const agent: NativeRuntimeAgentSummary = {
  id: "smoke",
  businessId: null,
  accountId: null,
  name: "Smoke",
  provider: "grogoni-business-agent",
  packageRef: null,
  version: "1",
  runtimeContractVersion: "1",
  capabilities: ["chat"],
  configuration: { runtimeAdapterId: "grogoni" },
  status: "active",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};
const runtime = createGrogoniAgentRuntimeAdapter();
const result = await runtime.execute({
  agent,
  modelId: context.modelId,
  bindingId: "smoke",
  executionHostId: null,
  conversationId: "smoke",
  shopId: "smoke",
  userMessage: prompt.message,
  prompt,
  model: runtimeProviderFromAdapter({ adapter, context }),
  allowedTools: []
});
if (result.completion.status !== "available" || !result.completion.outputText)
  throw new Error(`Grogoni smoke failed: ${result.completion.errorCode}`);
JSON.parse(result.completion.outputText);
console.log(
  JSON.stringify({
    path: "grogoni",
    model: context.modelId,
    json: true,
    events: result.eventTypes
  })
);
