import { describe, expect, it, vi } from "vitest";
import type {
  AgentModelActivationResult,
  AgentModelBindingSummary,
  ModelExecutionTarget,
  RuntimeModelPrompt
} from "../packages/shared-types/src";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import type { ModelArtifactStore } from "../services/api/src/inference/model-artifact-store";
import {
  createVercelInferenceClient,
  createVercelModelAdapter,
  ModelRuntimeError,
  type ModelRuntimeAdapter
} from "../services/api/src/inference/model-runtime";

const primaryModelId = "qwen2.5-0.5b-android";
const replacementModelId = "qwen2.5-1.5b-android";

describe("agent model activation runtime", () => {
  it("advertises backend execution only when the platform's default hosted target has a configured adapter", () => {
    const withoutBackend = createCp2Store();
    const withBackend = createCp2Store({
      // "backend" here is the frontend's stable field name for "a hosted adapter is configured",
      // not the "backend" ModelExecutionTarget literal - it tracks whichever target the platform
      // default actually is ("backend" for GPT-6 Luna; see repositoryDefaultRuntimePolicy).
      modelRuntimeAdapterResolver: ({ modelId, executionTarget }) =>
        modelId === primaryModelId && executionTarget === "backend"
          ? healthyAdapter(primaryModelId, { executionTarget: "backend" })
          : undefined
    });

    expect(
      withoutBackend.listAiModels().find((model) => model.id === primaryModelId)
        ?.runtimeAvailability
    ).toMatchObject({ backend: "unconfigured" });
    expect(
      withBackend.listAiModels().find((model) => model.id === primaryModelId)?.runtimeAvailability
    ).toMatchObject({ backend: "configured" });
    expect(
      withBackend.listAiModels().find((model) => model.id === replacementModelId)
        ?.runtimeAvailability
    ).toMatchObject({ backend: "unconfigured" });
  });

  it("tests real adapter output, activates a canonical binding, and survives hydration", async () => {
    const adapter = healthyAdapter(primaryModelId);
    const store = createCp2Store({
      modelRuntimeAdapterResolver: ({ modelId, executionTarget }) =>
        modelId === primaryModelId && executionTarget === "backend" ? adapter : undefined
    });
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "+254700002001", "Kwa Jane");
    const createdConversation = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({
        kind: "personal",
        activeShopId: owner.businessId,
        runtimeBindingId: "builtin:grogoni-default-runtime:v1"
      })
    });
    expect(createdConversation.statusCode).toBe(200);
    expect(createdConversation.json()).toMatchObject({
      conversation: { runtimeBindingId: "builtin:grogoni-default-runtime:v1" }
    });
    const conversationId = createdConversation.json<{ conversation: { id: string } }>().conversation
      .id;
    const invalidConversation = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({
        kind: "personal",
        activeShopId: owner.businessId,
        runtimeBindingId: "missing-runtime-binding"
      })
    });
    expect(invalidConversation.statusCode).toBe(400);
    expect(invalidConversation.json()).toMatchObject({ code: "RUNTIME_BINDING_INVALID" });

    const test = await app.inject({
      method: "POST",
      url: `/api/agents/${owner.businessId}/models/${primaryModelId}/test`,
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({ shopId: owner.businessId, executionTarget: "backend" })
    });
    expect(test.statusCode).toBe(200);
    expect(test.json()).toMatchObject({
      healthCheck: {
        ok: true,
        modelId: primaryModelId,
        executionTarget: "backend",
        responsePreview: "GROGONI_MODEL_OK"
      }
    });

    const activation = await activate(app, owner, primaryModelId);
    expect(activation.binding).toMatchObject({
      agentId: owner.businessId,
      shopId: owner.businessId,
      modelId: primaryModelId,
      status: "active",
      executionTarget: "backend",
      lastVerificationStatus: "passed"
    });
    expect(activation.healthCheck.ok).toBe(true);
    expect(store.resolveRuntimeBinding(conversationId)).toMatchObject({
      conversationId,
      binding: { businessId: owner.businessId, agentId: owner.businessId, status: "active" },
      agent: { id: owner.businessId },
      primary: {
        model: { id: primaryModelId },
        installation: { status: "available" },
        host: { type: "backend", status: "healthy" }
      },
      selected: { model: { id: primaryModelId } }
    });

    const restoredStore = createCp2Store({
      modelRuntimeAdapterResolver: ({ modelId, executionTarget }) =>
        modelId === primaryModelId && executionTarget === "backend" ? adapter : undefined
    });
    restoredStore.hydrateSnapshot(store.snapshot());
    const restoredApp = buildApi({ cp2: { store: restoredStore } });
    const restored = await getBinding(restoredApp, owner);
    expect(restored).toMatchObject({
      id: activation.binding.id,
      modelId: primaryModelId,
      status: "active"
    });
    expect(restoredStore.resolveRuntimeBinding(conversationId).selected.model.id).toBe(
      primaryModelId
    );

    await app.close();
    await restoredApp.close();
  });

  it("keeps the previous active model when a replacement health check fails", async () => {
    const first = healthyAdapter(primaryModelId);
    const failing = healthyAdapter(replacementModelId, { healthOk: false });
    const store = createCp2Store({
      modelRuntimeAdapterResolver: ({ modelId }) =>
        modelId === primaryModelId ? first : modelId === replacementModelId ? failing : undefined
    });
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "+254700002002", "Replacement Shop");
    const original = await activate(app, owner, primaryModelId);

    const replacement = await app.inject({
      method: "POST",
      url: `/api/agents/${owner.businessId}/models/${replacementModelId}/activate`,
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify(activationPayload(owner.businessId))
    });
    expect(replacement.statusCode).toBe(422);
    expect(replacement.json()).toMatchObject({
      code: "MODEL_HEALTH_CHECK_FAILED",
      retryable: true
    });
    expect(await getBinding(app, owner)).toMatchObject({
      id: original.binding.id,
      modelId: primaryModelId,
      status: "active"
    });

    await app.close();
  });

  it("is idempotent, switches one active binding, and persists removal across hydration", async () => {
    const store = createCp2Store({
      modelRuntimeAdapterResolver: ({ modelId }) =>
        modelId === primaryModelId || modelId === replacementModelId
          ? healthyAdapter(modelId)
          : undefined
    });
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "+254700002009", "Binding Lifecycle Shop");

    const first = await activate(app, owner, primaryModelId);
    const repeated = await activate(app, owner, primaryModelId);
    expect(repeated.binding.id).toBe(first.binding.id);
    expect(activeNativeBindingsForAgent(store, owner.businessId)).toHaveLength(1);

    const replacement = await activate(app, owner, replacementModelId);
    expect(replacement.binding).toMatchObject({
      modelId: replacementModelId,
      status: "active"
    });
    // The native runtime binding is a stable per-agent slot (see NativeRuntimeBindingStore.
    // activateVerifiedModel) - swapping the active model updates that SAME binding's primary role
    // in place so conversation.runtimeBindingId never has to move, rather than minting a new
    // binding id per activation the way the retired legacy cp2_agent_model_bindings table did.
    expect(replacement.binding.id).toBe(first.binding.id);
    expect(activeNativeBindingsForAgent(store, owner.businessId)).toHaveLength(1);
    expect(
      store
        .snapshot()
        .nativeRuntimeBindingModels.filter(
          (role) =>
            role.runtimeBindingId === replacement.binding.id &&
            role.role === "primary" &&
            role.enabled
        )
    ).toMatchObject([{ modelId: replacementModelId }]);
    expect(await getBinding(app, owner)).toMatchObject({
      id: replacement.binding.id,
      modelId: replacementModelId
    });

    const removed = await removeBinding(app, owner);
    expect(removed).toMatchObject({
      agentId: owner.businessId,
      shopId: owner.businessId,
      binding: null,
      removedBindingId: replacement.binding.id
    });
    expect(await getBinding(app, owner)).toBeNull();
    expect(await removeBinding(app, owner)).toMatchObject({
      binding: null,
      removedBindingId: null
    });

    const restoredStore = createCp2Store({
      modelRuntimeAdapterResolver: ({ modelId }) =>
        modelId === primaryModelId || modelId === replacementModelId
          ? healthyAdapter(modelId)
          : undefined
    });
    restoredStore.hydrateSnapshot(store.snapshot());
    const restoredApp = buildApi({ cp2: { store: restoredStore } });
    expect(await getBinding(restoredApp, owner)).toBeNull();
    // Removing the explicit binding does not leave chat unusable: zero-setup provisioning
    // (ensureDefaultRuntimeForTurn) runs on this very turn and picks up any adapter-verified
    // catalog model - here primaryModelId, since restoredStore resolves it - exactly the same
    // "absence of an override means use the platform default" behavior a never-configured shop
    // gets. See docs/architecture/runtime-resolution.md.
    const chat = await restoredApp.inject({
      method: "POST",
      url: `/businesses/${owner.businessId}/runtime/turns`,
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({ message: "hello" })
    });
    expect(chat.statusCode).toBe(200);
    expect(chat.json()).toMatchObject({
      turn: {
        model: { status: "available", modelId: primaryModelId, agentId: owner.businessId }
      }
    });
    // Default provisioning and explicit activation use the same shop-agent identity and binding
    // API; settings and chat cannot drift into separate identity spaces.
    expect(await getBinding(restoredApp, owner)).toMatchObject({
      agentId: owner.businessId,
      modelId: primaryModelId,
      status: "active"
    });
    const provisioned = restoredStore
      .snapshot()
      .nativeRuntimeBindings.filter(
        (binding) =>
          binding.businessId === owner.businessId &&
          binding.configuration.source === "zero-setup-provisioning"
      );
    expect(provisioned).toHaveLength(1);
    expect(provisioned[0]).toMatchObject({
      status: "active",
      isDefault: true,
      agentId: owner.businessId
    });

    const hashtagRead = await restoredApp.inject({
      method: "POST",
      url: `/businesses/${owner.businessId}/runtime/turns`,
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({ message: "#products.list" })
    });
    expect(hashtagRead.statusCode).toBe(200);
    expect(hashtagRead.json()).toMatchObject({
      turn: {
        status: "completed",
        plan: { toolName: "products.list", confirmationToken: null },
        telemetry: expect.arrayContaining([
          expect.objectContaining({
            state: "intent.routed",
            metadata: expect.objectContaining({ source: "hashtag" })
          })
        ])
      }
    });

    // The runtime's unknown-entity-reference check (services/api/src/cp2/domains/agent-runtime/
    // capabilities.ts's findRuntimeUnknownEntityReferenceError) now clarifies rather than
    // confirming a delete/update for a product name that doesn't exist yet - create the product
    // this test deletes below so the hashtag mutation still reaches needs_confirmation.
    const productSetup = await restoredApp.inject({
      method: "POST",
      url: `/businesses/${owner.businessId}/runtime/turns`,
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({ message: "add product Sugar" })
    });
    expect(productSetup.statusCode).toBe(200);
    expect(productSetup.json()).toMatchObject({ turn: { plan: { toolName: "product.create" } } });

    const hashtagMutation = await restoredApp.inject({
      method: "POST",
      url: `/businesses/${owner.businessId}/runtime/turns`,
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({ message: "#product.delete Sugar" })
    });
    expect(hashtagMutation.statusCode).toBe(200);
    expect(hashtagMutation.json()).toMatchObject({
      turn: {
        status: "needs_confirmation",
        plan: {
          toolName: "product.delete",
          input: { productName: "Sugar" },
          confirmationToken: expect.any(String)
        }
      }
    });

    await app.close();
    await restoredApp.close();
  });

  it("continues the same conversation with full history from a second device session after swapping the active model", async () => {
    const responseByModel: Record<string, string> = {
      [primaryModelId]: "Reply from model A.",
      [replacementModelId]: "Reply from model B."
    };
    const store = createCp2Store({
      modelRuntimeAdapterResolver: ({ modelId }) =>
        modelId === primaryModelId || modelId === replacementModelId
          ? {
              ...healthyAdapter(modelId),
              async generate() {
                return {
                  text: JSON.stringify({ type: "response", message: responseByModel[modelId] }),
                  modelId,
                  provider: "test",
                  executionTarget: "backend",
                  latencyMs: 8
                };
              }
            }
          : undefined
    });
    const app = buildApi({ cp2: { store } });
    const contact = "+254700002099";
    const owner = await createOwnerBusiness(app, contact, "Multi-Device Swap Shop");
    await activate(app, owner, primaryModelId);

    const conversations = await getJson<{ conversations: Array<{ id: string }> }>(
      app,
      "/v1/conversations",
      owner.cookie
    );
    const conversationId = conversations.conversations[0]?.id;
    expect(conversationId).toBeTruthy();

    const firstTurn = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({
        conversationId,
        clientMessageId: "swap-history-0001",
        content: { type: "text", text: "Hello from device one." },
        clientTimestamp: new Date().toISOString(),
        agent: { businessId: owner.businessId, message: "Hello from device one." }
      })
    });
    expect(firstTurn.statusCode).toBe(200);
    expect(firstTurn.json()).toMatchObject({
      conversationId,
      agentMessage: { content: { text: expect.stringMatching(/Reply from model A/u) } }
    });

    // A different device signs in with the same phone/PIN - a genuinely separate session, not
    // the one that opened the conversation.
    const secondLogin = await app.inject({
      method: "POST",
      url: "/auth/pin/login",
      headers: jsonHeaders(),
      payload: JSON.stringify({ method: "phone", contact, pin: "1234" })
    });
    expect(secondLogin.statusCode).toBe(200);
    const secondDeviceCookie = sessionCookie(secondLogin.headers["set-cookie"]);
    expect(secondDeviceCookie).not.toBe(owner.cookie);

    const historyOnSecondDevice = await getJson<{
      messages: Array<{ content: { text?: string } }>;
    }>(app, `/v1/conversations/${conversationId}`, secondDeviceCookie);
    expect(historyOnSecondDevice.messages.map((message) => message.content.text)).toEqual(
      expect.arrayContaining(["Hello from device one.", "Reply from model A."])
    );

    // Swap the active model - the binding is a business-level slot, not tied to whichever
    // device happened to open the conversation.
    const swap = await activate(app, owner, replacementModelId);
    expect(swap.binding).toMatchObject({ modelId: replacementModelId, status: "active" });

    const secondTurn = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: jsonHeaders(secondDeviceCookie),
      payload: JSON.stringify({
        conversationId,
        clientMessageId: "swap-history-0002",
        content: { type: "text", text: "Hello from device two, after the swap." },
        clientTimestamp: new Date().toISOString(),
        agent: {
          businessId: owner.businessId,
          message: "Hello from device two, after the swap."
        }
      })
    });
    expect(secondTurn.statusCode).toBe(200);
    expect(secondTurn.json()).toMatchObject({
      conversationId,
      agentMessage: { content: { text: expect.stringMatching(/Reply from model B/u) } }
    });

    const finalHistory = await getJson<{
      messages: Array<{ content: { text?: string } }>;
    }>(app, `/v1/conversations/${conversationId}`, owner.cookie);
    // Every message from both models and both devices survives the swap in one conversation -
    // no new conversation was created and nothing was dropped.
    expect(finalHistory.messages.map((message) => message.content.text)).toEqual(
      expect.arrayContaining([
        "Hello from device one.",
        "Reply from model A.",
        "Hello from device two, after the swap.",
        "Reply from model B."
      ])
    );
    expect(finalHistory.messages).toHaveLength(4);

    await app.close();
  });

  it("routes agent chat through the active binding with shop instructions and records metadata", async () => {
    const prompts: RuntimeModelPrompt[] = [];
    const adapter = healthyAdapter(primaryModelId, { prompts });
    const store = createCp2Store({
      modelRuntimeAdapterResolver: ({ modelId }) =>
        modelId === primaryModelId ? adapter : undefined
    });
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "+254700002003", "Context Shop");
    const profile = await getJson<Record<string, unknown>>(
      app,
      `/businesses/${owner.businessId}/agent-profile`,
      owner.cookie
    );
    await putJson(
      app,
      `/businesses/${owner.businessId}/agent-profile`,
      {
        ...profile,
        personality: "Concise market guide",
        instructions: "Always mention the market policy.",
        personalityConfig: {
          ...(profile.personalityConfig as Record<string, unknown>),
          additionalGuidance: "Concise market guide"
        },
        instructionPolicy: {
          ...(profile.instructionPolicy as Record<string, unknown>),
          generalOperatingRules: ["Always mention the market policy."]
        }
      },
      owner.cookie
    );
    const activation = await activate(app, owner, primaryModelId);
    const conversations = await getJson<{ conversations: Array<{ id: string }> }>(
      app,
      "/v1/conversations",
      owner.cookie
    );
    const conversationId = conversations.conversations[0]?.id;
    expect(conversationId).toBeTruthy();

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({
        conversationId,
        clientMessageId: "binding-chat-message-0001",
        content: { type: "text", text: "Reply with the word market" },
        clientTimestamp: new Date().toISOString(),
        agent: {
          businessId: owner.businessId,
          message: "Reply with the word market"
        }
      })
    });
    expect(response.statusCode).toBe(200);
    const processed = response.json<{
      id: string;
      agentMessage: { replyToMessageId: string | null };
    }>();
    expect(processed).toMatchObject({
      agentMessage: { content: { type: "text", text: "market" } },
      runtime: {
        turn: {
          model: {
            bindingId: activation.binding.id,
            modelId: primaryModelId,
            executionTarget: "backend",
            status: "available"
          }
        }
      }
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.message).toContain("Always mention the market policy.");
    expect(prompts[0]?.message).toContain("Concise market guide");
    const view = await getJson<{ messages: Array<{ clientMessageId: string }> }>(
      app,
      `/v1/conversations/${conversationId}`,
      owner.cookie
    );
    expect(
      view.messages.filter(
        (message) =>
          message.clientMessageId.startsWith("agent-reply-") &&
          (message as { replyToMessageId?: string | null }).replyToMessageId === processed.id
      )
    ).toHaveLength(1);

    await app.close();
  });

  it("persists retry-and-reactivate guidance in chat when the active model is unavailable", async () => {
    const adapter = failingGenerationAdapter(primaryModelId, "INFERENCE_TIMEOUT");
    const store = createCp2Store({
      modelRuntimeAdapterResolver: ({ modelId }) =>
        modelId === primaryModelId ? adapter : undefined
    });
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "+254700002007", "Recovery Guidance Shop");
    await activate(app, owner, primaryModelId);
    const conversations = await getJson<{ conversations: Array<{ id: string }> }>(
      app,
      "/v1/conversations",
      owner.cookie
    );
    const conversationId = conversations.conversations[0]?.id;
    expect(conversationId).toBeTruthy();

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({
        conversationId,
        clientMessageId: "binding-chat-recovery-0001",
        content: { type: "text", text: "Help me with stock" },
        clientTimestamp: new Date().toISOString(),
        agent: {
          businessId: owner.businessId,
          message: "Help me with stock"
        }
      })
    });

    expect(response.statusCode).toBe(200);
    const responseBody = response.json<{
      id: string;
      agentMessage: { content: { type: string; text: string } };
      runtime: null;
      processing: { status: string; errorCode: string; retryable: boolean };
    }>();
    expect(responseBody).toMatchObject({
      agentMessage: {
        content: {
          type: "text",
          text: expect.stringMatching(/retry[\s\S]*activate a different available model/iu)
        }
      },
      runtime: null,
      processing: {
        status: "completed",
        errorCode: "AGENT_MODEL_UNAVAILABLE",
        retryable: true
      }
    });
    const persisted = await getJson<{
      messages: Array<{ clientMessageId: string; content: { type: string; text?: string } }>;
    }>(app, `/v1/conversations/${conversationId}`, owner.cookie);
    expect(
      persisted.messages.find(
        (message) => message.clientMessageId === `agent-reply-${responseBody.id}`
      )?.content.text
    ).toMatch(/activate a different available model/iu);

    await app.close();
  });

  it("uses the persisted in-process global default for an otherwise unbound conversation - provider-neutral, not hardcoded to OpenAI", async () => {
    const globalDefaultModelId = "grogoni-local-default";
    const store = createCp2Store({
      modelRuntimeAdapterResolver: ({ modelId, executionTarget }) =>
        modelId === globalDefaultModelId && executionTarget === "backend"
          ? healthyAdapter(globalDefaultModelId, { executionTarget: "backend" })
          : undefined
    });
    // services/api/src/index.ts no longer requires (or health-checks) any model vendor at
    // startup - see docs/architecture/provider-neutral-runtime.md. An unbound conversation only
    // resolves once an operator has actually chosen a model for the global default slot, and any
    // catalog model works, not just OpenAI.
    store.activateGlobalDefaultModel({
      model: {
        id: globalDefaultModelId,
        label: "Grogoni local default",
        provider: "local",
        description: "A non-OpenAI model proving the global default is not vendor-locked.",
        capabilities: ["chat", "tool-routing"],
        available: true,
        source: "huggingface",
        format: "GGUF",
        license: null,
        licenseUrl: null,
        modelCardUrl: null,
        downloadUrl: null,
        fileName: null,
        fileSizeBytes: null,
        minimumMemoryGb: null,
        recommended: false,
        contextWindow: null
      },
      executionTarget: "backend",
      checkedAt: new Date().toISOString(),
      updatedBy: "system"
    });
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "+254700002008", "Configuration Guidance Shop");
    const conversations = await getJson<{ conversations: Array<{ id: string }> }>(
      app,
      "/v1/conversations",
      owner.cookie
    );
    const conversationId = conversations.conversations[0]?.id;
    expect(conversationId).toBeTruthy();

    const response = await app.inject({
      method: "POST",
      url: "/v1/messages",
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({
        conversationId,
        clientMessageId: "binding-chat-configure-0001",
        content: { type: "text", text: "Can you help?" },
        clientTimestamp: new Date().toISOString(),
        agent: {
          businessId: owner.businessId,
          message: "Can you help?"
        }
      })
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      agentMessage: {
        content: {
          type: "text",
          text: expect.stringMatching(/market/iu)
        }
      },
      processing: {
        status: "completed",
        errorCode: null
      }
    });

    await app.close();
  });

  it("rejects unbound chat, cross-shop activation, retired execution targets, and absent bridges", async () => {
    const adapter = healthyAdapter(primaryModelId);
    const store = createCp2Store({
      modelRuntimeAdapterResolver: ({ modelId }) =>
        modelId === primaryModelId ? adapter : undefined
    });
    const app = buildApi({ cp2: { store } });
    const first = await createOwnerBusiness(app, "+254700002004", "First Shop");
    const second = await createOwnerBusiness(app, "+254700002005", "Second Shop");

    // "Unbound" no longer means "chat fails": zero-setup provisioning resolves the platform
    // default (here, the one adapter-verified catalog model, primaryModelId) on this very turn,
    // exactly like a never-configured shop's first chat. See
    // docs/architecture/runtime-resolution.md.
    const unbound = await app.inject({
      method: "POST",
      url: `/businesses/${first.businessId}/runtime/turns`,
      headers: jsonHeaders(first.cookie),
      payload: JSON.stringify({ message: "hello" })
    });
    expect(unbound.statusCode).toBe(200);
    expect(unbound.json()).toMatchObject({
      turn: { model: { status: "available", modelId: primaryModelId } }
    });

    const crossShop = await app.inject({
      method: "POST",
      url: `/api/agents/${first.businessId}/models/${primaryModelId}/activate`,
      headers: jsonHeaders(second.cookie),
      payload: JSON.stringify(activationPayload(first.businessId))
    });
    expect(crossShop.statusCode).toBe(403);

    const active = await activate(app, first, primaryModelId);
    const unauthenticatedRemoval = await app.inject({
      method: "DELETE",
      url: `/api/agents/${first.businessId}/model-binding?shopId=${first.businessId}`
    });
    expect(unauthenticatedRemoval.statusCode).toBe(401);
    const crossShopRemoval = await app.inject({
      method: "DELETE",
      url: `/api/agents/${first.businessId}/model-binding?shopId=${first.businessId}`,
      headers: { cookie: second.cookie }
    });
    expect(crossShopRemoval.statusCode).toBe(403);
    expect(await getBinding(app, first)).toMatchObject({ id: active.binding.id });

    const unconfiguredBackend = await app.inject({
      method: "POST",
      url: `/api/agents/${first.businessId}/models/${replacementModelId}/test`,
      headers: jsonHeaders(first.cookie),
      payload: JSON.stringify({ shopId: first.businessId, executionTarget: "backend" })
    });
    expect(unconfiguredBackend.statusCode).toBe(503);
    expect(unconfiguredBackend.json()).toMatchObject({ code: "RUNTIME_NOT_CONFIGURED" });

    // "browser-local" and "installed-app" are on-device targets again
    // (ADR-explicit-device-local-models.md), but only for catalog models declared as on-device -
    // a hosted/server model can never be switched onto a member's device.
    for (const executionTarget of ["browser-local", "installed-app"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/agents/${first.businessId}/models/${primaryModelId}/activate`,
        headers: jsonHeaders(first.cookie),
        payload: JSON.stringify({
          ...activationPayload(first.businessId),
          executionTarget
        })
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "MODEL_RUNTIME_INCOMPATIBLE" });
    }

    await app.close();
  });

  it("rejects a hosted model activated against a remote-shop-device execution target", async () => {
    const store = createCp2Store({
      modelRuntimeAdapterResolver: ({ modelId }) =>
        modelId === primaryModelId ? healthyAdapter(primaryModelId) : undefined
    });
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "+254700002006", "Hosted Model Shop");

    // gpt-6-luna (the platform default) is a hosted catalog entry (format: "remote", no
    // downloadable artifact) - it can only run through a server-reachable target, never the
    // merchant's own device.
    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${owner.businessId}/models/gpt-6-luna/activate`,
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({
        ...activationPayload(owner.businessId),
        executionTarget: "remote-shop-device"
      })
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "MODEL_RUNTIME_INCOMPATIBLE" });

    await app.close();
  });

  it("rejects CLOUD_ONLY execution mode paired with a non-backend execution target", async () => {
    const store = createCp2Store({
      modelRuntimeAdapterResolver: ({ modelId }) =>
        modelId === primaryModelId ? healthyAdapter(primaryModelId) : undefined
    });
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "+254700002007", "Cloud Only Shop");

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${owner.businessId}/models/${primaryModelId}/activate`,
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({
        ...activationPayload(owner.businessId),
        executionTarget: "remote-shop-device",
        executionMode: "CLOUD_ONLY"
      })
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "MODEL_CONFIGURATION_INVALID" });

    await app.close();
  });

  it("requires merchant cost responsibility before activating a custom model", async () => {
    const store = createCp2Store({
      modelRuntimeAdapterResolver: ({ modelId }) => healthyAdapter(modelId)
    });
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "+254700002008", "Cost Policy Shop");

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${owner.businessId}/models/${primaryModelId}/activate`,
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({
        ...activationPayload(owner.businessId),
        costResponsibility: undefined
      })
    });

    expect(response.statusCode).toBe(402);
    expect(response.json()).toMatchObject({
      code: "CUSTOM_MODEL_COST_ACCEPTANCE_REQUIRED",
      details: { modelId: primaryModelId, costResponsibility: "merchant" }
    });
    await app.close();
  });
});

