import { describe, expect, it, vi } from "vitest";
import type {
  ModelExecutionTarget,
  NativeExecutionHostSummary,
  NativeRuntimeAgentSummary,
  NativeRuntimeBindingModelSummary,
  NativeRuntimeBindingSummary,
  NativeRuntimeModelSummary,
  ResolvedNativeRuntimeBinding,
  ResolvedNativeRuntimeModel,
  RuntimeModelProvider,
  ShopAgentRuntime
} from "../packages/shared-types/src";
import { isModelExecutionTarget, modelExecutionTargets } from "../packages/shared-types/src";
import { Cp2Error } from "../services/api/src/cp2/cp2-error";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import {
  resolveExecutionTarget,
  resolveNativeRuntimeModelProvider
} from "../services/api/src/cp2/domains/agent-runtime/native-runtime-routing";
import type { ModelRuntimeAdapter } from "../services/api/src/inference/model-runtime";

const modelId = "qwen2.5-0.5b-android";
const agentId = "agent-1";
const shopId = "shop-1";

describe("resolveExecutionTarget - the single authoritative execution-target resolver", () => {
  it("prefers the selected native execution host over model-level compatibility metadata", () => {
    const resolution = resolveExecutionTarget({
      nativeResolution: nativeResolution({
        configuredTarget: "remote-shop-device",
        hostType: "backend"
      }),
      modelId,
      agentId
    });
    expect(resolution).toEqual({
      target: "backend",
      source: "explicit-native-host"
    });
  });

  it("uses the declared model configuration when no host exists", () => {
    const resolution = resolveExecutionTarget({
      nativeResolution: nativeResolution({ configuredTarget: "remote-shop-device" }),
      modelId,
      agentId
    });
    expect(resolution).toEqual({
      target: "remote-shop-device",
      source: "explicit-native-configuration"
    });
  });

  it("falls back to the resolved host's type when configuration.executionTarget is missing", () => {
    // Simulates a native model row written before configuration.executionTarget existed, or
    // restored from a partial snapshot - the durable host record is still a genuine signal.
    const resolution = resolveExecutionTarget({
      nativeResolution: nativeResolution({
        configuredTarget: undefined,
        hostType: "remote-shop-device"
      }),
      modelId,
      agentId
    });
    expect(resolution).toEqual({ target: "remote-shop-device", source: "explicit-native-host" });
  });

  it("throws NO_COMPATIBLE_EXECUTION_TARGET when there is no native resolution at all", () => {
    // The retired legacy-binding fallback tier is gone - the native runtime graph is the only
    // source of truth now, so no resolution means a genuine routing failure, not a silent
    // fallback to some other representation.
    expect(() => resolveExecutionTarget({ nativeResolution: null, modelId, agentId })).toThrow(
      Cp2Error
    );
  });

  it("exposes exactly the provider-neutral targets and rejects provider names", () => {
    // browser-local / installed-app are location targets (ADR-explicit-device-local-models.md),
    // not providers.
    expect(modelExecutionTargets).toEqual([
      "local",
      "vercel",
      "backend",
      "remote-shop-device",
      "browser-local",
      "installed-app"
    ]);
    expect(isModelExecutionTarget("openai")).toBe(false);
    expect(isModelExecutionTarget("anthropic")).toBe(false);

    // @ts-expect-error Provider identifiers must never satisfy ModelExecutionTarget.
    const providerAsTarget: ModelExecutionTarget = "openai";
    expect(isModelExecutionTarget(providerAsTarget)).toBe(false);
  });

  it("rejects the legacy provider name at the HTTP execution-target boundary", async () => {
    const app = buildApi();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/agents/agent-1/models/model-1/activate",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({
          shopId,
          executionTarget: "openai",
          executionMode: "CLOUD_ONLY",
          permissions: { allowRemoteShopDevice: false }
        })
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "execution_target_invalid" });
    } finally {
      await app.close();
    }
  });

  it(
    "does not default native model resolution to backend when executionTarget is absent " +
      "(regression: never guess backend)",
    () => {
      for (const nr of [
        null,
        nativeResolution({ configuredTarget: undefined, hostType: undefined })
      ]) {
        expect(() => resolveExecutionTarget({ nativeResolution: nr, modelId, agentId })).toThrow(
          Cp2Error
        );
        try {
          resolveExecutionTarget({ nativeResolution: nr, modelId, agentId });
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(Cp2Error);
          const cp2Error = error as Cp2Error;
          expect(cp2Error.code).toBe("NO_COMPATIBLE_EXECUTION_TARGET");
          expect(cp2Error.code).not.toBe("backend");
          expect(cp2Error.details).toMatchObject({ modelId, agentId });
        }
      }
    }
  );
});

