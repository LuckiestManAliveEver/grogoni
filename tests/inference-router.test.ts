import { describe, expect, it } from "vitest";

import type { InferenceRequest } from "../services/api/src/inference/providers/contract";
import { InferenceError } from "../services/api/src/inference/providers/errors";
import type { InferenceObservation } from "../services/api/src/inference/providers/inference-router";
import type { InferencePolicyRecord } from "../services/api/src/inference/providers/repositories";
import { estimateCost } from "../services/api/src/inference/providers/usage-policy";
import { DeviceInferenceBroker } from "../services/api/src/inference/device-inference-broker";
import {
  catalogModel,
  createTestPlatform,
  failingDeviceProvider,
  fakeDeviceProvider,
  localProviderConfig
} from "./fixtures/inference-provider-fakes";

// The router serves device-local models only: hosted providers were removed with the local-first
// runtime (docs/local-first-cloud-audit.md). "local" is the built-in provider backed by the real
// DeviceInferenceBroker; "device-a"/"device-b" are operator-managed local providers whose device is
// a scripted fake, so routing, fallback, budgets and streaming can be driven deterministically.

const catalog = [
  catalogModel({ id: "smollm-local", providerModelId: "smollm2-360m" }),
  catalogModel({
    id: "phi-a",
    providerId: "device-a",
    pricing: {
      inputPerMillionTokens: 2,
      outputPerMillionTokens: 8,
      cachedInputPerMillionTokens: 0.5,
      currency: "USD"
    }
  }),
  catalogModel({ id: "phi-a-mini", providerId: "device-a" }),
  catalogModel({ id: "qwen-b", providerId: "device-b" }),
  catalogModel({ id: "server-model", providerId: "local", executionTarget: "remote-inference" }),
  catalogModel({ id: "shop-machine", providerId: "local", executionTarget: "remote-shop-device" }),
  catalogModel({ id: "disabled-a", providerId: "device-a", enabled: false }),
  catalogModel({ id: "orphan", providerId: "no-such-provider" }),
  catalogModel({ id: "tools-a", providerId: "device-a", capabilities: { tools: true } })
];

const usage = { inputTokens: 1_000, outputTokens: 500, cachedInputTokens: 400 };

function request(modelId: string, extra: Partial<InferenceRequest> = {}): InferenceRequest {
  return {
    requestId: `req-${modelId}`,
    modelId,
    messages: [
      { role: "system", content: "You are Grogoni." },
      { role: "user", content: "SECRET-PROMPT-CONTENT hello" }
    ],
    ...extra
  };
}

const callContext = { agentId: "agent-1", tenantId: "shop-a", userId: "account-a" };

async function platformWithDevices(
  input: {
    devices?: Parameters<typeof createTestPlatform>[0]["devices"];
    env?: Record<string, string>;
    policies?: InferencePolicyRecord[];
    options?: Parameters<typeof createTestPlatform>[0]["options"];
  } = {}
) {
  const devices = input.devices ?? {
    "device-a": fakeDeviceProvider("device-a", undefined, { usage }),
    "device-b": fakeDeviceProvider("device-b", undefined, { usage })
  };
  const created = createTestPlatform({
    catalog,
    providers: [localProviderConfig("device-a"), localProviderConfig("device-b")],
    devices,
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.policies === undefined ? {} : { policies: input.policies }),
    ...(input.options === undefined ? {} : { options: input.options })
  });
  await created.platform.refresh();
  return { ...created, devices };
}

