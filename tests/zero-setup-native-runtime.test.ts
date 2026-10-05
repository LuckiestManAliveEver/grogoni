import { describe, expect, it, vi } from "vitest";

import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import type { AgentRuntimeAdapter } from "../services/api/src/agent-harness/agent-runtime-adapter";
import {
  ModelRuntimeError,
  type ModelRuntimeAdapter
} from "../services/api/src/inference/model-runtime";

const primaryModelId = "smollm2-360m";
const fallbackModelId = "qwen2.5-0.5b-android";

describe("zero-setup native runtime", () => {
  it("completes a brand-new user's first /v1/messages chat without a download or activation", async () => {
    const generate = vi.fn(async () =>
      generation(primaryModelId, "Welcome to Grogoni AI.", "local")
    );
    const store = createCp2Store({
      modelRuntimeAdapterResolver: ({ modelId, executionTarget }) =>
        modelId === primaryModelId && executionTarget === "local"
          ? adapter(modelId, generate, "local")
          : undefined
    });
    const app = buildApi({ cp2: { store } });
    try {
      const actor = await createActorAndShop(app, "+254700008101", "Zero Setup Shop");
      const conversationId = await createConversation(app, actor.cookie, actor.businessId);
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: jsonHeaders(actor.cookie),
        payload: JSON.stringify({
          conversationId,
          clientMessageId: "first-chat-message",
          content: { type: "text", text: "Hello" },
          agent: { businessId: actor.businessId, message: "Hello" }
        })
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        agentMessage: { content: { type: "text", text: "Welcome to Grogoni AI." } },
        runtime: {
          turn: {
            model: {
              status: "available",
              modelId: primaryModelId,
              executionTarget: "local",
              agentId: actor.businessId,
              agentAdapterId: "grogoni"
            }
          }
        },
        processing: { status: "completed", errorCode: null }
      });
      expect(generate).toHaveBeenCalledOnce();
      expect(tenantDefaultBindings(store, actor.businessId)).toHaveLength(1);
      expect(
        store.snapshot().nativeRuntimeAgents.find((agent) => agent.id === actor.businessId)
      ).toMatchObject({
        provider: "grogoni-business-agent",
        configuration: { runtimeAdapterId: "grogoni", requiredModelCapabilities: ["chat"] }
      });
      // There is no legacy cp2_agent_model_bindings representation left to duplicate this into -
      // the native runtime graph checked above is the sole source of truth for a first chat.
    } finally {
      await app.close();
    }
  });

  it("uses a materialized global default for conversation-free first chat without requiring a tenant binding", async () => {
    const generate = vi.fn(async () => generation(primaryModelId, "Global default ready."));
    const store = createCp2Store({
      modelRuntimeAdapterResolver: ({ modelId, executionTarget }) =>
        modelId === primaryModelId && executionTarget === "local"
          ? adapter(modelId, generate)
          : undefined
    });
    store.activateGlobalDefaultModel({
      model: {
        id: primaryModelId,
        label: "SmolLM2 360M",
        provider: "local",
        description: "Default hosted runtime model.",
        capabilities: ["chat", "english", "instruction-following"],
        available: true,
        source: "hosted",
        format: "remote",
        license: "Apache-2.0",
        licenseUrl: null,
        modelCardUrl: null,
        downloadUrl: null,
        fileName: null,
        fileSizeBytes: null,
        minimumMemoryGb: null,
        recommended: true,
        contextWindow: 8192
      },
      executionTarget: "local",
      checkedAt: "2026-08-30T00:00:00.000Z",
      updatedBy: "system"
    });
    const app = buildApi({ cp2: { store } });
    try {
      const actor = await createActorAndShop(app, "+254700008112", "Global Default Shop");
      const effectiveRuntime = await app.inject({
        method: "GET",
        url: `/businesses/${actor.businessId}/runtime/effective`,
        headers: { cookie: actor.cookie }
      });
      expect(effectiveRuntime.statusCode).toBe(200);
      expect(effectiveRuntime.json()).toMatchObject({
        agent: { id: "builtin:shopkeeper", runtimeAdapterId: "grogoni" },
        model: { id: primaryModelId },
        execution: { type: "local", ready: true },
        source: "default",
        ready: true
      });

      const response = await app.inject({
        method: "POST",
        url: `/businesses/${actor.businessId}/runtime/turns`,
        headers: jsonHeaders(actor.cookie),
        payload: JSON.stringify({ message: "Hello" })
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        turn: {
          response: "Global default ready.",
          model: {
            status: "available",
            modelId: primaryModelId,
            executionTarget: "local",
            agentAdapterId: "grogoni"
          }
        }
      });
      expect(generate).toHaveBeenCalledOnce();
      expect(tenantDefaultBindings(store, actor.businessId)).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("resolves a swapped platform default agent through the exact same first-chat path as the built-in default", async () => {
    const betaExecute = vi.fn(async (input: Parameters<AgentRuntimeAdapter["execute"]>[0]) => ({
      completion: await input.model.complete(input.prompt, input.signal),
      eventTypes: ["beta.turn_start", "beta.turn_end"]
    }));
    const betaAdapter: AgentRuntimeAdapter = {
      id: "beta",
      canRun: async () => ({ available: true, errorCode: null, message: null }),
      execute: betaExecute
    };
    const generate = vi.fn(async () => generation(primaryModelId, "Agent B is ready."));
    const store = createCp2Store({
      platformDefaultRuntime: {
        agentId: "builtin:agent-b:v1",
        agentName: "Agent B",
        agentRuntimeAdapterId: "beta",
        modelId: primaryModelId,
        executionTarget: "local"
      },
      agentRuntimeAdapterResolver: (adapterId) => (adapterId === "beta" ? betaAdapter : undefined),
      modelRuntimeAdapterResolver: ({ modelId, executionTarget }) =>
        modelId === primaryModelId && executionTarget === "local"
          ? adapter(modelId, generate)
          : undefined
    });
    const app = buildApi({ cp2: { store } });
    try {
      const actor = await createActorAndShop(app, "+254700008111", "Swapped Agent Shop");
      const conversationId = await createConversation(app, actor.cookie, actor.businessId);
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: jsonHeaders(actor.cookie),
        payload: JSON.stringify({
          conversationId,
          clientMessageId: "first-chat-message",
          content: { type: "text", text: "Hello" },
          agent: { businessId: actor.businessId, message: "Hello" }
        })
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        agentMessage: { content: { type: "text", text: "Agent B is ready." } },
        runtime: {
          turn: {
            model: {
              status: "available",
              modelId: primaryModelId,
              executionTarget: "local",
              agentId: actor.businessId,
              agentAdapterId: "beta"
            }
          }
        },
        processing: { status: "completed", errorCode: null }
      });
      expect(betaExecute).toHaveBeenCalledOnce();
      expect(generate).toHaveBeenCalledOnce();
      expect(
        store.snapshot().nativeRuntimeAgents.find((agent) => agent.id === actor.businessId)
      ).toMatchObject({
        provider: "grogoni-business-agent",
        packageRef: null,
        configuration: { runtimeAdapterId: "beta", requiredModelCapabilities: ["chat"] }
      });
    } finally {
      await app.close();
    }
  });

  it("retries a retryable primary-host failure on the compatible fallback model", async () => {
    const primaryGenerate = vi.fn(async () => {
      throw new ModelRuntimeError("INFERENCE_SERVICE_UNREACHABLE", "offline", true);
    });
    const fallbackGenerate = vi.fn(async () =>
      generation(fallbackModelId, "Fallback ready.", "local")
    );
    const store = createCp2Store({
      modelRuntimeAdapterResolver: ({ modelId, executionTarget }) => {
        if (executionTarget !== "local") return undefined;
        if (modelId === primaryModelId) return adapter(modelId, primaryGenerate, "local");
        if (modelId === fallbackModelId) return adapter(modelId, fallbackGenerate, "local");
        return undefined;
      }
    });
    const app = buildApi({ cp2: { store } });
    try {
      const actor = await createActorAndShop(app, "+254700008102", "Fallback Shop");
      const conversationId = await createConversation(app, actor.cookie, actor.businessId);
      const response = await runtimeTurn(app, actor.cookie, actor.businessId, conversationId);

      expect(response.statusCode).toBe(200);
      expect(primaryGenerate).toHaveBeenCalledOnce();
      expect(fallbackGenerate).toHaveBeenCalledOnce();
      expect(response.json()).toMatchObject({
        turn: {
          response: "Fallback ready.",
          model: {
            modelId: fallbackModelId,
            executionTarget: "local",
            fallbackIndex: 1,
            status: "available"
          }
        }
      });
      const attempts = response
        .json<{
          turn: { telemetry: Array<{ state: string; metadata: Record<string, unknown> }> };
        }>()
        .turn.telemetry.filter((event) => event.state === "model.inference_started");
      expect(attempts.map((event) => event.metadata.fallbackIndex)).toEqual([0, 1]);
    } finally {
      await app.close();
    }
  });

  it("converges concurrent first chats on exactly one deterministic tenant default", async () => {
    let releaseAvailability!: () => void;
    const availabilityGate = new Promise<void>((resolve) => {
      releaseAvailability = resolve;
    });
    const runtime = adapter(primaryModelId, async () => generation(primaryModelId, "Ready."));
    runtime.canRun = async () => {
      await availabilityGate;
      return { available: true, errorCode: null, message: null };
    };
    const store = createCp2Store({ modelRuntimeAdapterResolver: () => runtime });
    const app = buildApi({ cp2: { store } });
    try {
      const actor = await createActorAndShop(app, "+254700008103", "Concurrent Shop");
      const conversationId = await createConversation(app, actor.cookie, actor.businessId);
      const requests = [
        runtimeTurn(app, actor.cookie, actor.businessId, conversationId),
        runtimeTurn(app, actor.cookie, actor.businessId, conversationId)
      ];
      releaseAvailability();
      const responses = await Promise.all(requests);
      expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
      expect(tenantDefaultBindings(store, actor.businessId)).toHaveLength(1);
      const binding = tenantDefaultBindings(store, actor.businessId)[0];
      expect(
        store
          .snapshot()
          .nativeRuntimeBindingModels.filter(
            (role) => role.runtimeBindingId === binding?.id && role.role === "primary"
          )
      ).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("scopes provisioned hosts to their shop and rejects cross-shop binding assignment", async () => {
    const store = createCp2Store({
      modelRuntimeAdapterResolver: ({ modelId }) =>
        modelId === primaryModelId
          ? adapter(modelId, async () => generation(modelId, "Ready."))
          : undefined
    });
    const app = buildApi({ cp2: { store } });
    try {
      const actor = await createActorAndShop(app, "+254700008104", "Shop A");
      const actorB = await createActorAndShop(app, "+254700008105", "Shop B");
      const shopB = actorB.businessId;
      const conversationA = await createConversation(app, actor.cookie, actor.businessId);
      const conversationB = await createConversation(app, actorB.cookie, shopB);
      expect(
        (await runtimeTurn(app, actor.cookie, actor.businessId, conversationA)).statusCode
      ).toBe(200);
      expect((await runtimeTurn(app, actorB.cookie, shopB, conversationB)).statusCode).toBe(200);

      const bindingA = tenantDefaultBindings(store, actor.businessId)[0];
      const bindingB = tenantDefaultBindings(store, shopB)[0];
      expect(bindingA?.id).not.toBe(bindingB?.id);
      const hostIds = [bindingA, bindingB].map(
        (binding) =>
          store
            .snapshot()
            .nativeRuntimeBindingModels.find((role) => role.runtimeBindingId === binding?.id)
            ?.executionHostId
      );
      expect(hostIds[0]).not.toBe(hostIds[1]);

      const attack = await app.inject({
        method: "POST",
        url: "/v1/conversations",
        headers: jsonHeaders(actor.cookie),
        payload: JSON.stringify({
          kind: "storefront",
          activeShopId: shopB,
          runtimeBindingId: bindingA?.id
        })
      });
      expect(attack.statusCode).toBe(403);
      expect(attack.json()).toMatchObject({ code: "RUNTIME_BINDING_FORBIDDEN" });
    } finally {
      await app.close();
    }
  });

  it("rejects a runtime turn that reuses another shop's conversationId", async () => {
    const store = createCp2Store({
      modelRuntimeAdapterResolver: ({ modelId }) =>
        modelId === primaryModelId
          ? adapter(modelId, async () => generation(modelId, "Ready."))
          : undefined
    });
    const app = buildApi({ cp2: { store } });
    try {
      const actor = await createActorAndShop(app, "+254700008106", "Shop A Turns");
      const actorB = await createActorAndShop(app, "+254700008107", "Shop B Turns");
      const shopB = actorB.businessId;
      const conversationB = await createConversation(app, actorB.cookie, shopB);
      expect((await runtimeTurn(app, actorB.cookie, shopB, conversationB)).statusCode).toBe(200);
      const bindingBBefore = tenantDefaultBindings(store, shopB)[0];

      // actor is authorized for their own shop (actor.businessId) but supplies shop B's
      // conversationId in the body - the URL businessId being authorized must not imply the body's
      // conversationId is too.
      const attack = await runtimeTurn(app, actor.cookie, actor.businessId, conversationB);

      expect(attack.statusCode).toBe(403);
      expect(attack.json()).toMatchObject({ code: "RUNTIME_BINDING_FORBIDDEN" });
      expect(tenantDefaultBindings(store, actor.businessId)).toHaveLength(0);
      expect(tenantDefaultBindings(store, shopB)[0]?.id).toBe(bindingBBefore?.id);
    } finally {
      await app.close();
    }
  });

  // Regression coverage for the production incident where a business without a materialized
  // hosted runtime candidate (a legacy account, or any account hitting this path while the real
  // inference host is degraded) turned a routine chat send into an unbounded hang: the zero-setup
  // repair step's own model-availability probe had no control-plane deadline, so it could block
  // for the full inference timeout (VERCEL_INFERENCE_TIMEOUT_MS, 5 minutes by default) - far
  // longer than the frontend's 20-second request timeout - surfacing as the generic
  // "The request took too long and was cancelled." instead of a fast, typed failure.
  it("fails a first turn fast when the model host never answers, instead of hanging for the inference timeout", async () => {
    const hangingAdapter = adapter(primaryModelId, async () =>
      generation(primaryModelId, "Ready.")
    );
    hangingAdapter.canRun = () => new Promise(() => undefined);
    const store = createCp2Store({ modelRuntimeAdapterResolver: () => hangingAdapter });
    const app = buildApi({ cp2: { store } });
    try {
      const actor = await createActorAndShop(app, "+254700008109", "Hung Host Shop");
      vi.useFakeTimers();
      try {
        const pending = app.inject({
          method: "POST",
          url: `/businesses/${actor.businessId}/runtime/turns`,
          headers: jsonHeaders(actor.cookie),
          payload: JSON.stringify({ message: "Hello" })
        });
        // The control-plane deadline (withRuntimeDeadline's default) bounds the probe at 5s.
        // Before the fix, nothing here ever timed out - this advance would do nothing and the
        // awaited response below would hang until vitest's own test timeout failed the test.
        await vi.advanceTimersByTimeAsync(5_000);
        const response = await pending;
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ code: "AGENT_MODEL_NOT_CONFIGURED" });
      } finally {
        vi.useRealTimers();
      }
      expect(tenantDefaultBindings(store, actor.businessId)).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  // Regression coverage for Account/Agent Settings stalling in sympathy with chat: Settings reads
  // this same endpoint to show the shop's runtime as ready without requiring a chat message first,
  // so it legitimately runs the same zero-setup repair attempt. That must still resolve within the
  // control-plane deadline bound and report UNAVAILABLE, rather than blocking the settings page for
  // the full inference timeout budget while the model host never answers.
  it("bounds the settings-facing effective-runtime endpoint even when the model host never answers", async () => {
    const hangingAdapter = adapter(primaryModelId, async () =>
      generation(primaryModelId, "Ready.")
    );
    hangingAdapter.canRun = () => new Promise(() => undefined);
    const store = createCp2Store({ modelRuntimeAdapterResolver: () => hangingAdapter });
    const app = buildApi({ cp2: { store } });
    try {
      const actor = await createActorAndShop(app, "+254700008110", "Settings Only Shop");
      vi.useFakeTimers();
      try {
        const pending = app.inject({
          method: "GET",
          url: `/businesses/${actor.businessId}/runtime/effective`,
          headers: { cookie: actor.cookie }
        });
        await vi.advanceTimersByTimeAsync(5_000);
        const response = await pending;
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          source: "default",
          status: "UNAVAILABLE",
          ready: false
        });
      } finally {
        vi.useRealTimers();
      }
      expect(tenantDefaultBindings(store, actor.businessId)).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});

function adapter(
  modelId: string,
  generate: ModelRuntimeAdapter["generate"],
  executionTarget: ModelRuntimeAdapter["executionTarget"] = "local"
): ModelRuntimeAdapter {
  return {
    provider: "test-hosted-adapter",
    executionTarget,
    canRun: async () => ({ available: true, errorCode: null, message: null }),
    healthCheck: async () => ({
      available: true,
      modelId,
      provider: "test-hosted-adapter",
      executionTarget,
      latencyMs: 1,
      responsePreview: "GROGONI_MODEL_OK",
      errorCode: null,
      message: null,
      retryable: false
    }),
    generate
  };
}

function generation(modelId: string, message: string, executionTarget: "local" = "local") {
  return {
    text: JSON.stringify({ type: "response", message }),
    modelId,
    provider: "test-hosted-adapter",
    executionTarget,
    latencyMs: 1
  };
}

async function createActorAndShop(app: ReturnType<typeof buildApi>, contact: string, name: string) {
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ method: "phone", contact, pin: "1234" })
  });
  expect(signup.statusCode).toBe(200);
  const setCookie = signup.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0] as string;
  return { cookie, businessId: await createShop(app, cookie, name) };
}