describe("resolveNativeRuntimeModelProvider - adapter wiring around the resolved target", () => {
  const shopRuntime = { agentId, shopId } as unknown as ShopAgentRuntime;

  it("routes an explicit backend target to a backend adapter when a host is eligible", () => {
    const adapter = fakeAdapter("backend");
    const requireAdapter = vi.fn(() => adapter);
    const result = resolveNativeRuntimeModelProvider({
      shopRuntime,
      requestedModelId: modelId,
      nativeResolution: nativeResolution({ configuredTarget: "backend", hostType: "backend" }),
      requireAdapter,
      adapterResolverConfigured: true
    });
    expect(result.executionTarget).toBe("backend");
    expect(result.resolutionSource).toBe("explicit-native-host");
    expect(requireAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ modelId, executionTarget: "backend", agentId })
    );
    expect(result.provider).toBeDefined();
  });

  it(
    "never fails routing over an unresolved target when no adapter system is even wired up " +
      "(regression: broke every test harness that drives runtimeModelProvider directly)",
    () => {
      const runtimeModelProvider = {
        name: "test",
        complete: vi.fn()
      } as unknown as RuntimeModelProvider;
      const requireAdapter = vi.fn(() => fakeAdapter("backend"));
      const result = resolveNativeRuntimeModelProvider({
        shopRuntime,
        requestedModelId: modelId,
        nativeResolution: null,
        requireAdapter,
        adapterResolverConfigured: false,
        runtimeModelProvider
      });
      // adapterResolverConfigured: false means executionTarget is never used to route anything -
      // requireAdapter must never even be consulted, and the provider passed straight through comes
      // from runtimeModelProvider/runtimeModelProviderResolver regardless of whether a target could
      // be resolved at all.
      expect(requireAdapter).not.toHaveBeenCalled();
      expect(result.provider).toBe(runtimeModelProvider);
      expect(result.executionTarget).toBeUndefined();
      expect(result.resolutionSource).toBeNull();
    }
  );

  it("surfaces the RUNTIME_NOT_CONFIGURED code (no eligible host) when backend has no adapter", () => {
    const requireAdapter = vi.fn(() => {
      throw new Cp2Error(
        503,
        "RUNTIME_NOT_CONFIGURED",
        "The selected model runtime is not configured."
      );
    });
    expectCp2ErrorCode(
      () =>
        resolveNativeRuntimeModelProvider({
          shopRuntime,
          requestedModelId: modelId,
          nativeResolution: nativeResolution({ configuredTarget: "backend", hostType: "backend" }),
          requireAdapter,
          adapterResolverConfigured: true
        }),
      "RUNTIME_NOT_CONFIGURED"
    );
  });

  it("throws NO_COMPATIBLE_EXECUTION_TARGET before ever calling requireAdapter (no network attempt)", () => {
    const requireAdapter = vi.fn(() => fakeAdapter("backend"));
    expectCp2ErrorCode(
      () =>
        resolveNativeRuntimeModelProvider({
          shopRuntime,
          requestedModelId: modelId,
          nativeResolution: null,
          requireAdapter,
          adapterResolverConfigured: true
        }),
      "NO_COMPATIBLE_EXECUTION_TARGET"
    );
    expect(requireAdapter).not.toHaveBeenCalled();
  });

  it("uses a hosted fallback when a local-first primary cannot execute in the API process", () => {
    const localFirst = nativeResolution({
      configuredTarget: "remote-shop-device",
      hostType: "remote-shop-device"
    });
    const hosted = nativeResolution({ configuredTarget: "backend", hostType: "backend" }).primary;
    hosted.bindingModel = {
      ...hosted.bindingModel,
      id: "role-hosted-fallback",
      role: "fallback",
      executionHostId: "host-backend"
    };
    hosted.host = hosted.host === null ? null : { ...hosted.host, id: "host-backend" };
    localFirst.fallbacks = [hosted];

    const requireAdapter = vi.fn(() => fakeAdapter("backend"));
    const result = resolveNativeRuntimeModelProvider({
      shopRuntime,
      requestedModelId: modelId,
      nativeResolution: localFirst,
      requireAdapter,
      adapterResolverConfigured: true,
      eligibleExecutionTargets: new Set(["backend"])
    });

    expect(result.executionTarget).toBe("backend");
    expect(result.fallbackIndex).toBe(1);
    expect(requireAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ modelId, executionTarget: "backend", agentId })
    );
  });

  it("throws RUNTIME_MODELS_UNAVAILABLE once every native role is ineligible - there is no legacy escape hatch left", () => {
    // The native binding's only role targets remote-shop-device, which this request's eligible
    // set excludes - eligibleExecutionTargets filters it out entirely, leaving no native
    // candidate. The retired legacy-binding fallback tier is gone, so this must fail hard rather
    // than silently routing through some other representation.
    const localOnly = nativeResolution({
      configuredTarget: "remote-shop-device",
      hostType: "remote-shop-device"
    });
    const requireAdapter = vi.fn(() => fakeAdapter("backend"));
    expectCp2ErrorCode(
      () =>
        resolveNativeRuntimeModelProvider({
          shopRuntime,
          requestedModelId: modelId,
          nativeResolution: localOnly,
          requireAdapter,
          adapterResolverConfigured: true,
          eligibleExecutionTargets: new Set(["backend"])
        }),
      "RUNTIME_MODELS_UNAVAILABLE"
    );
    expect(requireAdapter).not.toHaveBeenCalled();
  });
});