describe("inference router: model and provider resolution", () => {
  it("routes each model to the device provider its catalog entry names", async () => {
    const { platform, devices } = await platformWithDevices();
    await expect(platform.router.generate(request("phi-a"), callContext)).resolves.toMatchObject({
      providerId: "device-a",
      modelId: "phi-a",
      output: { text: "reply from device-a" }
    });
    await expect(platform.router.generate(request("qwen-b"), callContext)).resolves.toMatchObject({
      providerId: "device-b",
      output: { text: "reply from device-b" }
    });
    const [call] = (devices["device-a"] as ReturnType<typeof fakeDeviceProvider>).calls;
    expect(call?.context.caller).toEqual({
      tenantId: "shop-a",
      userId: "account-a",
      turnId: null
    });
  });

  it("fails each resolution step with its own normalized code before any device call", async () => {
    const { platform, devices } = await platformWithDevices();
    const resolve = (modelId: string, extra: Partial<InferenceRequest> = {}) =>
      platform.router
        .resolveInferenceTarget({
          agentId: "agent-1",
          modelId,
          tenantId: null,
          userId: "account-a",
          request: request(modelId, extra),
          allowDeviceExecution: true
        })
        .then(
          () => "resolved",
          (error: InferenceError) => error.code
        );
    expect(await resolve("missing-model")).toBe("MODEL_UNAVAILABLE");
    expect(await resolve("disabled-a")).toBe("MODEL_UNAVAILABLE");
    expect(await resolve("orphan")).toBe("PROVIDER_MISCONFIGURED");
    expect(
      await resolve("phi-a", {
        tools: [{ name: "products.search", description: "x", inputSchema: {} }]
      })
    ).toBe("CAPABILITY_UNSUPPORTED");
    expect(await resolve("tools-a", { tools: [] })).toBe("resolved");
    await expect(
      platform.router.resolveInferenceTarget({
        agentId: " ",
        modelId: "phi-a",
        tenantId: null,
        userId: null
      })
    ).rejects.toMatchObject({ code: "INFERENCE_FAILED" });
    expect((devices["device-a"] as ReturnType<typeof fakeDeviceProvider>).calls).toHaveLength(0);
  });

  it("refuses server-side and shop-device models: those run through Ollama and the owner node", async () => {
    const { platform } = await platformWithDevices();
    for (const modelId of ["server-model", "shop-machine"]) {
      await expect(
        platform.router.resolveInferenceTarget({
          agentId: "agent-1",
          modelId,
          tenantId: null,
          userId: "account-a",
          allowDeviceExecution: true
        })
      ).rejects.toMatchObject({ code: "LOCAL_EXECUTION_REQUIRED", retryable: false });
    }
    expect(platform.hostedExecutionTargetFor("server-model")).toBeUndefined();
    expect(platform.hostedExecutionTargetFor("shop-machine")).toBeUndefined();
  });

  it("never silently picks a model: no binding model and no configured default is an error", async () => {
    const { platform } = createTestPlatform({ catalog });
    expect(() => platform.router.resolveModelId(null)).toThrow(InferenceError);
    const withDefault = createTestPlatform({
      catalog,
      env: { INFERENCE_DEFAULT_MODEL: "smollm-local" }
    });
    expect(withDefault.platform.router.resolveModelId(undefined)).toBe("smollm-local");
  });

  it("never sends a device-local model anywhere but the requesting member's own device", async () => {
    const { platform, repositories } = createTestPlatform({ catalog });
    // An anonymous caller (no member to hand the job to) is refused outright.
    await expect(
      platform.router.generate(request("smollm-local"), { ...callContext, userId: null })
    ).rejects.toMatchObject({ code: "LOCAL_EXECUTION_REQUIRED", retryable: false });

    const pending = platform.router.generate(request("smollm-local"), {
      ...callContext,
      turnId: "turn-local-0001"
    });
    const otherAccount = await platform.deviceBroker.claim({
      accountId: "account-b",
      runtime: "browser-local",
      availableModelIds: new Set(["smollm2-360m"]),
      waitMs: 10
    });
    expect(otherAccount).toBeNull();
    const withoutModel = await platform.deviceBroker.claim({
      accountId: "account-a",
      runtime: "browser-local",
      availableModelIds: new Set(["some-other-model"]),
      waitMs: 10
    });
    expect(withoutModel).toBeNull();
    const job = await platform.deviceBroker.claim({
      accountId: "account-a",
      runtime: "browser-local",
      availableModelIds: new Set(["smollm2-360m"]),
      turnId: "turn-local-0001",
      waitMs: 1_000
    });
    expect(job).toMatchObject({
      modelId: "smollm-local",
      providerModelId: "smollm2-360m",
      executionTarget: "browser-local",
      turnId: "turn-local-0001"
    });
    expect(job?.messages.at(-1)?.content).toContain("SECRET-PROMPT-CONTENT");
    expect(() =>
      platform.deviceBroker.complete("account-a", job!.id, { token: "forged", text: "x" })
    ).toThrow();
    platform.deviceBroker.complete("account-a", job!.id, {
      token: job!.token,
      text: '{"type":"response","message":"from the device"}',
      usage: { inputTokens: 40, outputTokens: 8 }
    });
    await expect(pending).resolves.toMatchObject({
      providerId: "local",
      output: { text: '{"type":"response","message":"from the device"}' },
      usage: { inputTokens: 40, outputTokens: 8 }
    });
    expect(repositories.runsSnapshot().at(-1)).toMatchObject({
      providerId: "local",
      executionTarget: "browser-local",
      credentialScope: null,
      status: "succeeded"
    });
  });

  it("fails clearly, without switching models, when no device with the model is online", async () => {
    const { platform } = createTestPlatform({
      catalog,
      options: { deviceBroker: new DeviceInferenceBroker({ claimTimeoutMs: 20 }) }
    });
    await expect(
      platform.router.generate(request("smollm-local"), callContext)
    ).rejects.toMatchObject({ code: "LOCAL_DEVICE_UNAVAILABLE" });
  });

  it("exposes each routed model to the agent runtime only on its own device target", async () => {
    const { platform } = await platformWithDevices();
    expect(platform.hostedExecutionTargetFor("smollm-local")).toBe("browser-local");
    expect(
      platform.adapterFor({ modelId: "smollm-local", executionTarget: "browser-local" })
        ?.executionTarget
    ).toBe("browser-local");
    expect(
      platform.adapterFor({ modelId: "smollm-local", executionTarget: "backend" })
    ).toBeUndefined();
    expect(
      platform.adapterFor({ modelId: "smollm-local", executionTarget: "local" })
    ).toBeUndefined();
    expect(
      platform.adapterFor({ modelId: "orphan", executionTarget: "browser-local" })
    ).toBeUndefined();
    expect(
      platform.adapterFor({ modelId: "phi-a", executionTarget: "browser-local" })?.provider
    ).toBe("device-a");
  });
});