async function createShop(app: ReturnType<typeof buildApi>, cookie: string, name: string) {
  const response = await app.inject({
    method: "POST",
    url: "/businesses",
    headers: jsonHeaders(cookie),
    payload: JSON.stringify({ name, language: "en" })
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ business: { id: string } }>().business.id;
}

async function createConversation(
  app: ReturnType<typeof buildApi>,
  cookie: string,
  businessId: string
) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/conversations",
    headers: jsonHeaders(cookie),
    payload: JSON.stringify({ kind: "personal", activeShopId: businessId })
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ conversation: { id: string } }>().conversation.id;
}

function runtimeTurn(
  app: ReturnType<typeof buildApi>,
  cookie: string,
  businessId: string,
  conversationId: string
) {
  return app.inject({
    method: "POST",
    url: `/businesses/${businessId}/runtime/turns`,
    headers: jsonHeaders(cookie),
    payload: JSON.stringify({ conversationId, message: "Hello" })
  });
}

function jsonHeaders(cookie: string) {
  return { "content-type": "application/json", cookie };
}

function tenantDefaultBindings(store: ReturnType<typeof createCp2Store>, businessId: string) {
  return store
    .snapshot()
    .nativeRuntimeBindings.filter(
      (binding) =>
        binding.businessId === businessId && binding.isDefault && binding.status === "active"
    );
}