describe("resolveNativeRuntimeModelProvider - own-account credential resolution (BYO Hugging Face billing)", () => {
  const shopRuntime = { agentId, shopId } as unknown as ShopAgentRuntime;

  function resolutionWithBillingMode(
    billingMode: string | undefined,
    provider = "huggingface"
  ): ResolvedNativeRuntimeBinding {
    const base = nativeResolution({ configuredTarget: "backend", hostType: "backend" });
    // selectUnattemptedNativeResolution (inside resolveNativeRuntimeModelProvider) re-derives
    // `selected` from `primary`/`fallbacks`, not from a pre-set `.selected` field - the provider
    // override must land on `primary.model`, or it gets discarded before the function ever sees it.
    const primaryWithProvider = {
      ...base.primary,
      model: { ...base.primary.model, provider }
    };
    return {
      ...base,
      binding: {
        ...base.binding,
        configuration: billingMode === undefined ? {} : { billingMode }
      },
      primary: primaryWithProvider,
      selected: primaryWithProvider
    };
  }

  it("forwards a resolved own-account credential into the adapter context when billingMode is own-account", async () => {
    const capturedContexts: unknown[] = [];
    const requireAdapter = vi.fn(() => ({
      ...fakeAdapter("backend"),
      generate: async (input: { context: unknown }) => {
        capturedContexts.push(input.context);
        return {
          text: "{}",
          modelId,
          provider: "test",
          executionTarget: "backend" as const,
          latencyMs: 1
        };
      }
    }));
    const resolveInferenceCredential = vi.fn(() => ({ token: "hf_business_own_token" }));
    const result = resolveNativeRuntimeModelProvider({
      shopRuntime,
      requestedModelId: modelId,
      nativeResolution: resolutionWithBillingMode("own-account"),
      requireAdapter,
      adapterResolverConfigured: true,
      accountId: "account-1",
      resolveInferenceCredential
    });

    expect(resolveInferenceCredential).toHaveBeenCalledWith("account-1", "huggingface");
    await result.provider?.complete({
      message: "hi",
      allowedTools: [],
      schemaVersion: "cp11-runtime-model-v1"
    });
    expect(capturedContexts).toEqual([
      expect.objectContaining({ providerCredential: { token: "hf_business_own_token" } })
    ]);
  });

  it("never resolves a credential when billingMode is absent (the default, platform-billed path)", () => {
    const resolveInferenceCredential = vi.fn(() => ({ token: "should-never-be-used" }));
    resolveNativeRuntimeModelProvider({
      shopRuntime,
      requestedModelId: modelId,
      nativeResolution: resolutionWithBillingMode(undefined),
      requireAdapter: () => fakeAdapter("backend"),
      adapterResolverConfigured: true,
      accountId: "account-1",
      resolveInferenceCredential
    });
    expect(resolveInferenceCredential).not.toHaveBeenCalled();
  });

  it("never resolves a credential when billingMode is own-account but no accountId/resolver was supplied", () => {
    // Every existing caller that omits these two options keeps behaving exactly as before this
    // feature existed - this is the regression test for that backward-compatibility guarantee.
    const requireAdapter = vi.fn(() => fakeAdapter("backend"));
    const result = resolveNativeRuntimeModelProvider({
      shopRuntime,
      requestedModelId: modelId,
      nativeResolution: resolutionWithBillingMode("own-account"),
      requireAdapter,
      adapterResolverConfigured: true
    });
    expect(result.provider).toBeDefined();
  });

  it("degrades to no credential (platform billing) when own-account is set but the account has no usable connection", async () => {
    const resolveInferenceCredential = vi.fn(() => null);
    const capturedContexts: unknown[] = [];
    const requireAdapter = vi.fn(() => ({
      ...fakeAdapter("backend"),
      generate: async (input: { context: unknown }) => {
        capturedContexts.push(input.context);
        return {
          text: "{}",
          modelId,
          provider: "test",
          executionTarget: "backend" as const,
          latencyMs: 1
        };
      }
    }));
    const result = resolveNativeRuntimeModelProvider({
      shopRuntime,
      requestedModelId: modelId,
      nativeResolution: resolutionWithBillingMode("own-account"),
      requireAdapter,
      adapterResolverConfigured: true,
      accountId: "account-1",
      resolveInferenceCredential
    });
    expect(resolveInferenceCredential).toHaveBeenCalled();
    await result.provider?.complete({
      message: "hi",
      allowedTools: [],
      schemaVersion: "cp11-runtime-model-v1"
    });
    expect(capturedContexts[0]).not.toHaveProperty("providerCredential");
  });
});

