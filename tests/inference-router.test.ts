import { describe, expect, it } from "vitest";

import type { InferenceRequest } from "../services/api/src/inference/providers/contract";
import { secretBoxCipher } from "../services/api/src/inference/providers/credentials";
import { InferenceError } from "../services/api/src/inference/providers/errors";
import type { InferenceObservation } from "../services/api/src/inference/providers/inference-router";
import type { InferencePolicyRecord } from "../services/api/src/inference/providers/repositories";
import { estimateCost } from "../services/api/src/inference/providers/usage-policy";
import { DeviceInferenceBroker } from "../services/api/src/inference/device-inference-broker";
import {
  anthropicMessage,
  catalogModel,
  createTestPlatform,
  jsonResponse,
  openAiCompletion,
  scriptedFetch,
  testSecrets,
  type RecordedRequest
} from "./fixtures/inference-provider-fakes";

const catalog = [
  catalogModel({
    id: "gpt-test",
    providerId: "openai",
    providerModelId: "gpt-vendor-id",
    pricing: {
      inputPerMillionTokens: 2,
      outputPerMillionTokens: 8,
      cachedInputPerMillionTokens: 0.5,
      currency: "USD"
    }
  }),
  catalogModel({
    id: "gpt-mini-test",
    providerId: "openai",
    providerModelId: "gpt-mini-vendor-id"
  }),
  catalogModel({ id: "claude-test", providerId: "anthropic", providerModelId: "claude-vendor-id" }),
  catalogModel({ id: "glm-test", providerId: "zai-general", providerModelId: "glm-vendor-id" }),
  catalogModel({ id: "qwen3-4b-cloud", providerId: "grogoni-llama", providerModelId: "qwen3-4b" }),
  catalogModel({
    id: "smollm-local",
    providerId: "local",
    providerModelId: "smollm2-360m",
    executionTarget: "browser-local",
    pricing: { inputPerMillionTokens: 0, outputPerMillionTokens: 0 }
  }),
  catalogModel({ id: "disabled-test", providerId: "openai", providerModelId: "x", enabled: false }),
  catalogModel({ id: "orphan-test", providerId: "no-such-provider", providerModelId: "x" }),
  catalogModel({
    id: "tools-test",
    providerId: "openai",
    providerModelId: "tools",
    capabilities: { tools: true }
  })
];

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

/** Answers every vendor with a recognisable body so tests can tell who served the request. */
function vendorFetch(
  overrides: (request: RecordedRequest) => Response | undefined = () => undefined
) {
  return scriptedFetch((recorded) => {
    const override = overrides(recorded);
    if (override !== undefined) return override;
    if (recorded.method === "GET") return jsonResponse({ data: [] });
    if (recorded.url.includes("anthropic.com"))
      return jsonResponse(anthropicMessage({ text: "anthropic reply" }));
    const host = new URL(recorded.url).hostname;
    return jsonResponse(
      openAiCompletion({
        content: `reply from ${host}`,
        usage: { prompt_tokens: 1_000, completion_tokens: 500, cached: 400 }
      })
    );
  });
}

async function connectKey(
  platform: ReturnType<typeof createTestPlatform>["platform"],
  input: {
    scope: "tenant" | "user";
    tenantId?: string;
    userId: string;
    providerId: string;
    key: string;
  }
) {
  return platform.connections.connect({
    scope: input.scope,
    tenantId: input.tenantId ?? null,
    userId: input.userId,
    actorId: `user-of-${input.userId}`,
    providerId: input.providerId,
    apiKey: input.key
  });
}

