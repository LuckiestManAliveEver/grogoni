import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AiModelSummary, ConversationRuntimeSelection } from "@grogoni/shared-types";
import { daemonAgentOptions, permanentDaemonDisplayName } from "../packages/shared-types/src";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import { runtimeAdapterIdForAgent } from "../services/api/src/agent-harness/agent-runtime-adapter";
import { daemonConversationRuntime } from "../services/api/src/daemon/conversation-runtime";
import type { ModelRuntimeAdapter } from "../services/api/src/inference/model-runtime";

function fixtureOptions() {
  const prototype = createCp2Store()
    .listAiModels()
    .find((m) => m.id === "gpt-6-luna")!;
  const models: AiModelSummary[] = ["assistant-model-a", "assistant-model-b"].map((id) => ({
    ...prototype,
    id,
    label: `Label ${id}`,
    canonicalModelId: id
  }));
  const resolver = ({ modelId }: { modelId: string }): ModelRuntimeAdapter | undefined =>
    models.some((m) => m.id === modelId)
      ? {
          provider: "fixture",
          executionTarget: "backend",
          canRun: async () => ({ available: true, errorCode: null, message: null }),
          healthCheck: async () => ({
            available: true,
            errorCode: null,
            message: null,
            modelId,
            provider: "fixture",
            executionTarget: "backend",
            latencyMs: 1,
            responsePreview: null,
            retryable: false
          }),
          generate: async () => {
            throw new Error("Selection must use healthCheck.");
          }
        }
      : undefined;
  return { models, options: { configuredModels: models, modelRuntimeAdapterResolver: resolver } };
}

function account(store: ReturnType<typeof createCp2Store>, suffix: string) {
  return store.continueWithChannelPin({
    channel: "phone",
    destination: `+442079461${suffix}`,
    pin: "1234"
  });
}

function conversationRecord(store: ReturnType<typeof createCp2Store>, id: string) {
  return store.snapshot().conversations.find((conversation) => conversation.id === id)!;
}

function engineOf(store: ReturnType<typeof createCp2Store>, conversationId: string) {
  return runtimeAdapterIdForAgent(store.resolveRuntimeBinding(conversationId).agent);
}