describe("Vercel model adapter", () => {
  it("validates artifact availability and captures usage and latency", async () => {
    const requestMock = vercelInferenceFetch();
    const adapter = createVercelModelAdapter({
      modelId: primaryModelId,
      artifactStore: fakeArtifactStore(),
      client: createVercelInferenceClient({
        baseUrl: "https://vercel-inference.example",
        serviceToken: "test-inference-token-that-is-at-least-32-characters",
        timeoutMs: 1_000,
        request: requestMock
      })
    });
    const health = await adapter.healthCheck({
      agentId: "agent",
      shopId: "shop",
      modelId: primaryModelId
    });
    expect(health).toMatchObject({
      available: true,
      modelId: primaryModelId,
      provider: "llama.cpp",
      executionTarget: "vercel"
    });
    expect(requestMock).toHaveBeenCalledWith(
      new URL("https://vercel-inference.example/health"),
      expect.objectContaining({
        method: "GET",
        credentials: "omit",
        headers: expect.objectContaining({
          authorization: "Bearer test-inference-token-that-is-at-least-32-characters"
        })
      })
    );
  });

  it("rejects an empty generation result and a mismatched result requestId", async () => {
    const emptyText = createVercelModelAdapter({
      modelId: primaryModelId,
      artifactStore: fakeArtifactStore(),
      client: createVercelInferenceClient({
        baseUrl: "https://vercel-inference.example",
        serviceToken: "test-inference-token-that-is-at-least-32-characters",
        timeoutMs: 1_000,
        request: vercelInferenceFetch({ text: "" })
      })
    });
    await expect(
      emptyText.generate({
        context: { agentId: "agent", shopId: "shop", modelId: primaryModelId },
        prompt: runtimePrompt("hello")
      })
    ).rejects.toMatchObject({ code: "INVALID_INFERENCE_RESPONSE" });

    const mismatchedRequestId = createVercelModelAdapter({
      modelId: primaryModelId,
      artifactStore: fakeArtifactStore(),
      client: createVercelInferenceClient({
        baseUrl: "https://vercel-inference.example",
        serviceToken: "test-inference-token-that-is-at-least-32-characters",
        timeoutMs: 1_000,
        request: vercelInferenceFetch({ resultRequestId: "a-different-request-id" })
      })
    });
    await expect(
      mismatchedRequestId.generate({
        context: { agentId: "agent", shopId: "shop", modelId: primaryModelId },
        prompt: runtimePrompt("hello")
      })
    ).rejects.toMatchObject({ code: "INVALID_INFERENCE_RESPONSE" });
  });

  it("requests the runtime JSON contract and normalizes a plain model response", async () => {
    const requestMock = vercelInferenceFetch({ text: "market" });
    const adapter = createVercelModelAdapter({
      modelId: primaryModelId,
      artifactStore: fakeArtifactStore(),
      client: createVercelInferenceClient({
        baseUrl: "https://vercel-inference.example",
        serviceToken: "test-inference-token-that-is-at-least-32-characters",
        timeoutMs: 1_000,
        request: requestMock
      })
    });

    const completion = await adapter.generate({
      context: { agentId: "agent", shopId: "shop", modelId: primaryModelId },
      prompt: runtimePrompt("Reply with the word market")
    });

    expect(JSON.parse(completion.text)).toEqual({ type: "response", message: "market" });
    expect(completion).toMatchObject({
      provider: "llama.cpp",
      executionTarget: "vercel",
      inferenceRequestId: expect.any(String),
      promptTokens: 7,
      completionTokens: 3
    });
    const generationCall = requestMock.mock.calls.find(([url]) =>
      String(url).endsWith("/v1/inference")
    );
    const sentBody = JSON.parse(String(generationCall?.[1]?.body));
    expect(sentBody).toMatchObject({
      model: { id: primaryModelId },
      generation: { jsonOutput: true }
    });
  });

  it("does not retry generation after a single Vercel-reported failure", async () => {
    const requestMock = vercelInferenceFetch({ generationErrorCode: "MODEL_GENERATION_FAILED" });
    const adapter = createVercelModelAdapter({
      modelId: primaryModelId,
      artifactStore: fakeArtifactStore(),
      client: createVercelInferenceClient({
        baseUrl: "https://vercel-inference.example",
        serviceToken: "test-inference-token-that-is-at-least-32-characters",
        timeoutMs: 1_000,
        request: requestMock
      })
    });

    await expect(
      adapter.generate({
        context: { agentId: "agent", shopId: "shop", modelId: primaryModelId },
        prompt: runtimePrompt("hello")
      })
    ).rejects.toMatchObject({ code: "MODEL_GENERATION_FAILED" });

    expect(
      requestMock.mock.calls.filter(([url]) => String(url).endsWith("/v1/inference"))
    ).toHaveLength(1);
  });

  it("propagates a caller abort into an in-flight health check", async () => {
    const controller = new AbortController();
    const requestMock = vi.fn((input: URL | RequestInfo, init?: RequestInit) => {
      if (String(input).endsWith("/health")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true }
          );
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });
    const adapter = createVercelModelAdapter({
      modelId: primaryModelId,
      artifactStore: fakeArtifactStore(),
      client: createVercelInferenceClient({
        baseUrl: "https://vercel-inference.example",
        serviceToken: "test-inference-token-that-is-at-least-32-characters",
        timeoutMs: 1_000,
        request: requestMock as unknown as typeof fetch
      })
    });

    const healthPromise = adapter.healthCheck({
      agentId: "agent",
      shopId: "shop",
      modelId: primaryModelId,
      signal: controller.signal
    });
    await vi.waitFor(() => expect(requestMock).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(healthPromise).resolves.toMatchObject({
      available: false,
      errorCode: "INFERENCE_CANCELLED"
    });
  });
});