describe("inference router: model and provider resolution", () => {
  it("routes one agent to whichever provider the selected model names", async () => {
    const { fetch, requests } = vendorFetch();
    const { platform } = createTestPlatform({ catalog, fetch });
    for (const [modelId, host] of [
      ["gpt-test", "api.openai.com"],
      ["claude-test", "api.anthropic.com"],
      ["glm-test", "api.z.ai"],
      ["qwen3-4b-cloud", "inference.grogoni.example"]
    ] as const) {
      const response = await platform.router.generate(request(modelId), callContext);
      expect(response.modelId).toBe(modelId);
      expect(new URL(requests.at(-1)?.url ?? "").hostname).toBe(host);
    }
    expect(new Set(requests.map((recorded) => recorded.body?.model))).toEqual(
      new Set(["gpt-vendor-id", "claude-vendor-id", "glm-vendor-id", "qwen3-4b"])
    );
  });

  it("fails each resolution step with its own normalized code before any network call", async () => {
    const { fetch, requests } = vendorFetch();
    const { platform } = createTestPlatform({ catalog, fetch });
    const resolve = (
      modelId: string,
      extra: Partial<Parameters<typeof platform.router.resolveInferenceTarget>[0]> = {}
    ) =>
      platform.router
        .resolveInferenceTarget({
          agentId: "agent-1",
          modelId,
          tenantId: null,
          userId: null,
          ...extra
        })
        .catch((error: unknown) => (error as InferenceError).code);
    expect(await resolve("gpt-test", { agentId: " " })).toBe("INFERENCE_FAILED");
    expect(await resolve("not-in-catalog")).toBe("MODEL_UNAVAILABLE");
    expect(await resolve("disabled-test")).toBe("MODEL_UNAVAILABLE");
    expect(await resolve("orphan-test")).toBe("PROVIDER_MISCONFIGURED");
    expect(
      await resolve("gpt-test", {
        request: request("gpt-test", {
          tools: [{ name: "products.list", description: "x", inputSchema: { type: "object" } }]
        })
      })
    ).toBe("CAPABILITY_UNSUPPORTED");
    expect(await resolve("smollm-local")).toBe("LOCAL_EXECUTION_REQUIRED");
    expect(requests).toHaveLength(0);
  });

  it("never silently picks a model: no binding model and no configured default is an error", async () => {
    const { fetch } = vendorFetch();
    const { platform } = createTestPlatform({ catalog, fetch });
    expect(() => platform.router.resolveModelId(null)).toThrow(InferenceError);
    const withDefault = createTestPlatform({
      catalog,
      fetch,
      env: { INFERENCE_DEFAULT_MODEL: "glm-test" }
    });
    expect(withDefault.platform.router.resolveModelId(undefined)).toBe("glm-test");
  });

  it("never sends a device-local model anywhere but the requesting member's own device", async () => {
    const { fetch, requests } = vendorFetch();
    const { platform, repositories } = createTestPlatform({ catalog, fetch });
    // An anonymous caller (no member to hand the job to) is refused outright.
    await expect(
      platform.router.generate(request("smollm-local"), { ...callContext, userId: null })
    ).rejects.toMatchObject({ code: "LOCAL_EXECUTION_REQUIRED", retryable: false });

    // An identified member: the prompt goes to that member's device, never to a provider.
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
    const response = await pending;
    expect(response).toMatchObject({
      providerId: "local",
      output: { text: '{"type":"response","message":"from the device"}' },
      usage: { inputTokens: 40, outputTokens: 8 },
      cost: { estimatedAmount: 0 }
    });
    expect(requests).toHaveLength(0);
    expect(repositories.runsSnapshot().at(-1)).toMatchObject({
      providerId: "local",
      executionTarget: "browser-local",
      credentialScope: null,
      status: "succeeded"
    });
  });

  it("fails clearly, without switching models, when no device with the model is online", async () => {
    const { fetch, requests } = vendorFetch();
    const { platform } = createTestPlatform({
      catalog,
      fetch,
      options: { deviceBroker: new DeviceInferenceBroker({ claimTimeoutMs: 20 }) }
    });
    await expect(
      platform.router.generate(request("smollm-local"), callContext)
    ).rejects.toMatchObject({
      code: "LOCAL_DEVICE_UNAVAILABLE"
    });
    expect(requests).toHaveLength(0);
  });

  it("exposes each routed model to the agent runtime only on its own target", () => {
    const { fetch } = vendorFetch();
    const { platform } = createTestPlatform({ catalog, fetch });
    expect(
      platform.adapterFor({ modelId: "claude-test", executionTarget: "backend" })?.provider
    ).toBe("anthropic");
    expect(
      platform.adapterFor({ modelId: "claude-test", executionTarget: "vercel" })
    ).toBeUndefined();
    expect(
      platform.adapterFor({ modelId: "orphan-test", executionTarget: "backend" })
    ).toBeUndefined();
    expect(platform.hostedExecutionTargetFor("glm-test")).toBe("backend");
    expect(platform.hostedExecutionTargetFor("smollm-local")).toBe("browser-local");
    expect(
      platform.adapterFor({ modelId: "smollm-local", executionTarget: "browser-local" })
        ?.executionTarget
    ).toBe("browser-local");
    expect(
      platform.adapterFor({ modelId: "smollm-local", executionTarget: "backend" })
    ).toBeUndefined();
  });
});