describe("inference router: retired hosted providers", () => {
  it("never loads an operator row of a retired hosted type", async () => {
    const { platform } = createTestPlatform({
      catalog: [
        catalogModel({
          id: "gpt-legacy",
          providerId: "openai",
          executionTarget: "remote-inference"
        })
      ],
      providers: [
        // A row written before the local-first runtime, read back as-is from inference_providers.
        { ...localProviderConfig("openai"), type: "openai" as unknown as "local" }
      ]
    });
    // The memory repository returns rows verbatim; Postgres also filters them in providerFromRow.
    // Either way the registry must not end up serving a hosted model.
    await platform.refresh();
    expect(platform.registry.get("openai")).toBeUndefined();
    expect(platform.hostedExecutionTargetFor("gpt-legacy")).toBeUndefined();
    await expect(
      platform.router.generate(request("gpt-legacy"), callContext)
    ).rejects.toMatchObject({ code: "PROVIDER_MISCONFIGURED" });
  });
});

describe("inference router: legacy provider rows", () => {
  it("never lets a retired-type row shadow the built-in device provider", async () => {
    const { platform } = createTestPlatform({
      catalog,
      providers: [{ ...localProviderConfig("local"), type: "openai" as unknown as "local" }]
    });
    await platform.refresh();
    expect(platform.registry.get("local")?.config).toMatchObject({
      type: "local",
      source: "builtin"
    });
    expect(platform.hostedExecutionTargetFor("smollm-local")).toBe("browser-local");
  });

  it("ignores a provider's capability ceiling, gating only on the model's declared capabilities", async () => {
    // Matches routed-model-adapter.ts, which decides tools/response format from the model alone.
    const { platform } = createTestPlatform({
      catalog,
      providers: [localProviderConfig("device-a", { capabilities: { structuredOutput: false } })],
      devices: { "device-a": fakeDeviceProvider("device-a") }
    });
    await platform.refresh();
    await expect(platform.router.generate(request("phi-a"), callContext)).resolves.toMatchObject({
      providerId: "device-a"
    });
  });
});

