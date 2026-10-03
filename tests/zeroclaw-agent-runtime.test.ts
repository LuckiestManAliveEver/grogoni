import { describe, expect, it } from "vitest";

import type {
  NativeRuntimeAgentSummary,
  RuntimeModelPrompt,
  RuntimeModelProvider
} from "../packages/shared-types/src";
import { repositoryDefaultRuntimePolicy } from "../packages/shared-types/src";
import { inferenceRouterSeedModels } from "../services/api/src/cp2/domains/agent-runtime/model-catalog";
import {
  connectedAgentRuntimeAdapterId,
  createZeroClawAgentRuntimeAdapter,
  readZeroClawGatewayConfig,
  sameModel,
  type ZeroClawGatewayConfig
} from "../services/api/src/agent-harness/zeroclaw-agent-runtime-adapter";
import { createDefaultAgentRuntimeAdapterRegistry } from "../services/api/src/agent-harness/default-agent-runtime-adapters";
import {
  createTestPlatform,
  jsonResponse,
  scriptedFetch
} from "./fixtures/inference-provider-fakes";

const luna = inferenceRouterSeedModels.find((model) => model.id === "gpt-6-luna")!;
const gateway: ZeroClawGatewayConfig = {
  url: new URL("https://zeroclaw.grogoni.example"),
  token: "",
  webhookSecret: "zc-webhook-secret-0000000000000000",
  agentAlias: "shopkeeper",
  timeoutMs: 5_000
};
const agent: NativeRuntimeAgentSummary = {
  id: "shop-1",
  businessId: "shop-1",
  accountId: "account-1",
  name: "Shopkeeper",
  provider: "zeroclaw",
  packageRef: "github:zeroclaw-labs/zeroclaw",
  version: "1",
  runtimeContractVersion: "1",
  capabilities: ["tools", "mcp"],
  configuration: { runtimeAdapterId: "zeroclaw", requiredModelCapabilities: ["chat"] },
  status: "active",
  createdAt: "2026-09-26T00:00:00.000Z",
  updatedAt: "2026-09-26T00:00:00.000Z"
};
const prompt: RuntimeModelPrompt = {
  message: "How much sugar is left?",
  conversationHistory: [{ role: "user", content: "Hi" }],
  allowedTools: ["products.list"],
  schemaVersion: "cp11-runtime-model-v1"
};
const unusedModel: RuntimeModelProvider = {
  name: "openai",
  complete: async () => {
    throw new Error("ZeroClaw runs the model; Grogoni's own adapter must not be called.");
  }
};

function setup(
  handler: Parameters<typeof scriptedFetch>[0],
  options: { gateway?: ZeroClawGatewayConfig | null; env?: Record<string, string> } = {}
) {
  // One recorder for both ZeroClaw and any provider call, so "nothing else was contacted" is
  // checkable.
  const { fetch, requests } = scriptedFetch(handler);
  const { platform, repositories } = createTestPlatform({
    catalog: [luna],
    fetch,
    ...(options.env === undefined ? {} : { env: options.env })
  });
  const adapter = createZeroClawAgentRuntimeAdapter({
    gateway: options.gateway === undefined ? gateway : options.gateway,
    inference: () => platform,
    fetchImpl: fetch
  });
  return { adapter, requests, repositories };
}

function execute(adapter: ReturnType<typeof setup>["adapter"]) {
  return adapter.execute({
    agent,
    modelId: "gpt-6-luna",
    conversationId: "conversation-1",
    shopId: "shop-1",
    bindingId: "binding-1",
    executionHostId: null,
    userMessage: prompt.message,
    prompt,
    model: unusedModel,
    allowedTools: prompt.allowedTools
  });
}