function fakeArtifactStore(): ModelArtifactStore {
  return {
    async resolveArtifact(modelId) {
      return {
        id: `test:${modelId}`,
        modelId,
        storageProvider: "neon-object-storage",
        bucket: "grogoni-model-artifacts",
        objectKey: `models/${modelId}/model.gguf`,
        format: "gguf",
        quantization: "Q4_0",
        sizeBytes: 12,
        sha256: null,
        contentType: "application/octet-stream",
        status: "available",
        createdAt: "2026-08-31T00:00:00.000Z",
        updatedAt: "2026-08-31T00:00:00.000Z"
      };
    },
    async createDownloadUrl(artifact) {
      return {
        ...artifact,
        downloadUrl: "https://storage.example.neon.tech/grogoni-model-artifacts/model.gguf",
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      };
    },
    async verifyArtifact() {
      return { ok: true, sizeMatches: true, hashMatches: null, errorCode: null };
    }
  };
}

/** Mocks the NDJSON wire contract services/ai-runtime/src/vercel-handler.ts actually serves. */
function vercelInferenceFetch(
  overrides: {
    text?: string;
    resultRequestId?: string;
    generationErrorCode?: string;
  } = {}
): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    const requestId =
      typeof init?.body === "string"
        ? ((JSON.parse(init.body) as { requestId?: string }).requestId ?? "inference-request-1")
        : "inference-request-1";
    const events = overrides.generationErrorCode
      ? [
          { type: "status", state: "INITIALIZING" },
          {
            type: "error",
            code: overrides.generationErrorCode,
            message: "generation failed",
            retryable: true
          }
        ]
      : [
          { type: "status", state: "INITIALIZING" },
          { type: "status", state: "READY", cacheHit: false },
          {
            type: "result",
            requestId: overrides.resultRequestId ?? requestId,
            text: overrides.text ?? "GROGONI_MODEL_OK",
            finishReason: "stop",
            usage: { inputTokens: 7, outputTokens: 3 },
            metrics: {}
          }
        ];
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events)
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        controller.close();
      }
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
  });
}