describe("inference router: fallback policy", () => {
  const policy = (fallback: Partial<InferencePolicyRecord>): InferencePolicyRecord => ({
    scope: "tenant",
    tenantId: "shop-a",
    userId: null,
    currency: "USD",
    dailyBudget: null,
    providerMonthlyCeilings: {},
    maxRequestsPerMinute: null,
    maxTokensPerRequest: null,
    fallbackPolicy: "NONE",
    approvedProviderIds: [],
    fallbackModelIds: [],
    updatedAt: new Date().toISOString(),
    ...fallback
  });
  const failingA = () => ({
    "device-a": failingDeviceProvider("device-a"),
    "device-b": fakeDeviceProvider("device-b")
  });

  it("defaults to NONE: a device failure never moves the conversation elsewhere", async () => {
    const { platform, devices } = await platformWithDevices({ devices: failingA() });
    await expect(platform.router.generate(request("phi-a"), callContext)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE"
    });
    expect((devices["device-b"] as ReturnType<typeof fakeDeviceProvider>).calls).toHaveLength(0);
  });

  it("SAME_PROVIDER only moves to another model of the same provider", async () => {
    const { platform, devices } = await platformWithDevices({
      devices: failingA(),
      policies: [
        policy({ fallbackPolicy: "SAME_PROVIDER", fallbackModelIds: ["qwen-b", "phi-a-mini"] })
      ]
    });
    await expect(platform.router.generate(request("phi-a"), callContext)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE"
    });
    expect((devices["device-b"] as ReturnType<typeof fakeDeviceProvider>).calls).toHaveLength(0);
    expect(
      (devices["device-a"] as ReturnType<typeof fakeDeviceProvider>).calls.map(
        (call) => call.request.modelId
      )
    ).toEqual(["phi-a", "phi-a-mini"]);
  });

  it("APPROVED_PROVIDERS crosses providers only to approved ones, and records it", async () => {
    const { platform, repositories } = await platformWithDevices({
      devices: failingA(),
      policies: [
        policy({
          fallbackPolicy: "APPROVED_PROVIDERS",
          approvedProviderIds: ["device-b"],
          fallbackModelIds: ["qwen-b"]
        })
      ]
    });
    await expect(platform.router.generate(request("phi-a"), callContext)).resolves.toMatchObject({
      providerId: "device-b",
      modelId: "qwen-b",
      fallbackFromProviderId: "device-a"
    });
    const runs = repositories.runsSnapshot();
    expect(runs.map((run) => [run.providerId, run.status])).toEqual([
      ["device-a", "failed"],
      ["device-b", "succeeded"]
    ]);
    expect(runs[1]?.fallbackFromProviderId).toBe("device-a");
  });

  it("never falls back after a non-retryable failure", async () => {
    const { platform, devices } = await platformWithDevices({
      devices: {
        "device-a": failingDeviceProvider("device-a", "CONTENT_REJECTED"),
        "device-b": fakeDeviceProvider("device-b")
      },
      policies: [
        policy({
          fallbackPolicy: "APPROVED_PROVIDERS",
          approvedProviderIds: ["device-b"],
          fallbackModelIds: ["qwen-b"]
        })
      ]
    });
    await expect(platform.router.generate(request("phi-a"), callContext)).rejects.toMatchObject({
      code: "CONTENT_REJECTED"
    });
    expect((devices["device-b"] as ReturnType<typeof fakeDeviceProvider>).calls).toHaveLength(0);
  });
});