describe("zero-setup local-first runtime provisioning", () => {
  it("provisions a verified local Ollama binding for first chat without manual activation", async () => {
    const localGenerate = vi.fn(async () => ({
      text: JSON.stringify({ type: "response", message: "Grogoni AI is ready." }),
      modelId: "smollm2-360m",
      provider: "test-ollama-adapter",
      executionTarget: "local" as const,
      latencyMs: 2
    }));
    const store = createCp2Store({
      modelRuntimeAdapterResolver: ({ executionTarget }) =>
        executionTarget === "local"
          ? {
              provider: "test",
              executionTarget: "local",
              canRun: async () => ({ available: true, errorCode: null, message: null }),
              healthCheck: async () => {
                throw new Error("not used in this test");
              },
              generate: localGenerate
            }
          : undefined
    });
    const app = buildApi({ cp2: { store } });

    const signup = await app.inject({
      method: "POST",
      url: "/auth/pin/signup",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ method: "phone", contact: "+254700009001", pin: "1234" })
    });
    expect(signup.statusCode).toBe(200);
    const setCookieHeader = signup.headers["set-cookie"];
    const rawCookie = (
      Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader
    ) as string;
    const cookie = rawCookie.split(";")[0] as string;

    const businessResponse = await app.inject({
      method: "POST",
      url: "/businesses",
      headers: { "content-type": "application/json", cookie },
      payload: JSON.stringify({ name: "Fresh Shop", language: "en" })
    });
    expect(businessResponse.statusCode).toBe(200);
    const businessId = businessResponse.json<{ business: { id: string } }>().business.id;

    const conversation = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      headers: { "content-type": "application/json", cookie },
      payload: JSON.stringify({ kind: "personal", activeShopId: businessId })
    });
    expect(conversation.statusCode).toBe(200);
    const conversationId = conversation.json<{ conversation: { id: string } }>().conversation.id;

    const turn = await app.inject({
      method: "POST",
      url: `/businesses/${businessId}/runtime/turns`,
      headers: { "content-type": "application/json", cookie },
      payload: JSON.stringify({ conversationId, message: "hello" })
    });

    expect(turn.statusCode).toBe(200);
    expect(localGenerate).toHaveBeenCalledOnce();
    expect(turn.json()).toMatchObject({
      turn: {
        response: "Grogoni AI is ready.",
        model: {
          status: "available",
          modelId: "smollm2-360m",
          executionTarget: "local",
          fallbackIndex: 0
        }
      }
    });
    const provisioned = store
      .snapshot()
      .nativeRuntimeBindings.filter(
        (binding) =>
          binding.businessId === businessId &&
          binding.configuration.source === "zero-setup-provisioning"
      );
    expect(provisioned).toHaveLength(1);
    expect(provisioned[0]).toMatchObject({ status: "active", isDefault: true });
  });

  // Regression for the production incident: a brand-new merchant's own "chat with Grogoni AI" turn
  // never sends a conversationId (it uses runtimeSessionId, not a Conversation record). Resolution
  // used to hard-return null for every conversationId-less call, so this exact request threw
  // 409 NO_COMPATIBLE_EXECUTION_TARGET ("No execution target is configured for this model...") even
  // though the platform default (then Pi + SmolLM 360M) was fully provisionable. See
  // NativeRuntimeBindingStore.resolveRuntimeBinding and docs/architecture/runtime-resolution.md.
  it("provisions and resolves the platform default for a conversation-free runtime turn (first chat with Grogoni AI)", async () => {
    const localGenerate = vi.fn(async () => ({
      text: JSON.stringify({ type: "response", message: "Hi there!" }),
      modelId: "smollm2-360m",
      provider: "test-ollama-adapter",
      executionTarget: "local" as const,
      latencyMs: 2
    }));
    const store = createCp2Store({
      modelRuntimeAdapterResolver: ({ executionTarget }) =>
        executionTarget === "local"
          ? {
              provider: "test",
              executionTarget: "local",
              canRun: async () => ({ available: true, errorCode: null, message: null }),
              healthCheck: async () => {
                throw new Error("not used in this test");
              },
              generate: localGenerate
            }
          : undefined
    });
    const app = buildApi({ cp2: { store } });

    const signup = await app.inject({
      method: "POST",
      url: "/auth/pin/signup",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ method: "phone", contact: "+254700009002", pin: "1234" })
    });
    expect(signup.statusCode).toBe(200);
    const setCookieHeader = signup.headers["set-cookie"];
    const rawCookie = (
      Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader
    ) as string;
    const cookie = rawCookie.split(";")[0] as string;

    const businessResponse = await app.inject({
      method: "POST",
      url: "/businesses",
      headers: { "content-type": "application/json", cookie },
      payload: JSON.stringify({ name: "Untouched Shop", language: "en" })
    });
    expect(businessResponse.statusCode).toBe(200);
    const businessId = businessResponse.json<{ business: { id: string } }>().business.id;

    // No /v1/conversations call, and no conversationId in the payload - exactly what the
    // merchant's own runtime-session chat with their shop's agent sends.
    const turn = await app.inject({
      method: "POST",
      url: `/businesses/${businessId}/runtime/turns`,
      headers: { "content-type": "application/json", cookie },
      payload: JSON.stringify({ message: "Hello" })
    });

    expect(turn.statusCode).toBe(200);
    expect(localGenerate).toHaveBeenCalledOnce();
    expect(turn.json()).toMatchObject({
      turn: {
        response: "Hi there!",
        model: {
          status: "available",
          modelId: "smollm2-360m",
          executionTarget: "local"
        }
      }
    });
    const provisioned = store
      .snapshot()
      .nativeRuntimeBindings.filter(
        (binding) =>
          binding.businessId === businessId &&
          binding.configuration.source === "zero-setup-provisioning"
      );
    expect(provisioned).toHaveLength(1);
    expect(provisioned[0]).toMatchObject({ status: "active", isDefault: true });
  });

  it("falls back to the platform default for an existing shop with no prior model binding (no conversationId)", async () => {
    // Same shape as an account that never received an activated model before this fix shipped -
    // the resolver must not require a pre-existing binding row to reach the zero-setup path.
    const localGenerate = vi.fn(async () => ({
      text: JSON.stringify({ type: "response", message: "Still ready." }),
      modelId: "smollm2-360m",
      provider: "test-ollama-adapter",
      executionTarget: "local" as const,
      latencyMs: 2
    }));
    const store = createCp2Store({
      modelRuntimeAdapterResolver: ({ executionTarget }) =>
        executionTarget === "local"
          ? {
              provider: "test",
              executionTarget: "local",
              canRun: async () => ({ available: true, errorCode: null, message: null }),
              healthCheck: async () => {
                throw new Error("not used in this test");
              },
              generate: localGenerate
            }
          : undefined
    });
    const app = buildApi({ cp2: { store } });

    const signup = await app.inject({
      method: "POST",
      url: "/auth/pin/signup",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ method: "phone", contact: "+254700009003", pin: "1234" })
    });
    const cookie = (
      Array.isArray(signup.headers["set-cookie"])
        ? signup.headers["set-cookie"][0]
        : signup.headers["set-cookie"]
    )!.split(";")[0] as string;

    const businessResponse = await app.inject({
      method: "POST",
      url: "/businesses",
      headers: { "content-type": "application/json", cookie },
      payload: JSON.stringify({ name: "Broken Legacy Shop", language: "en" })
    });
    const businessId = businessResponse.json<{ business: { id: string } }>().business.id;

    // First turn resolves nothing, provisions the default, and answers - all in one request; there
    // is no separate "activation" step required, and no explicit model preference was ever set.
    const first = await app.inject({
      method: "POST",
      url: `/businesses/${businessId}/runtime/turns`,
      headers: { "content-type": "application/json", cookie },
      payload: JSON.stringify({ message: "anyone there?" })
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/businesses/${businessId}/runtime/turns`,
      headers: { "content-type": "application/json", cookie },
      payload: JSON.stringify({ message: "still there?" })
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      turn: { model: { status: "available", modelId: "smollm2-360m" } }
    });
    // Idempotent: the second turn must not create a second provisioned binding.
    const provisioned = store
      .snapshot()
      .nativeRuntimeBindings.filter(
        (binding) =>
          binding.businessId === businessId &&
          binding.configuration.source === "zero-setup-provisioning"
      );
    expect(provisioned).toHaveLength(1);
  });
});

function expectCp2ErrorCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`expected a Cp2Error with code ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(Cp2Error);
    expect((error as Cp2Error).code).toBe(code);
  }
}