describe("inference router: credential precedence and BYOK isolation", () => {
  it("uses tenant BYOK, then user BYOK, then the Grogoni-managed key", async () => {
    const { fetch, requests } = vendorFetch();
    const { platform } = createTestPlatform({ catalog, fetch });
    const authorizationOfLastCall = () => requests.at(-1)?.headers.authorization;

    await platform.router.generate(request("gpt-test"), callContext);
    expect(authorizationOfLastCall()).toBe(`Bearer ${testSecrets.openai}`);

    await connectKey(platform, {
      scope: "user",
      userId: "account-a",
      providerId: "openai",
      key: "sk-user-a-key-000000000000000000UUUU"
    });
    await platform.router.generate(request("gpt-test"), callContext);
    expect(authorizationOfLastCall()).toBe("Bearer sk-user-a-key-000000000000000000UUUU");

    await connectKey(platform, {
      scope: "tenant",
      tenantId: "shop-a",
      userId: "account-a",
      providerId: "openai",
      key: "sk-tenant-a-key-0000000000000000TTTT"
    });
    await platform.router.generate(request("gpt-test"), callContext);
    expect(authorizationOfLastCall()).toBe("Bearer sk-tenant-a-key-0000000000000000TTTT");

    // Explicit scope narrows resolution and never falls through to another payer.
    await platform.router.generate(request("gpt-test"), {
      ...callContext,
      explicitCredentialScope: "platform"
    });
    expect(authorizationOfLastCall()).toBe(`Bearer ${testSecrets.openai}`);
    await expect(
      platform.router.generate(request("gpt-test"), {
        ...callContext,
        tenantId: "shop-without-key",
        explicitCredentialScope: "tenant"
      })
    ).rejects.toMatchObject({ code: "CREDENTIAL_MISSING" });
  });

  it("never lets one tenant or user resolve another's credential", async () => {
    const { fetch, requests } = vendorFetch();
    const { platform } = createTestPlatform({ catalog, fetch, env: { OPENAI_API_KEY: "" } });
    await connectKey(platform, {
      scope: "tenant",
      tenantId: "shop-a",
      userId: "account-a",
      providerId: "openai",
      key: "sk-tenant-a-only-000000000000000AAAA"
    });
    await connectKey(platform, {
      scope: "user",
      userId: "account-a",
      providerId: "openai",
      key: "sk-account-a-only-00000000000000BBBB"
    });

    await expect(
      platform.router.generate(request("gpt-test"), {
        agentId: "agent-b",
        tenantId: "shop-b",
        userId: "account-b"
      })
    ).rejects.toMatchObject({ code: "CREDENTIAL_MISSING" });
    expect(requests).toHaveLength(2); // only the two connect-time verifications

    const tenantB = await platform.credentials.resolve({
      provider: platform.registry.get("openai")!.config,
      tenantId: "shop-b",
      userId: "account-b"
    });
    expect(tenantB).toBeNull();
  });

  it("stores only ciphertext and revokes by erasing it", async () => {
    const { fetch } = vendorFetch();
    const { platform, repositories } = createTestPlatform({ catalog, fetch });
    const key = "sk-plaintext-must-not-persist-000000ZZZZ";
    const summary = await connectKey(platform, {
      scope: "user",
      userId: "account-a",
      providerId: "openai",
      key
    });
    const stored = await repositories.credentials.get(summary.id);
    expect(stored?.encryptedSecret).toMatch(/^v1:/u);
    expect(JSON.stringify(stored)).not.toContain(key);
    expect(secretBoxCipher.decrypt(stored!.encryptedSecret!, stored!.keyVersion)).toBe(key);
    expect(summary).toMatchObject({ connected: true, status: "ACTIVE", secretHint: "ZZZZ" });
    expect(JSON.stringify(summary)).not.toContain(key);

    await platform.connections.disconnect(stored!);
    const revoked = await repositories.credentials.get(summary.id);
    expect(revoked).toMatchObject({ status: "REVOKED", encryptedSecret: null });
  });

  it("replacing a key keeps exactly one active credential", async () => {
    const { fetch } = vendorFetch();
    const { platform, repositories } = createTestPlatform({ catalog, fetch });
    const first = await connectKey(platform, {
      scope: "user",
      userId: "account-a",
      providerId: "anthropic",
      key: "sk-ant-first-key-000000000000001111"
    });
    const second = await connectKey(platform, {
      scope: "user",
      userId: "account-a",
      providerId: "anthropic",
      key: "sk-ant-second-key-00000000000002222"
    });
    const all = await repositories.credentials.listForOwner({ userId: "account-a" });
    expect(all.filter((record) => record.status === "ACTIVE").map((record) => record.id)).toEqual([
      second.id
    ]);
    expect(all.find((record) => record.id === first.id)).toMatchObject({
      status: "REVOKED",
      encryptedSecret: null
    });
  });

  it("rejects a key the provider refuses without storing it", async () => {
    const { fetch } = vendorFetch((recorded) =>
      recorded.method === "GET" ? jsonResponse({ error: "bad key" }, 401) : undefined
    );
    const { platform, repositories } = createTestPlatform({ catalog, fetch });
    await expect(
      connectKey(platform, {
        scope: "user",
        userId: "account-a",
        providerId: "openai",
        key: "sk-rejected-key-000000000000000000"
      })
    ).rejects.toMatchObject({ statusCode: 401, code: "inference_api_key_rejected" });
    expect(await repositories.credentials.listForOwner({ userId: "account-a" })).toHaveLength(0);
  });

  it("keeps Z.ai general and coding plans as distinct, non-interchangeable providers", async () => {
    const { fetch } = vendorFetch();
    const { platform } = createTestPlatform({
      catalog,
      fetch,
      env: {
        ZAI_CODING_BASE_URL: "https://api.z.ai/api/coding/paas/v4",
        ZAI_CODING_API_KEY: "zai-coding-key-00000000000000000"
      }
    });
    const general = platform.registry.get("zai-general")!.config;
    const coding = platform.registry.get("zai-coding")!.config;
    expect(general.billingProduct).toBe("zai-general");
    expect(coding.billingProduct).toBe("zai-coding");
    expect(coding.byokAllowed).toBe(false);
    // The general model never resolves the coding key.
    const resolved = await platform.credentials.resolve({
      provider: general,
      tenantId: null,
      userId: null
    });
    expect(resolved?.secret.reveal()).toBe(testSecrets.zai);
  });
});