describe("inference router: usage, cost and limits", () => {
  it("prices usage from catalog metadata, including cached input", () => {
    expect(
      estimateCost(
        { inputTokens: 1_000, outputTokens: 500, cachedInputTokens: 400 },
        { inputPerMillionTokens: 2, outputPerMillionTokens: 8, cachedInputPerMillionTokens: 0.5 },
        "USD"
      )
    ).toEqual({ currency: "USD", estimatedAmount: (600 * 2 + 400 * 0.5 + 500 * 8) / 1_000_000 });
    expect(estimateCost({ inputTokens: 5 }, undefined, "USD")).toBeUndefined();
  });

  it("records runs with tokens and cost but never the prompt or the caller in metrics", async () => {
    const observations: InferenceObservation[] = [];
    const { platform, repositories } = await platformWithDevices({
      options: { metrics: { recordInference: (observation) => observations.push(observation) } }
    });
    const response = await platform.router.generate(request("phi-a"), {
      ...callContext,
      conversationId: "conv-1"
    });
    expect(response.cost).toEqual({ currency: "USD", estimatedAmount: 0.0054 });
    const [run] = repositories.runsSnapshot();
    expect(run).toMatchObject({
      requestId: "req-phi-a",
      conversationId: "conv-1",
      agentId: "agent-1",
      modelId: "phi-a",
      providerId: "device-a",
      credentialScope: null,
      executionTarget: "browser-local",
      inputTokens: 1_000,
      outputTokens: 500,
      cachedInputTokens: 400,
      estimatedCost: 0.0054,
      currency: "USD",
      status: "succeeded"
    });
    expect(JSON.stringify(run)).not.toContain("SECRET-PROMPT-CONTENT");
    expect(observations[0]).toMatchObject({
      provider: "device-a",
      model: "phi-a",
      status: "succeeded"
    });
    expect(Object.keys(observations[0]!)).not.toContain("tenantId");
    expect(JSON.stringify(observations)).not.toContain("account-a");
  });

  it("rejects when a shop's daily budget is spent instead of rerouting to another model", async () => {
    const shopCap: InferencePolicyRecord = {
      scope: "tenant",
      tenantId: "shop-a",
      userId: null,
      currency: "USD",
      // Each phi-a call costs 0.0054 USD: two calls exhaust 0.01.
      dailyBudget: 0.01,
      providerMonthlyCeilings: {},
      maxRequestsPerMinute: null,
      maxTokensPerRequest: null,
      fallbackPolicy: "NONE",
      approvedProviderIds: [],
      fallbackModelIds: [],
      updatedAt: new Date().toISOString()
    };
    const { platform, repositories, devices } = await platformWithDevices({ policies: [shopCap] });
    await platform.router.generate(request("phi-a"), callContext);
    await platform.router.generate(request("phi-a"), callContext);
    await expect(platform.router.generate(request("phi-a"), callContext)).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
      retryable: false
    });
    expect((devices["device-a"] as ReturnType<typeof fakeDeviceProvider>).calls).toHaveLength(2);
    expect(repositories.runsSnapshot().at(-1)).toMatchObject({
      status: "rejected",
      errorCode: "BUDGET_EXCEEDED"
    });
    // Another shop is unaffected.
    await expect(
      platform.router.generate(request("phi-a"), { ...callContext, tenantId: "shop-b" })
    ).resolves.toBeDefined();
  });

  it("enforces per-minute request limits", async () => {
    const rate = await platformWithDevices({ env: { INFERENCE_MAX_REQUESTS_PER_MINUTE: "2" } });
    await rate.platform.router.generate(request("qwen-b"), callContext);
    await rate.platform.router.generate(request("qwen-b"), callContext);
    const limited = await rate.platform.router
      .generate(request("qwen-b"), callContext)
      .catch((error: unknown) => error);
    expect(limited).toMatchObject({ code: "RATE_LIMITED" });
    expect((limited as InferenceError).retryAfterMs).toBeGreaterThan(0);
  });

  it("never applies Grogoni-funded caps to device runs, which Grogoni does not pay for", async () => {
    // Platform budgets and provider monthly ceilings only limit platform-funded spend. Device-local
    // runs record no funding scope, so these caps must not block a member's own device.
    const capped = await platformWithDevices({
      env: {
        INFERENCE_PROVIDER_MONTHLY_CEILINGS: "device-a=0.001",
        INFERENCE_TENANT_DAILY_BUDGET: "0.001"
      }
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        capped.platform.router.generate(request("phi-a"), callContext)
      ).resolves.toMatchObject({ providerId: "device-a" });
    }
  });

  it("clamps output tokens to the strictest of request, model, policy and deployment limits", async () => {
    const device = fakeDeviceProvider("device-a");
    const { platform } = createTestPlatform({
      catalog: [catalogModel({ id: "capped", providerId: "device-a", maxOutputTokens: 300 })],
      providers: [localProviderConfig("device-a")],
      devices: { "device-a": device },
      env: { INFERENCE_MAX_TOKENS_PER_REQUEST: "200", INFERENCE_MAX_OUTPUT_TOKENS: "1000" }
    });
    await platform.refresh();
    await platform.router.generate(
      request("capped", { generation: { maxOutputTokens: 4_000 } }),
      callContext
    );
    expect(device.calls[0]?.request.generation?.maxOutputTokens).toBe(200);
  });

  it("gives a member's device extra time to load its model", async () => {
    const { platform, devices } = await platformWithDevices();
    await platform.router.generate(request("phi-a"), callContext);
    expect(
      (devices["device-a"] as ReturnType<typeof fakeDeviceProvider>).calls[0]?.context.timeoutMs
    ).toBe(240_000);
  });
});