describe("ZeroClaw agent runtime", () => {
  it("is the platform default engine for Shopkeeper with Grogoni-funded GPT-6 Luna", () => {
    expect(repositoryDefaultRuntimePolicy).toEqual({
      agentId: "builtin:shopkeeper:v1",
      agentName: "Shopkeeper",
      agentRuntimeAdapterId: "zeroclaw",
      modelId: "gpt-6-luna",
      executionTarget: "backend"
    });
    expect(luna.inference).toMatchObject({
      providerId: "openai",
      providerModelId: "gpt-6-luna",
      executionTarget: "remote-inference",
      enabled: true
    });
    expect(createDefaultAgentRuntimeAdapterRegistry().resolve("zeroclaw")).toBeDefined();
  });

  it("sends one fresh-session webhook turn and returns ZeroClaw's reply as model output", async () => {
    const { adapter, requests, repositories } = setup(() =>
      jsonResponse({
        response: JSON.stringify({ type: "response", message: "You have 3 bags of sugar." }),
        model: "gpt-6-luna"
      })
    );
    const result = await execute(adapter);

    expect(result.completion).toMatchObject({
      provider: "openai",
      status: "available",
      errorCode: null,
      metadata: { modelId: "gpt-6-luna", agentRuntime: "zeroclaw" }
    });
    expect(JSON.parse(result.completion.outputText!)).toEqual({
      type: "response",
      message: "You have 3 bags of sugar."
    });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request!.url).toBe("https://zeroclaw.grogoni.example/webhook?agent=shopkeeper");
    expect(request!.method).toBe("POST");
    expect(request!.headers["x-webhook-secret"]).toBe(gateway.webhookSecret);
    expect(request!.headers).not.toHaveProperty("authorization");
    expect(request!.headers["x-session-id"]).toMatch(/^grogoni-[0-9a-f-]{36}$/u);
    expect(request!.headers["x-idempotency-key"]).toBe(
      request!.headers["x-session-id"]!.slice("grogoni-".length)
    );
    expect(request!.body).toMatchObject({ stream: false });
    // Grogoni's prompt (instructions, history, message) is what ZeroClaw receives - no provider key.
    const message = String(request!.body!.message);
    expect(message).toContain("How much sugar is left?");
    expect(message).toContain("User: Hi");
    expect(request!.rawBody).not.toContain("sk-test-openai");

    // Recorded as platform-funded usage with an estimated cost at GPT-6 Luna's price.
    const [run] = repositories.runsSnapshot();
    expect(run).toMatchObject({
      modelId: "gpt-6-luna",
      providerId: "openai",
      credentialScope: "platform",
      status: "succeeded",
      tenantId: "shop-1",
      conversationId: "conversation-1"
    });
    expect(run!.inputTokens).toBeGreaterThan(0);
    expect(run!.outputTokens).toBeGreaterThan(0);
    expect(run!.estimatedCost).toBeGreaterThan(0);
  });

  it("rejects a reply from any model other than the bound one", async () => {
    const { adapter, repositories } = setup(() =>
      jsonResponse({ response: "hello", model: "gpt-4o-mini" })
    );
    const result = await execute(adapter);
    expect(result.completion).toMatchObject({
      status: "unavailable",
      outputText: null,
      errorCode: "MODEL_UNAVAILABLE"
    });
    expect(repositories.runsSnapshot()[0]).toMatchObject({ status: "failed" });
  });

  it("accepts the model reported with its provider prefix", () => {
    expect(sameModel("openai/gpt-6-luna", "gpt-6-luna")).toBe(true);
    expect(sameModel("GPT-6-Luna", "gpt-6-luna")).toBe(true);
    expect(sameModel("gpt-6-luna-mini", "gpt-6-luna")).toBe(false);
  });

  it("maps gateway failures to normalized errors without leaking the secret", async () => {
    const cases: Array<[number, string]> = [
      [401, "PROVIDER_MISCONFIGURED"],
      [429, "RATE_LIMITED"],
      [503, "PROVIDER_UNAVAILABLE"],
      [500, "INFERENCE_FAILED"]
    ];
    for (const [status, code] of cases) {
      const { adapter } = setup(() => jsonResponse({ error: "nope" }, status));
      const result = await execute(adapter);
      expect(result.completion.errorCode).toBe(code);
      expect(JSON.stringify(result)).not.toContain(gateway.webhookSecret);
    }
  });

  it("enforces Grogoni budgets before calling ZeroClaw", async () => {
    const { adapter, requests } = setup(
      () => jsonResponse({ response: "hi", model: "gpt-6-luna" }),
      { env: { INFERENCE_MAX_REQUESTS_PER_MINUTE: "1" } }
    );
    expect((await execute(adapter)).completion.status).toBe("available");
    const limited = await execute(adapter);
    expect(limited.completion.errorCode).toBe("RATE_LIMITED");
    expect(requests).toHaveLength(1);
  });

  it("reports itself unconfigured instead of running when no gateway is connected", async () => {
    const { adapter, requests } = setup(() => jsonResponse({}), { gateway: null });
    await expect(
      adapter.canRun({ agent, modelId: "gpt-6-luna", conversationId: "c", shopId: "shop-1" })
    ).resolves.toMatchObject({ available: false, errorCode: "AGENT_RUNTIME_UNCONFIGURED" });
    expect(requests).toHaveLength(0);
  });

  it("refuses on-device models, which never leave the member's device", async () => {
    const { adapter } = setup(() => jsonResponse({}));
    await expect(
      adapter.canRun({
        agent,
        modelId: "smollm2-360m-device",
        conversationId: "c",
        shopId: "shop-1"
      })
    ).resolves.toMatchObject({ available: false, errorCode: "MODEL_RUNTIME_INCOMPATIBLE" });
  });

  it("resolves ZeroClaw to Grogoni's engine only when no gateway is connected", () => {
    expect(connectedAgentRuntimeAdapterId("zeroclaw", true)).toBe("zeroclaw");
    expect(connectedAgentRuntimeAdapterId("zeroclaw", false)).toBe("grogoni");
    expect(connectedAgentRuntimeAdapterId("pi", false)).toBe("pi");
  });
});

describe("ZeroClaw gateway configuration", () => {
  it("is optional", () => {
    expect(readZeroClawGatewayConfig({})).toBeNull();
  });

  it("accepts Render's private hostport only with the private-network opt-in", () => {
    expect(() =>
      readZeroClawGatewayConfig({
        ZEROCLAW_GATEWAY_URL: "grogoni-zeroclaw:42617",
        ZEROCLAW_WEBHOOK_SECRET: "secret"
      })
    ).toThrow(/ZEROCLAW_GATEWAY_URL/u);
    const config = readZeroClawGatewayConfig({
      ZEROCLAW_GATEWAY_URL: "grogoni-zeroclaw:42617",
      ZEROCLAW_ALLOW_PRIVATE_NETWORK: "true",
      ZEROCLAW_WEBHOOK_SECRET: "secret"
    });
    expect(config?.url.href).toBe("http://grogoni-zeroclaw:42617/");
  });

  it("requires a credential and rejects plain http on the public internet", () => {
    expect(() =>
      readZeroClawGatewayConfig({ ZEROCLAW_GATEWAY_URL: "https://zeroclaw.example.com" })
    ).toThrow(/ZEROCLAW_GATEWAY_TOKEN or ZEROCLAW_WEBHOOK_SECRET/u);
    expect(() =>
      readZeroClawGatewayConfig({
        ZEROCLAW_GATEWAY_URL: "http://zeroclaw.example.com",
        ZEROCLAW_GATEWAY_TOKEN: "token"
      })
    ).toThrow(/ZEROCLAW_GATEWAY_URL/u);
  });
});