describe("inference router: fallback policy", () => {
  function failingOpenAi() {
    return vendorFetch((recorded) =>
      recorded.method === "POST" && recorded.url.includes("api.openai.com")
        ? jsonResponse({ error: "down" }, 503)
        : undefined
    );
  }
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

  it("defaults to NONE: a provider failure never moves the conversation elsewhere", async () => {
    const { fetch, requests } = failingOpenAi();
    const { platform } = createTestPlatform({ catalog, fetch });
    await expect(platform.router.generate(request("gpt-test"), callContext)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE"
    });
    expect(requests.every((recorded) => recorded.url.includes("api.openai.com"))).toBe(true);
  });

  it("SAME_PROVIDER only moves to another model of the same provider", async () => {
    const { fetch, requests } = failingOpenAi();
    const { platform } = createTestPlatform({
      catalog,
      fetch,
      policies: [
        policy({
          fallbackPolicy: "SAME_PROVIDER",
          fallbackModelIds: ["claude-test", "gpt-mini-test"]
        })
      ]
    });
    await expect(platform.router.generate(request("gpt-test"), callContext)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE"
    });
    expect(requests.some((recorded) => recorded.url.includes("anthropic"))).toBe(false);
    expect(
      requests.filter((recorded) => recorded.body?.model === "gpt-mini-vendor-id")
    ).toHaveLength(1);
  });

  it("APPROVED_PROVIDERS crosses providers only to approved ones, and records it", async () => {
    const { fetch } = failingOpenAi();
    const { platform, repositories } = createTestPlatform({
      catalog,
      fetch,
      policies: [
        policy({
          fallbackPolicy: "APPROVED_PROVIDERS",
          approvedProviderIds: ["anthropic"],
          fallbackModelIds: ["glm-test", "claude-test"]
        })
      ]
    });
    const response = await platform.router.generate(request("gpt-test"), callContext);
    expect(response).toMatchObject({
      providerId: "anthropic",
      modelId: "claude-test",
      fallbackFromProviderId: "openai"
    });
    const runs = repositories.runsSnapshot();
    expect(runs.map((run) => [run.providerId, run.status])).toEqual([
      ["openai", "failed"],
      ["anthropic", "succeeded"]
    ]);
    expect(runs[1]?.fallbackFromProviderId).toBe("openai");
  });

  it("never falls back after a policy rejection such as a rejected key", async () => {
    const { fetch, requests } = vendorFetch((recorded) =>
      recorded.url.includes("api.openai.com")
        ? jsonResponse({ error: "invalid key" }, 401)
        : undefined
    );
    const { platform } = createTestPlatform({
      catalog,
      fetch,
      policies: [
        policy({
          fallbackPolicy: "APPROVED_PROVIDERS",
          approvedProviderIds: ["anthropic"],
          fallbackModelIds: ["claude-test"]
        })
      ]
    });
    await expect(platform.router.generate(request("gpt-test"), callContext)).rejects.toMatchObject({
      code: "INVALID_CREDENTIAL"
    });
    expect(requests.some((recorded) => recorded.url.includes("anthropic"))).toBe(false);
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

  it("records runs with tokens, cost and credential scope but never the prompt", async () => {
    const { fetch } = vendorFetch();
    const observations: InferenceObservation[] = [];
    const { platform, repositories } = createTestPlatform({
      catalog,
      fetch,
      options: { metrics: { recordInference: (observation) => observations.push(observation) } }
    });
    const response = await platform.router.generate(request("gpt-test"), {
      ...callContext,
      conversationId: "conv-1"
    });
    expect(response.cost).toEqual({ currency: "USD", estimatedAmount: 0.0054 });
    const [run] = repositories.runsSnapshot();
    expect(run).toMatchObject({
      requestId: "req-gpt-test",
      conversationId: "conv-1",
      agentId: "agent-1",
      modelId: "gpt-test",
      providerId: "openai",
      credentialScope: "platform",
      executionTarget: "remote-inference",
      inputTokens: 1_000,
      outputTokens: 500,
      cachedInputTokens: 400,
      estimatedCost: 0.0054,
      currency: "USD",
      status: "succeeded"
    });
    expect(JSON.stringify(run)).not.toContain("SECRET-PROMPT-CONTENT");
    expect(JSON.stringify(run)).not.toContain(testSecrets.openai);
    expect(observations[0]).toMatchObject({
      provider: "openai",
      model: "gpt-test",
      status: "succeeded"
    });
    expect(Object.keys(observations[0]!)).not.toContain("tenantId");
    expect(JSON.stringify(observations)).not.toContain("account-a");
  });

  it("rejects when a daily budget is spent instead of rerouting to another model", async () => {
    const { fetch, requests } = vendorFetch();
    const { platform, repositories } = createTestPlatform({
      catalog,
      fetch,
      // Each call costs 0.0054 USD (see the pricing test above): two calls exhaust 0.01.
      env: { INFERENCE_TENANT_DAILY_BUDGET: "0.01" }
    });
    await platform.router.generate(request("gpt-test"), callContext);
    await platform.router.generate(request("gpt-test"), callContext);
    const callsBefore = requests.length;
    await expect(platform.router.generate(request("gpt-test"), callContext)).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
      retryable: false
    });
    expect(requests).toHaveLength(callsBefore);
    expect(repositories.runsSnapshot().at(-1)).toMatchObject({
      status: "rejected",
      errorCode: "BUDGET_EXCEEDED"
    });
    // Another tenant is unaffected.
    await expect(
      platform.router.generate(request("gpt-test"), { ...callContext, tenantId: "shop-b" })
    ).resolves.toBeDefined();
  });

  it("enforces provider monthly ceilings and per-minute request limits", async () => {
    const { fetch } = vendorFetch();
    const ceiling = createTestPlatform({
      catalog,
      fetch,
      env: { INFERENCE_PROVIDER_MONTHLY_CEILINGS: "openai=0.001" }
    });
    await ceiling.platform.router.generate(request("gpt-test"), callContext);
    await expect(
      ceiling.platform.router.generate(request("gpt-test"), callContext)
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    await expect(
      ceiling.platform.router.generate(request("claude-test"), callContext)
    ).resolves.toBeDefined();

    const rate = createTestPlatform({
      catalog,
      fetch,
      env: { INFERENCE_MAX_REQUESTS_PER_MINUTE: "2" }
    });
    await rate.platform.router.generate(request("glm-test"), callContext);
    await rate.platform.router.generate(request("glm-test"), callContext);
    const limited = await rate.platform.router
      .generate(request("glm-test"), callContext)
      .catch((error: unknown) => error);
    expect(limited).toMatchObject({ code: "RATE_LIMITED" });
    expect((limited as InferenceError).retryAfterMs).toBeGreaterThan(0);
  });

  it("clamps output tokens to the strictest of request, model, policy and deployment limits", async () => {
    const { fetch, requests } = vendorFetch();
    const { platform } = createTestPlatform({
      catalog: [
        catalogModel({
          id: "capped",
          providerId: "grogoni-llama",
          providerModelId: "q",
          maxOutputTokens: 300
        })
      ],
      fetch,
      env: { INFERENCE_MAX_TOKENS_PER_REQUEST: "200", INFERENCE_MAX_OUTPUT_TOKENS: "1000" }
    });
    await platform.router.generate(
      request("capped", { generation: { maxOutputTokens: 4_000 } }),
      callContext
    );
    expect(requests[0]?.body?.max_tokens).toBe(200);
  });
});