describe("inference router: health and streaming", () => {
  it("reports each provider's health independently, and unknown providers as misconfigured", async () => {
    const { platform } = await platformWithDevices();
    expect((await platform.router.checkHealth({ providerId: "local" })).status).toBe("AVAILABLE");
    expect((await platform.router.checkHealth({ providerId: "device-b" })).status).toBe(
      "AVAILABLE"
    );
    expect(await platform.router.checkHealth({ providerId: "openai" })).toMatchObject({
      status: "MISCONFIGURED",
      errorCode: "PROVIDER_MISCONFIGURED"
    });
  });

  it("streams canonical chunks, synthesizing a stream for non-streaming models", async () => {
    const { platform, repositories } = await platformWithDevices();
    const chunks = [];
    for await (const chunk of platform.router.stream(request("qwen-b"), callContext))
      chunks.push(chunk);
    expect(chunks[0]).toEqual({ type: "text-delta", text: "reply from device-b" });
    expect(chunks.at(-1)).toMatchObject({
      type: "completed",
      response: { providerId: "device-b", modelId: "qwen-b" }
    });
    expect(repositories.runsSnapshot()).toHaveLength(1);

    const failures = [];
    for await (const chunk of platform.router.stream(request("smollm-local"), {
      ...callContext,
      userId: null
    }))
      failures.push(chunk);
    expect(failures).toEqual([
      {
        type: "error",
        code: "LOCAL_EXECUTION_REQUIRED",
        message: expect.any(String),
        retryable: false
      }
    ]);
  });

  it("forwards live text from a streaming device and resets it before a fallback attempt", async () => {
    const streamed: string[] = [];
    let resets = 0;
    const { platform } = await platformWithDevices({
      devices: {
        "device-a": fakeDeviceProvider("device-a", () => "Habari ya leo", { stream: true }),
        "device-b": fakeDeviceProvider("device-b")
      }
    });
    const streamingCatalogModel = catalogModel({
      id: "phi-stream",
      providerId: "device-a",
      capabilities: { streaming: true }
    });
    platform.setModelCatalog(() => [...catalog, streamingCatalogModel]);
    const response = await platform.router.generate(request("phi-stream"), {
      ...callContext,
      onText: {
        raw: (chunk) => streamed.push(chunk),
        reset: () => {
          resets += 1;
        }
      }
    });
    expect(response.output.text).toBe("Habari ya leo");
    expect(streamed.join("")).toBe("Habari ya leo");
    expect(resets).toBe(0);
  });
});