function healthyAdapter(
  modelId: string,
  options: {
    healthOk?: boolean;
    prompts?: RuntimeModelPrompt[];
    executionTarget?: ModelExecutionTarget;
  } = {}
): ModelRuntimeAdapter {
  const executionTarget = options.executionTarget ?? "backend";
  return {
    provider: "test",
    executionTarget,
    async canRun() {
      return { available: true, errorCode: null, message: null };
    },
    async healthCheck() {
      const ok = options.healthOk ?? true;
      return {
        available: ok,
        modelId,
        provider: "test",
        executionTarget,
        latencyMs: 4,
        responsePreview: ok ? "GROGONI_MODEL_OK" : "not ready",
        errorCode: ok ? null : "MODEL_HEALTH_CHECK_FAILED",
        message: ok ? null : "The model did not pass readiness.",
        retryable: !ok
      };
    },
    async generate({ prompt }) {
      options.prompts?.push(prompt);
      return {
        text: JSON.stringify({ type: "response", message: "market" }),
        modelId,
        provider: "test",
        executionTarget,
        latencyMs: 8
      };
    }
  };
}

function failingGenerationAdapter(modelId: string, code: string): ModelRuntimeAdapter {
  const adapter = healthyAdapter(modelId);
  adapter.generate = async () => {
    throw new ModelRuntimeError(code, "Primary runtime failed.", true);
  };
  return adapter;
}