function fakeAdapter(executionTarget: ModelExecutionTarget): ModelRuntimeAdapter {
  return {
    provider: "test",
    executionTarget,
    canRun: async () => ({ available: true, errorCode: null, message: null }),
    healthCheck: async () => ({
      available: true,
      modelId,
      provider: "test",
      executionTarget,
      latencyMs: 1,
      responsePreview: "ok",
      errorCode: null,
      message: null,
      retryable: false
    }),
    generate: async () => ({
      text: "{}",
      modelId,
      provider: "test",
      executionTarget,
      latencyMs: 1
    })
  };
}

function nativeResolution(input: {
  configuredTarget?: ModelExecutionTarget;
  hostType?: ModelExecutionTarget;
}): ResolvedNativeRuntimeBinding {
  const agent: NativeRuntimeAgentSummary = {
    id: agentId,
    businessId: shopId,
    accountId: "account-1",
    name: "Test agent",
    provider: "grogoni",
    packageRef: null,
    version: "1",
    runtimeContractVersion: "1",
    capabilities: ["tools", "mcp"],
    configuration: {},
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  const model: NativeRuntimeModelSummary = {
    id: modelId,
    name: "Test model",
    provider: "ollama",
    providerModelId: modelId,
    runtimeContractVersion: "1",
    capabilities: ["chat", "tool-routing"],
    configuration:
      input.configuredTarget === undefined ? {} : { executionTarget: input.configuredTarget },
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  const host: NativeExecutionHostSummary | null =
    input.hostType === undefined
      ? null
      : {
          id: "host-1",
          businessId: shopId,
          accountId: "account-1",
          type: input.hostType,
          name: "Test host",
          endpoint: null,
          status: "available",
          capabilities: [input.hostType],
          configuration: {},
          credentialReference: null,
          lastKnownHealthyAt: "2026-01-01T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        };
  const bindingModel: NativeRuntimeBindingModelSummary = {
    id: "role-1",
    runtimeBindingId: "runtime-binding-1",
    modelId,
    role: "primary",
    priority: 0,
    executionHostId: host?.id ?? null,
    configuration: {},
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  const selected: ResolvedNativeRuntimeModel = {
    bindingModel,
    model,
    installation:
      host === null
        ? null
        : {
            id: "installation-1",
            modelId,
            executionHostId: host.id,
            status: "available",
            configuration: {},
            lastKnownHealthyAt: "2026-01-01T00:00:00.000Z",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z"
          },
    host,
    available: true,
    unavailabilityReason: null
  };
  const binding: NativeRuntimeBindingSummary = {
    id: "runtime-binding-1",
    businessId: shopId,
    accountId: "account-1",
    agentId,
    name: "Test runtime",
    status: "active",
    isDefault: false,
    configuration: {},
    runtimeContractVersion: "1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedBy: "owner-1"
  };
  return {
    conversationId: "conversation-1",
    usedGlobalDefault: false,
    source: "explicit-conversation",
    binding,
    agent,
    primary: selected,
    fallbacks: [],
    auxiliaries: {},
    selected,
    fallbackUsed: false,
    fallbackReason: null,
    configuration: {}
  };
}