describe("inference router: health isolation and streaming", () => {
  it("reports each provider's health independently", async () => {
    const { fetch } = vendorFetch((recorded) =>
      recorded.url.includes("api.openai.com") ? jsonResponse({}, 503) : undefined
    );
    const { platform } = createTestPlatform({ catalog, fetch });
    const openai = await platform.router.checkHealth({
      providerId: "openai",
      tenantId: null,
      userId: null
    });
    const anthropic = await platform.router.checkHealth({
      providerId: "anthropic",
      tenantId: null,
      userId: null
    });
    const llama = await platform.router.checkHealth({
      providerId: "grogoni-llama",
      tenantId: null,
      userId: null
    });
    expect(openai.status).toBe("UNAVAILABLE");
    expect(anthropic.status).toBe("AVAILABLE");
    expect(llama.status).toBe("AVAILABLE");
    const missing = createTestPlatform({ catalog, fetch, env: { ANTHROPIC_API_KEY: "" } });
    expect(
      (
        await missing.platform.router.checkHealth({
          providerId: "anthropic",
          tenantId: null,
          userId: null
        })
      ).status
    ).toBe("CREDENTIAL_INVALID");
  });

  it("opens a provider circuit after repeated provider faults without affecting other providers", async () => {
    const { fetch } = vendorFetch((recorded) =>
      recorded.method === "POST" && recorded.url.includes("api.openai.com")
        ? jsonResponse({}, 500)
        : undefined
    );
    const { platform } = createTestPlatform({ catalog, fetch });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await platform.router.generate(request("gpt-test"), callContext).catch(() => undefined);
    }
    await expect(
      platform.router.resolveInferenceTarget({
        agentId: "a",
        modelId: "gpt-test",
        tenantId: null,
        userId: null
      })
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    await expect(
      platform.router.generate(request("claude-test"), callContext)
    ).resolves.toMatchObject({ providerId: "anthropic" });
  });

  it("streams canonical chunks, synthesizing a stream for non-streaming models", async () => {
    const { fetch } = vendorFetch();
    const { platform, repositories } = createTestPlatform({ catalog, fetch });
    const chunks = [];
    for await (const chunk of platform.router.stream(request("glm-test"), callContext))
      chunks.push(chunk);
    expect(chunks[0]).toEqual({ type: "text-delta", text: "reply from api.z.ai" });
    expect(chunks.at(-1)).toMatchObject({
      type: "completed",
      response: { providerId: "zai-general", modelId: "glm-test" }
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
});