function activationPayload(shopId: string) {
  return {
    shopId,
    executionTarget: "backend" as ModelExecutionTarget,
    executionMode: "LOCAL_FIRST",
    costResponsibility: "merchant",
    permissions: {
      allowRemoteShopDevice: false
    }
  };
}

async function activate(
  app: ReturnType<typeof buildApi>,
  owner: { businessId: string; cookie: string },
  modelId: string
): Promise<AgentModelActivationResult> {
  const response = await app.inject({
    method: "POST",
    url: `/api/agents/${owner.businessId}/models/${modelId}/activate`,
    headers: jsonHeaders(owner.cookie),
    payload: JSON.stringify(activationPayload(owner.businessId))
  });
  expect(response.statusCode).toBe(200);
  return response.json<AgentModelActivationResult>();
}

function activeNativeBindingsForAgent(store: ReturnType<typeof createCp2Store>, agentId: string) {
  return store
    .snapshot()
    .nativeRuntimeBindings.filter(
      (candidate) => candidate.agentId === agentId && candidate.status === "active"
    );
}

async function getBinding(
  app: ReturnType<typeof buildApi>,
  owner: { businessId: string; cookie: string }
): Promise<AgentModelBindingSummary | null> {
  const response = await app.inject({
    method: "GET",
    url: `/api/agents/${owner.businessId}/model-binding?shopId=${owner.businessId}`,
    headers: { cookie: owner.cookie }
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ binding: AgentModelBindingSummary | null }>().binding;
}

async function removeBinding(
  app: ReturnType<typeof buildApi>,
  owner: { businessId: string; cookie: string }
) {
  const response = await app.inject({
    method: "DELETE",
    url: `/api/agents/${owner.businessId}/model-binding?shopId=${owner.businessId}`,
    headers: { cookie: owner.cookie }
  });
  expect(response.statusCode).toBe(200);
  return response.json<{
    agentId: string;
    shopId: string;
    binding: null;
    removedBindingId: string | null;
  }>();
}

async function createOwnerBusiness(
  app: ReturnType<typeof buildApi>,
  contact: string,
  name: string
): Promise<{ businessId: string; cookie: string }> {
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: jsonHeaders(),
    payload: JSON.stringify({ method: "phone", contact, pin: "1234" })
  });
  expect(signup.statusCode).toBe(200);
  const cookie = sessionCookie(signup.headers["set-cookie"]);
  const business = await app.inject({
    method: "POST",
    url: "/businesses",
    headers: jsonHeaders(cookie),
    payload: JSON.stringify({ name, language: "en" })
  });
  expect(business.statusCode).toBe(200);
  return {
    businessId: business.json<{ business: { id: string } }>().business.id,
    cookie
  };
}

async function getJson<T>(
  app: ReturnType<typeof buildApi>,
  url: string,
  cookie: string
): Promise<T> {
  const response = await app.inject({ method: "GET", url, headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return response.json<T>();
}

async function putJson(
  app: ReturnType<typeof buildApi>,
  url: string,
  payload: Record<string, unknown>,
  cookie: string
): Promise<void> {
  const response = await app.inject({
    method: "PUT",
    url,
    headers: jsonHeaders(cookie),
    payload: JSON.stringify(payload)
  });
  expect(response.statusCode).toBe(200);
}

function jsonHeaders(cookie?: string) {
  return {
    "content-type": "application/json",
    ...(cookie === undefined ? {} : { cookie })
  };
}

function sessionCookie(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) throw new Error("Expected a session cookie.");
  return value.split(";")[0] ?? value;
}

function runtimePrompt(message: string): RuntimeModelPrompt {
  return {
    message,
    context: {
      businessId: "shop",
      userId: "user",
      role: "owner",
      productCount: 0,
      customerCount: 0,
      supplierCount: 0,
      invoiceCount: 0,
      paymentCount: 0,
      importJobCount: 0
    },
    allowedTools: [],
    schemaVersion: "cp11-runtime-model-v1"
  };
}