describe("My Assistant runtime selection", () => {
  it("names the permanent daemon conversation My Assistant", () => {
    const store = createCp2Store(fixtureOptions().options);
    const owner = account(store, "101");
    const id = store.getGrogoniSessionContext({ sessionId: owner.session.id }).conversationId;
    const view = store.getConversation({ sessionId: owner.session.id, conversationId: id });
    expect(permanentDaemonDisplayName).toBe("My Assistant");
    expect(view.conversation.conversationType).toBe("DAEMON");
    expect(view.conversation.title).toBe("My Assistant");
  });

  it("reports the ID, registered agents and configured models, then switches agent and model independently", async () => {
    const { models, options } = fixtureOptions();
    const store = createCp2Store(options);
    const owner = account(store, "102");
    const id = store.getGrogoniSessionContext({ sessionId: owner.session.id }).conversationId;

    const first = await store.selectConversationModel(owner.session.id, id, {
      modelId: models[0]!.id
    });
    expect(first).toMatchObject({
      conversationId: id,
      selectedAgentId: "grogoni",
      selectedModelId: models[0]!.id,
      available: true,
      errorCode: null
    });
    expect(first.agents).toEqual(daemonAgentOptions.map((option) => ({ ...option })));
    expect(first.models.map((m) => m.id)).toEqual(expect.arrayContaining(models.map((m) => m.id)));
    expect(first.models.find((m) => m.id === models[0]!.id)?.label).toBe(`Label ${models[0]!.id}`);

    // Agent only: the model stays, the engine executing turns changes.
    const agentSwitched = await store.selectConversationModel(owner.session.id, id, {
      agentId: "pi"
    });
    expect(agentSwitched.selectedAgentId).toBe("pi");
    expect(agentSwitched.selectedModelId).toBe(models[0]!.id);
    expect(engineOf(store, id)).toBe("pi");
    expect(
      store
        .snapshot()
        .auditEvents.filter((event) => event.type === "conversation.runtime_selected")
        .at(-1)
    ).toMatchObject({
      aggregateId: id,
      payload: {
        previousAgentId: "grogoni",
        agentId: "pi",
        previousModelId: models[0]!.id,
        modelId: models[0]!.id
      }
    });

    // Model only: regression for the engine silently resetting to grogoni on every model change.
    const modelSwitched = await store.selectConversationModel(owner.session.id, id, {
      modelId: models[1]!.id
    });
    expect(modelSwitched.selectedAgentId).toBe("pi");
    expect(modelSwitched.selectedModelId).toBe(models[1]!.id);
    expect(engineOf(store, id)).toBe("pi");

    // Both survive a snapshot round trip (what every Edge request does).
    const restored = createCp2Store(options);
    restored.hydrateSnapshot(store.snapshot());
    expect(restored.getConversationModelSelection(owner.session.id, id)).toMatchObject({
      selectedAgentId: "pi",
      selectedModelId: models[1]!.id
    });
    expect(engineOf(restored, id)).toBe("pi");

    const back = await restored.selectConversationModel(owner.session.id, id, {
      agentId: "grogoni",
      modelId: models[0]!.id
    });
    expect(back).toMatchObject({ selectedAgentId: "grogoni", selectedModelId: models[0]!.id });
    expect(engineOf(restored, id)).toBe("grogoni");
  });

  it("rejects unknown agents, unknown models, empty selections and other accounts without changing the selection", async () => {
    const { models, options } = fixtureOptions();
    const store = createCp2Store(options);
    const owner = account(store, "103");
    const stranger = account(store, "104");
    const id = store.getGrogoniSessionContext({ sessionId: owner.session.id }).conversationId;
    await store.selectConversationModel(owner.session.id, id, {
      modelId: models[0]!.id,
      agentId: "pi"
    });

    await expect(
      store.selectConversationModel(owner.session.id, id, { agentId: "zeroclaw" })
    ).rejects.toMatchObject({ code: "agent_unavailable" });
    await expect(
      store.selectConversationModel(owner.session.id, id, { modelId: "not-configured" })
    ).rejects.toMatchObject({ code: "model_unavailable" });
    await expect(store.selectConversationModel(owner.session.id, id, {})).rejects.toMatchObject({
      code: "runtime_selection_empty"
    });
    await expect(
      store.selectConversationModel(stranger.session.id, id, { agentId: "grogoni" })
    ).rejects.toBeDefined();
    expect(() => store.getConversationModelSelection(stranger.session.id, id)).toThrow();

    expect(store.getConversationModelSelection(owner.session.id, id)).toMatchObject({
      selectedAgentId: "pi",
      selectedModelId: models[0]!.id
    });
  });

  it("never lets another agent chat or a help topic change My Assistant's runtime", async () => {
    const { models, options } = fixtureOptions();
    const store = createCp2Store(options);
    const owner = account(store, "106");
    const id = store.getGrogoniSessionContext({ sessionId: owner.session.id }).conversationId;
    await store.selectConversationModel(owner.session.id, id, {
      modelId: models[0]!.id,
      agentId: "grogoni"
    });
    const session = store.createConversation({
      sessionId: owner.session.id,
      kind: "personal",
      activeShopId: null,
      title: "Restock maize"
    }).conversation;
    store.ensureHelpConversations({ sessionId: owner.session.id });
    const inbox = store.listConversations({ sessionId: owner.session.id });
    const others = inbox.filter((conversation) => !conversation.isPermanentDaemon);
    expect(others.map((conversation) => conversation.id)).toContain(session.id);
    expect(others.some((conversation) => conversation.helpTopic)).toBe(true);
    // All of these are conversationType DAEMON, but none is My Assistant.
    for (const other of others.filter((c) => c.conversationType === "DAEMON")) {
      expect(() => store.getConversationModelSelection(owner.session.id, other.id)).toThrow();
      await expect(
        store.selectConversationModel(owner.session.id, other.id, { agentId: "pi" })
      ).rejects.toMatchObject({ code: "conversation_not_found" });
    }
    expect(inbox.filter((conversation) => conversation.isPermanentDaemon)).toHaveLength(1);
    expect(engineOf(store, id)).toBe("grogoni");
    expect(store.getConversationModelSelection(owner.session.id, id).selectedAgentId).toBe(
      "grogoni"
    );
  });

  it("answers shopping requests from My Assistant with its selected model", async () => {
    const { models, options } = fixtureOptions();
    const used: string[] = [];
    const store = createCp2Store({
      ...options,
      runtimeModelProviderResolver: (modelId: string) => {
        used.push(modelId);
        return undefined;
      }
    });
    const owner = account(store, "107");
    const id = store.getGrogoniSessionContext({ sessionId: owner.session.id }).conversationId;
    await store.selectConversationModel(owner.session.id, id, { modelId: models[1]!.id });
    const turn = (conversationId?: string) =>
      store
        .createBuyerShoppingTurn({
          sessionId: owner.session.id,
          shoppingSessionId: crypto.randomUUID(),
          requestId: crypto.randomUUID(),
          message: "Find 50kg maize",
          ...(conversationId === undefined ? {} : { conversationId })
        })
        .catch(() => undefined);
    await turn(id);
    await turn();
    await turn(crypto.randomUUID());
    expect(used).toEqual([models[1]!.id, "gpt-6-luna", "gpt-6-luna"]);
  });

  it("hands background tasks the engine and model chosen in the details (the Edge lane's mapping)", async () => {
    const { models, options } = fixtureOptions();
    const store = createCp2Store(options);
    const owner = account(store, "108");
    const id = store.getGrogoniSessionContext({ sessionId: owner.session.id }).conversationId;
    await store.selectConversationModel(owner.session.id, id, {
      modelId: models[1]!.id,
      agentId: "pi"
    });
    expect(daemonConversationRuntime(store, id)).toEqual({
      modelId: models[1]!.id,
      agentAdapterId: "pi"
    });
    await store.selectConversationModel(owner.session.id, id, { agentId: "grogoni" });
    expect(daemonConversationRuntime(store, id)).toEqual({
      modelId: models[1]!.id,
      agentAdapterId: "grogoni"
    });
  });

  it("keeps a switch made in another tab while a slow health check was running", async () => {
    const { models, options } = fixtureOptions();
    let release: () => void = () => undefined;
    let slowNext = false;
    const store = createCp2Store({
      ...options,
      modelRuntimeAdapterResolver: (input) => {
        const adapter = options.modelRuntimeAdapterResolver(input);
        if (!adapter) return adapter;
        return {
          ...adapter,
          healthCheck: async (context) => {
            if (slowNext) {
              slowNext = false;
              await new Promise<void>((resolve) => (release = resolve));
            }
            return adapter.healthCheck(context);
          }
        };
      }
    });
    const owner = account(store, "109");
    const id = store.getGrogoniSessionContext({ sessionId: owner.session.id }).conversationId;
    await store.selectConversationModel(owner.session.id, id, {
      modelId: models[0]!.id,
      agentId: "grogoni"
    });
    // Tab 1 switches the agent; its health check hangs. Tab 2 switches the model meanwhile.
    slowNext = true;
    const tabOne = store.selectConversationModel(owner.session.id, id, { agentId: "pi" });
    await store.selectConversationModel(owner.session.id, id, { modelId: models[1]!.id });
    release();
    expect(await tabOne).toMatchObject({ selectedAgentId: "pi", selectedModelId: models[1]!.id });
    expect(
      store
        .snapshot()
        .auditEvents.filter((event) => event.type === "conversation.runtime_selected")
        .at(-1)?.payload
    ).toMatchObject({ previousAgentId: "grogoni", previousModelId: models[1]!.id, agentId: "pi" });
  });

  it("flags a selected model that is no longer configured and keeps the engine", async () => {
    const { models, options } = fixtureOptions();
    const store = createCp2Store(options);
    const owner = account(store, "110");
    const id = store.getGrogoniSessionContext({ sessionId: owner.session.id }).conversationId;
    await store.selectConversationModel(owner.session.id, id, {
      modelId: models[1]!.id,
      agentId: "pi"
    });
    // The operator stops serving model B (its provider adapter is gone).
    const narrowed = createCp2Store({
      ...options,
      modelRuntimeAdapterResolver: (input) =>
        input.modelId === models[1]!.id ? undefined : options.modelRuntimeAdapterResolver(input)
    });
    narrowed.hydrateSnapshot(store.snapshot());
    const selection = narrowed.getConversationModelSelection(owner.session.id, id);
    expect(selection.available).toBe(false);
    expect(selection.selectedAgentId).toBe("pi");
    expect(selection.models.map((m) => m.id)).not.toContain(models[1]!.id);
    await expect(
      narrowed.selectConversationModel(owner.session.id, id, { agentId: "grogoni" })
    ).rejects.toMatchObject({ code: "model_unavailable" });
    // Picking a configured model keeps the Pi engine.
    expect(
      await narrowed.selectConversationModel(owner.session.id, id, { modelId: models[0]!.id })
    ).toMatchObject({ selectedAgentId: "pi", selectedModelId: models[0]!.id, available: true });
  });

  it("keeps My Assistant's chosen agent and model when the owner activates a shop model", async () => {
    const { models, options } = fixtureOptions();
    const shopModel = "qwen2.5-0.5b-android";
    const store = createCp2Store({
      ...options,
      modelRuntimeAdapterResolver: (input) =>
        options.modelRuntimeAdapterResolver(
          input.modelId === shopModel ? { ...input, modelId: models[0]!.id } : input
        )
    });
    const activateShop = async (owner: ReturnType<typeof account>, phone: string) => {
      const shop = store.createBusiness({
        sessionId: owner.session.id,
        name: `Shop ${phone}`,
        language: "en",
        phoneNumber: phone,
        phoneCountry: "KE"
      }).business;
      await store.activateAgentModel({
        sessionId: owner.session.id,
        businessId: shop.id,
        agentId: shop.id,
        modelId: shopModel,
        executionTarget: "backend",
        executionMode: "LOCAL_FIRST",
        costResponsibility: "merchant",
        permissions: { allowRemoteShopDevice: false }
      } as Parameters<typeof store.activateAgentModel>[0]);
    };

    const chooser = account(store, "111");
    const id = store.getGrogoniSessionContext({ sessionId: chooser.session.id }).conversationId;
    await store.selectConversationModel(chooser.session.id, id, {
      modelId: models[1]!.id,
      agentId: "pi"
    });
    await activateShop(chooser, "+254712399011");
    expect(store.getConversationModelSelection(chooser.session.id, id)).toMatchObject({
      selectedAgentId: "pi",
      selectedModelId: models[1]!.id,
      available: true
    });
    expect(daemonConversationRuntime(store, id)).toEqual({
      modelId: models[1]!.id,
      agentAdapterId: "pi"
    });

    // An owner who never chose keeps following the shop's activation, as before.
    const follower = account(store, "112");
    const other = store.getGrogoniSessionContext({ sessionId: follower.session.id }).conversationId;
    const before = conversationRecord(store, other).runtimeBindingId;
    await activateShop(follower, "+254712399012");
    expect(conversationRecord(store, other).runtimeBindingId).not.toBe(before);
  });

  it("lets the owner out when both the chosen engine and model stop being served", async () => {
    const { models, options } = fixtureOptions();
    const store = createCp2Store(options);
    const owner = account(store, "113");
    const id = store.getGrogoniSessionContext({ sessionId: owner.session.id }).conversationId;
    await store.selectConversationModel(owner.session.id, id, {
      modelId: models[1]!.id,
      agentId: "pi"
    });
    // The deployment drops the Pi engine and model B.
    const narrowed = createCp2Store({
      ...options,
      modelRuntimeAdapterResolver: (input) =>
        input.modelId === models[1]!.id ? undefined : options.modelRuntimeAdapterResolver(input),
      agentRuntimeAdapterResolver: (adapterId: string) =>
        adapterId === "grogoni"
          ? {
              id: "grogoni",
              canRun: async () => ({ available: true, errorCode: null, message: null }),
              execute: async () => {
                throw new Error("Not executed in this test.");
              }
            }
          : undefined
    });
    narrowed.hydrateSnapshot(store.snapshot());
    expect(narrowed.getConversationModelSelection(owner.session.id, id)).toMatchObject({
      selectedAgentId: "pi",
      agents: [{ id: "grogoni", label: "Grogoni agent" }],
      available: false
    });
    // Asking for Pi by name is still refused...
    await expect(
      narrowed.selectConversationModel(owner.session.id, id, {
        agentId: "pi",
        modelId: models[0]!.id
      })
    ).rejects.toMatchObject({ code: "agent_unavailable" });
    // ...but picking a working model, which the panel allows, moves to an engine that runs.
    expect(
      await narrowed.selectConversationModel(owner.session.id, id, { modelId: models[0]!.id })
    ).toMatchObject({
      selectedAgentId: "grogoni",
      selectedModelId: models[0]!.id,
      available: true
    });
  });

  it("lets shop activation rebind My Assistant once its own selection is no longer active", async () => {
    const { models, options } = fixtureOptions();
    const shopModel = "qwen2.5-0.5b-android";
    const store = createCp2Store({
      ...options,
      modelRuntimeAdapterResolver: (input) =>
        options.modelRuntimeAdapterResolver(
          input.modelId === shopModel ? { ...input, modelId: models[0]!.id } : input
        )
    });
    const owner = account(store, "114");
    const id = store.getGrogoniSessionContext({ sessionId: owner.session.id }).conversationId;
    await store.selectConversationModel(owner.session.id, id, { modelId: models[1]!.id });
    const selected = conversationRecord(store, id).runtimeBindingId!;
    const snapshot = store.snapshot();
    const restored = createCp2Store({
      ...options,
      modelRuntimeAdapterResolver: (input) =>
        options.modelRuntimeAdapterResolver(
          input.modelId === shopModel ? { ...input, modelId: models[0]!.id } : input
        )
    });
    restored.hydrateSnapshot({
      ...snapshot,
      nativeRuntimeBindings: snapshot.nativeRuntimeBindings!.map((binding) =>
        binding.id === selected ? { ...binding, status: "inactive" as const } : binding
      )
    });
    const shop = restored.createBusiness({
      sessionId: owner.session.id,
      name: "Inactive selection shop",
      language: "en",
      phoneNumber: "+254712399014",
      phoneCountry: "KE"
    }).business;
    await restored.activateAgentModel({
      sessionId: owner.session.id,
      businessId: shop.id,
      agentId: shop.id,
      modelId: shopModel,
      executionTarget: "backend",
      executionMode: "LOCAL_FIRST",
      costResponsibility: "merchant",
      permissions: { allowRemoteShopDevice: false }
    } as Parameters<typeof restored.activateAgentModel>[0]);
    expect(conversationRecord(restored, id).runtimeBindingId).not.toBe(selected);
  });

  it("only offers agent engines this deployment has registered", () => {
    const { options } = fixtureOptions();
    const store = createCp2Store({
      ...options,
      agentRuntimeAdapterResolver: (adapterId: string) =>
        adapterId === "grogoni"
          ? {
              id: "grogoni",
              canRun: async () => ({ available: true, errorCode: null, message: null }),
              execute: async () => {
                throw new Error("Not executed in this test.");
              }
            }
          : undefined
    });
    const owner = account(store, "105");
    const id = store.getGrogoniSessionContext({ sessionId: owner.session.id }).conversationId;
    expect(store.getConversationModelSelection(owner.session.id, id).agents).toEqual([
      { id: "grogoni", label: "Grogoni agent" }
    ]);
  });

  // Booting the whole API takes seconds on a busy machine; the default 5s budget is too tight.
  it(
    "serves GET and PUT /v1/conversations/:id/model with agentId and modelId over HTTP",
    { timeout: 30_000 },
    async () => {
      const { models, options } = fixtureOptions();
      const store = createCp2Store(options);
      const app = buildApi({ cp2: { store } });
      const cookie = await signUp(app, "254700000931");
      const context = await app.inject({
        method: "GET",
        url: "/v1/session/context",
        headers: { cookie }
      });
      const id = context.json<{ conversationId: string }>().conversationId;

      const put = (payload: unknown) =>
        app.inject({
          method: "PUT",
          url: `/v1/conversations/${id}/model`,
          headers: { "content-type": "application/json", cookie },
          payload: JSON.stringify(payload)
        });

      expect((await put({ modelId: models[1]!.id })).statusCode).toBe(200);
      const switched = await put({ agentId: "pi" });
      expect(switched.statusCode).toBe(200);
      expect(switched.json<ConversationRuntimeSelection>()).toMatchObject({
        conversationId: id,
        selectedAgentId: "pi",
        selectedModelId: models[1]!.id
      });

      const read = await app.inject({
        method: "GET",
        url: `/v1/conversations/${id}/model`,
        headers: { cookie }
      });
      expect(read.statusCode).toBe(200);
      expect(read.json<ConversationRuntimeSelection>().selectedAgentId).toBe("pi");

      expect((await put({ agentId: 7 })).statusCode).toBe(400);
      expect((await put({ agentId: "zeroclaw" })).statusCode).toBe(400);
      expect((await put({})).statusCode).toBe(400);
    }
  );
});

async function signUp(app: FastifyInstance, destination: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ method: "phone", contact: destination, pin: "1234" })
  });
  const header = response.headers["set-cookie"];
  const cookies = Array.isArray(header) ? header : [header ?? ""];
  const session = cookies
    .map((c) => c.split(";")[0]!)
    .find((c) => c.startsWith("grogoni_session="));
  if (!session) throw new Error(`No session cookie: ${response.statusCode} ${response.body}`);
  return session;
}
