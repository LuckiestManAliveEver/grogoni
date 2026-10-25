import { describe, expect, it, vi } from "vitest";
import type {
  AiModelSummary,
  ConversationSummary,
  NativeExecutionHostSummary,
  NativeModelInstallationSummary,
  NativeRuntimeAgentSummary,
  NativeRuntimeBindingModelSummary,
  NativeRuntimeBindingSummary,
  NativeRuntimeModelSummary
} from "../packages/shared-types/src";
import {
  globalDefaultRuntimeBindingId,
  NativeRuntimeBindingStore
} from "../services/api/src/cp2/domains/native-runtime/store";

const timestamp = "2026-08-27T12:00:00.000Z";

describe("native runtime binding resolver", () => {
  it("keeps the shared default agent unchanged when later requests restore it", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(timestamp));
      const store = new NativeRuntimeBindingStore();
      const snapshot = {
        nativeRuntimeAgents: structuredClone([...store.agentsMap.values()]),
        nativeRuntimeBindings: structuredClone([...store.bindingsMap.values()])
      };
      vi.setSystemTime(new Date(Date.parse(timestamp) + 60_000));
      store.restore(snapshot);
      store.ensureGlobalDefault();
      expect([...store.agentsMap.values()]).toEqual(snapshot.nativeRuntimeAgents);
      expect([...store.bindingsMap.values()]).toEqual(snapshot.nativeRuntimeBindings);
    } finally {
      vi.useRealTimers();
    }
  });
  it("resolves an explicit binding, installation, host, ordered fallbacks, and auxiliaries", () => {
    const graph = graphStore();
    const resolved = resolveGraph(graph.store, "conversation-1", graph.conversations);

    expect(resolved.usedGlobalDefault).toBe(false);
    expect(resolved.binding.id).toBe("binding-1");
    expect(resolved.agent.id).toBe("agent-1");
    expect(resolved.primary.model.id).toBe("model-primary");
    expect(resolved.primary.installation?.id).toBe("installation-primary");
    expect(resolved.primary.host?.id).toBe("host-primary");
    expect(resolved.fallbacks.map((candidate) => candidate.model.id)).toEqual([
      "model-fallback-0",
      "model-fallback-1"
    ]);
    expect(resolved.auxiliaries.verifier?.[0]?.model.id).toBe("model-verifier");
    expect(resolved.selected.model.id).toBe("model-primary");
  });

  it("boots with an unconfigured, provider-neutral global default: no vendor is required to start", () => {
    const store = new NativeRuntimeBindingStore();
    const binding = store.bindingsMap.get(globalDefaultRuntimeBindingId);
    expect(binding).toMatchObject({ status: "draft", isDefault: true });
    expect(
      [...store.bindingModelsMap.values()].filter(
        (role) => role.runtimeBindingId === globalDefaultRuntimeBindingId
      )
    ).toEqual([]);
    expect(store.modelsMap.size).toBe(0);
    expect(store.hostsMap.size).toBe(0);
  });

  it("reports RUNTIME_MODEL_NOT_CONFIGURED for the unconfigured global default, then resolves once any model is bound - not just OpenAI", () => {
    const store = new NativeRuntimeBindingStore();
    const conversation = conversationRecord(null);
    expect(() =>
      resolveGraph(store, conversation.id, new Map([[conversation.id, conversation]]))
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_MODEL_NOT_CONFIGURED" }));

    store.activateGlobalDefaultModel({
      model: localCatalogModel("local-model"),
      executionTarget: "remote-shop-device",
      checkedAt: timestamp,
      updatedBy: "user-1"
    });
    const resolved = resolveGraph(
      store,
      conversation.id,
      new Map([[conversation.id, conversation]])
    );
    expect(resolved.usedGlobalDefault).toBe(true);
    expect(resolved.binding.id).toBe(globalDefaultRuntimeBindingId);
    expect(resolved.binding.status).toBe("active");
    expect(resolved.selected.model.id).toBe("local-model");
    expect(resolved.selected.model.provider).not.toBe("openai");
    expect(resolved.selected.host?.type).toBe("remote-shop-device");
  });

  it("swaps the global default's model in place: same binding id, no new agent or conversation", () => {
    const store = new NativeRuntimeBindingStore();
    store.activateGlobalDefaultModel({
      model: localCatalogModel("local-model-x"),
      executionTarget: "remote-shop-device",
      checkedAt: timestamp,
      updatedBy: "user-1"
    });
    const afterFirst = store.bindingsMap.get(globalDefaultRuntimeBindingId);

    const swapped = store.activateGlobalDefaultModel({
      model: localCatalogModel("local-model-y"),
      executionTarget: "remote-shop-device",
      checkedAt: "2026-08-27T12:05:00.000Z",
      updatedBy: "user-1"
    });

    expect(swapped.id).toBe(afterFirst?.id);
    const primaryRoles = [...store.bindingModelsMap.values()].filter(
      (role) => role.runtimeBindingId === globalDefaultRuntimeBindingId && role.role === "primary"
    );
    expect(primaryRoles).toHaveLength(1);
    expect(primaryRoles[0]?.modelId).toBe("local-model-y");

    const conversation = conversationRecord(null);
    const resolved = resolveGraph(
      store,
      conversation.id,
      new Map([[conversation.id, conversation]])
    );
    expect(resolved.binding.id).toBe(globalDefaultRuntimeBindingId);
    expect(resolved.selected.model.id).toBe("local-model-y");
  });

  it("binds fallback by model identity and an independent target, never by provider name", () => {
    const store = new NativeRuntimeBindingStore();
    const fallbackModel: AiModelSummary = {
      ...localCatalogModel("provider-backed-fallback"),
      provider: "openai",
      source: "hosted",
      format: null
    };

    const binding = store.activateVerifiedModel({
      accountId: "account-1",
      businessId: "business-1",
      agentId: "agent-1",
      agentName: "Agent",
      model: localCatalogModel("local-primary"),
      executionTarget: "remote-shop-device",
      fallbackModel,
      fallbackExecutionTarget: "backend",
      updatedBy: "user-1",
      checkedAt: timestamp
    });

    const roles = [...store.bindingModelsMap.values()].filter(
      (role) => role.runtimeBindingId === binding.id
    );
    const fallbackRole = roles.find((role) => role.role === "fallback");
    expect(fallbackRole?.modelId).toBe("provider-backed-fallback");
    expect(store.modelsMap.get("provider-backed-fallback")).toMatchObject({
      provider: "openai",
      configuration: { executionTarget: "backend" }
    });
    expect(store.hostsMap.get(fallbackRole?.executionHostId ?? "")).toMatchObject({
      type: "backend",
      credentialReference: null
    });
  });

  it("never reassigns another account's active binding for the same shop-scoped agentId", () => {
    const store = new NativeRuntimeBindingStore();
    const activate = (accountId: string) =>
      store.activateVerifiedModel({
        accountId,
        businessId: "business-1",
        agentId: "agent-1",
        agentName: "Agent",
        model: localCatalogModel(`model-${accountId}`),
        executionTarget: "backend",
        fallbackModel: null,
        updatedBy: accountId,
        checkedAt: timestamp
      });

    // agentId is shop-scoped, so two staff accounts on the same shop share it - the second
    // account's activation must create its own binding, not hijack the first account's.
    const bindingA = activate("account-a");
    const bindingB = activate("account-b");

    expect(bindingB.id).not.toBe(bindingA.id);
    expect(bindingB.accountId).toBe("account-b");
    expect(store.bindingsMap.get(bindingA.id)).toMatchObject({
      accountId: "account-a",
      status: "active"
    });
    expect(store.bindingsMap.get(bindingB.id)).toMatchObject({
      accountId: "account-b",
      status: "active"
    });
    const primaryRoleFor = (bindingId: string) =>
      [...store.bindingModelsMap.values()].find(
        (role) => role.runtimeBindingId === bindingId && role.role === "primary"
      );
    expect(primaryRoleFor(bindingA.id)?.modelId).toBe("model-account-a");
    expect(primaryRoleFor(bindingB.id)?.modelId).toBe("model-account-b");

    const resolvedA = store.resolveRuntimeBinding(
      { businessId: "business-1", accountId: "account-a", agentId: "agent-1" },
      new Map()
    );
    const resolvedB = store.resolveRuntimeBinding(
      { businessId: "business-1", accountId: "account-b", agentId: "agent-1" },
      new Map()
    );
    expect(resolvedA.selected.model.id).toBe("model-account-a");
    expect(resolvedB.selected.model.id).toBe("model-account-b");

    store.deactivateBusinessAgentBinding(
      "business-1",
      "account-b",
      "agent-1",
      "account-b",
      new Date(timestamp)
    );
    expect(store.bindingsMap.get(bindingA.id)?.status).toBe("active");
    expect(store.bindingsMap.get(bindingB.id)?.status).toBe("inactive");
  });

  it("prefers the active shop binding over a stale global-default assignment for the same conversation", () => {
    const store = new NativeRuntimeBindingStore();
    const businessBinding = store.activateVerifiedModel({
      accountId: "account-1",
      businessId: "business-1",
      agentId: "agent-1",
      agentName: "Agent",
      model: localCatalogModel("shop-model"),
      executionTarget: "backend",
      fallbackModel: null,
      updatedBy: "user-1",
      checkedAt: timestamp
    });
    const conversation = {
      id: "conversation-default-shared",
      accountId: "account-1",
      activeShopId: "business-1",
      runtimeBindingId: globalDefaultRuntimeBindingId,
      createdAt: timestamp,
      updatedAt: timestamp
    } satisfies ConversationSummary;

    const resolved = store.resolveRuntimeBinding(
      {
        businessId: "business-1",
        accountId: "account-1",
        agentId: "agent-1",
        conversationId: conversation.id
      },
      new Map([[conversation.id, conversation]])
    );

    expect(resolved.binding.id).toBe(businessBinding.id);
    expect(resolved.source).toBe("explicit-account");
    expect(resolved.usedGlobalDefault).toBe(false);
    expect(resolved.selected.model.id).toBe("shop-model");
  });

  it("rejects assigning the global default a model missing a required capability", () => {
    const store = new NativeRuntimeBindingStore();
    expect(() =>
      store.activateGlobalDefaultModel({
        model: { ...localCatalogModel("embedding-only"), capabilities: ["embeddings"] },
        executionTarget: "remote-shop-device",
        checkedAt: timestamp,
        updatedBy: "user-1"
      })
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_MODEL_CAPABILITY_MISMATCH" }));
  });

  it("returns an explicit error when no global default exists", () => {
    const store = new NativeRuntimeBindingStore();
    store.clear();
    const conversation = conversationRecord(null);
    expect(() =>
      resolveGraph(store, conversation.id, new Map([[conversation.id, conversation]]))
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_DEFAULT_MISSING" }));
  });

  it("rejects inactive bindings and missing agents", () => {
    const inactive = graphStore();
    inactive.store.bindingsMap.set("binding-1", {
      ...(inactive.store.bindingsMap.get("binding-1") as NativeRuntimeBindingSummary),
      status: "inactive"
    });
    expect(() =>
      resolveGraph(inactive.store, "conversation-1", inactive.conversations)
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_BINDING_INACTIVE" }));

    const missingAgent = graphStore();
    missingAgent.store.agentsMap.delete("agent-1");
    expect(() =>
      resolveGraph(missingAgent.store, "conversation-1", missingAgent.conversations)
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_AGENT_UNAVAILABLE" }));
  });

  it("rejects missing or disabled primary roles", () => {
    for (const mode of ["missing", "disabled"] as const) {
      const graph = graphStore();
      const primary = [...graph.store.bindingModelsMap.values()].find(
        (role) => role.runtimeBindingId === "binding-1" && role.role === "primary"
      ) as NativeRuntimeBindingModelSummary;
      if (mode === "missing") graph.store.bindingModelsMap.delete(primary.id);
      else graph.store.bindingModelsMap.set(primary.id, { ...primary, enabled: false });
      expect(() => resolveGraph(graph.store, "conversation-1", graph.conversations)).toThrowError(
        expect.objectContaining({ code: "RUNTIME_PRIMARY_INVALID" })
      );
    }
  });

  it("selects fallbacks deterministically as persisted availability changes", () => {
    const graph = graphStore();
    setHostStatus(graph.store, "host-primary", "unavailable");
    let resolved = resolveGraph(graph.store, "conversation-1", graph.conversations);
    expect(resolved.selected.model.id).toBe("model-fallback-0");
    expect(resolved.fallbackUsed).toBe(true);
    expect(resolved.fallbackReason).toBe("EXECUTION_HOST_UNAVAILABLE");

    setInstallationStatus(graph.store, "installation-fallback-0", "unavailable");
    resolved = resolveGraph(graph.store, "conversation-1", graph.conversations);
    expect(resolved.selected.model.id).toBe("model-fallback-1");

    setHostStatus(graph.store, "host-fallback-1", "unavailable");
    expect(() => resolveGraph(graph.store, "conversation-1", graph.conversations)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_MODELS_UNAVAILABLE" })
    );
  });

  it("reports missing installations and hosts as unavailable without probing the network", () => {
    const graph = graphStore();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network forbidden"));
    graph.store.installationsMap.delete("installation-primary");
    setInstallationStatus(graph.store, "installation-fallback-0", "unavailable");
    graph.store.hostsMap.delete("host-fallback-1");
    expect(() => resolveGraph(graph.store, "conversation-1", graph.conversations)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_MODELS_UNAVAILABLE" })
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("rejects a model missing a required capability, distinctly from a contract-version mismatch", () => {
    const graph = graphStore();
    const model = graph.store.modelsMap.get("model-primary") as NativeRuntimeModelSummary;
    graph.store.modelsMap.set(model.id, { ...model, capabilities: ["chat"] });
    expect(() => resolveGraph(graph.store, "conversation-1", graph.conversations)).toThrowError(
      expect.objectContaining({ code: "RUNTIME_MODEL_CAPABILITY_MISMATCH" })
    );

    const versionMismatch = graphStore();
    const versionedModel = versionMismatch.store.modelsMap.get(
      "model-primary"
    ) as NativeRuntimeModelSummary;
    versionMismatch.store.modelsMap.set(versionedModel.id, {
      ...versionedModel,
      runtimeContractVersion: "2"
    });
    expect(() =>
      resolveGraph(versionMismatch.store, "conversation-1", versionMismatch.conversations)
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_CONTRACT_INCOMPATIBLE" }));
  });

  describe("one resolver for conversation and conversation-free callers", () => {
    it("resolves the same binding graph through the same function for both call shapes", () => {
      const graph = graphStore();
      const viaConversation = resolveGraph(graph.store, "conversation-1", graph.conversations);
      const viaAgent = resolveGraph(graph.store);

      expect(viaAgent).not.toBeNull();
      expect(viaAgent?.binding.id).toBe(viaConversation.binding.id);
      expect(viaAgent?.agent.id).toBe(viaConversation.agent.id);
      expect(viaAgent?.primary.model.id).toBe(viaConversation.primary.model.id);
      expect(viaAgent?.fallbacks.map((candidate) => candidate.model.id)).toEqual(
        viaConversation.fallbacks.map((candidate) => candidate.model.id)
      );
      expect(viaAgent?.selected.model.id).toBe(viaConversation.selected.model.id);
      // Sentinel conversation id, not a real Conversation - there is none for this caller.
      expect(viaAgent?.conversationId).toBe("runtime-unbound");
    });

    it("reports the same unresolved default state for a caller without a conversation", () => {
      const store = new NativeRuntimeBindingStore();
      expect(() => resolveGraph(store)).toThrowError(
        expect.objectContaining({ code: "RUNTIME_MODEL_NOT_CONFIGURED" })
      );
    });

    it("reflects fallback selection as installation/host availability changes, same as the conversation path", () => {
      const graph = graphStore();
      setHostStatus(graph.store, "host-primary", "unavailable");
      const resolved = resolveGraph(graph.store);
      expect(resolved?.selected.model.id).toBe("model-fallback-0");
      expect(resolved?.fallbackUsed).toBe(true);
    });
  });

  it("preserves an authorized explicit assignment and rejects cross-account bindings", () => {
    const graph = graphStore();
    expect(
      graph.store.assignConversationBinding({
        accountId: "account-1",
        activeShopId: "business-1",
        requestedBindingId: "binding-1"
      })
    ).toBe("binding-1");
    expect(() =>
      graph.store.assignConversationBinding({
        accountId: "account-2",
        activeShopId: "business-1",
        requestedBindingId: "binding-1"
      })
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_BINDING_FORBIDDEN" }));
  });
});

function resolveGraph(
  store: NativeRuntimeBindingStore,
  conversationId?: string,
  conversations: ReadonlyMap<string, ConversationSummary> = new Map()
) {
  return store.resolveRuntimeBinding(
    {
      businessId: "business-1",
      agentId: "agent-1",
      ...(conversationId === undefined ? {} : { conversationId })
    },
    conversations
  );
}

function graphStore() {
  const store = new NativeRuntimeBindingStore();
  store.clear();
  store.agentsMap.set("agent-1", agentRecord());
  for (const modelId of [
    "model-primary",
    "model-fallback-0",
    "model-fallback-1",
    "model-verifier"
  ]) {
    store.modelsMap.set(modelId, modelRecord(modelId));
  }
  for (const hostId of ["host-primary", "host-fallback-0", "host-fallback-1", "host-verifier"]) {
    store.hostsMap.set(hostId, hostRecord(hostId));
  }
  for (const [installationId, modelId, hostId] of [
    ["installation-primary", "model-primary", "host-primary"],
    ["installation-fallback-0", "model-fallback-0", "host-fallback-0"],
    ["installation-fallback-1", "model-fallback-1", "host-fallback-1"],
    ["installation-verifier", "model-verifier", "host-verifier"]
  ]) {
    store.installationsMap.set(installationId, installationRecord(installationId, modelId, hostId));
  }
  store.bindingsMap.set("binding-1", bindingRecord());
  for (const role of [
    roleRecord("primary-role", "model-primary", "primary", 0, "host-primary"),
    roleRecord("fallback-role-1", "model-fallback-1", "fallback", 1, "host-fallback-1"),
    roleRecord("fallback-role-0", "model-fallback-0", "fallback", 0, "host-fallback-0"),
    roleRecord("verifier-role", "model-verifier", "verifier", 0, "host-verifier")
  ]) {
    store.bindingModelsMap.set(role.id, role);
  }
  const conversation = conversationRecord("binding-1");
  return { store, conversations: new Map([[conversation.id, conversation]]) };
}

function localCatalogModel(id: string): AiModelSummary {
  return {
    id,
    label: id,
    provider: "local",
    description:
      "A downloaded on-device model used to prove the global default is not vendor-locked.",
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
  };
}

function agentRecord(): NativeRuntimeAgentSummary {
  return {
    id: "agent-1",
    businessId: "business-1",
    accountId: "account-1",
    name: "Agent",
    provider: "test",
    packageRef: null,
    version: "1",
    runtimeContractVersion: "1",
    capabilities: ["tools"],
    configuration: { requiredModelCapabilities: ["tool-routing"] },
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function modelRecord(id: string): NativeRuntimeModelSummary {
  return {
    id,
    name: id,
    provider: "test",
    providerModelId: id,
    runtimeContractVersion: "1",
    capabilities: ["chat", "tool-routing"],
    configuration: { executionTarget: "backend" },
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function hostRecord(id: string): NativeExecutionHostSummary {
  return {
    id,
    businessId: "business-1",
    accountId: "account-1",
    type: "backend",
    name: id,
    endpoint: null,
    status: "available",
    capabilities: ["backend"],
    configuration: {},
    credentialReference: null,
    lastKnownHealthyAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function installationRecord(
  id: string,
  modelId: string,
  executionHostId: string
): NativeModelInstallationSummary {
  return {
    id,
    modelId,
    executionHostId,
    status: "available",
    configuration: {},
    lastKnownHealthyAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function bindingRecord(): NativeRuntimeBindingSummary {
  return {
    id: "binding-1",
    businessId: "business-1",
    accountId: "account-1",
    agentId: "agent-1",
    name: "Binding",
    status: "active",
    isDefault: false,
    configuration: {},
    runtimeContractVersion: "1",
    createdAt: timestamp,
    updatedAt: timestamp,
    updatedBy: "user-1"
  };
}

function roleRecord(
  id: string,
  modelId: string,
  role: string,
  priority: number,
  executionHostId: string
): NativeRuntimeBindingModelSummary {
  return {
    id,
    runtimeBindingId: "binding-1",
    modelId,
    role,
    priority,
    executionHostId,
    configuration: {},
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function conversationRecord(runtimeBindingId: string | null): ConversationSummary {
  return {
    id: "conversation-1",
    accountId: "account-1",
    kind: "personal",
    activeShopId: "business-1",
    runtimeBindingId,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function setHostStatus(
  store: NativeRuntimeBindingStore,
  id: string,
  status: NativeExecutionHostSummary["status"]
) {
  store.hostsMap.set(id, { ...(store.hostsMap.get(id) as NativeExecutionHostSummary), status });
}

function setInstallationStatus(
  store: NativeRuntimeBindingStore,
  id: string,
  status: NativeModelInstallationSummary["status"]
) {
  store.installationsMap.set(id, {
    ...(store.installationsMap.get(id) as NativeModelInstallationSummary),
    status
  });
}
