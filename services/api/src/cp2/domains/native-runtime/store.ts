import { isDeepStrictEqual } from "node:util";
import { isLocalRuntimeHost } from "@grogoni/shared-types";
import { createHash } from "node:crypto";

import type {
  ActiveNativeAgentBinding,
  AiModelSummary,
  ConversationSummary,
  ModelExecutionTarget,
  PlatformDefaultRuntimePolicy,
  NativeDefaultRuntimeProvisioningInput,
  NativeDefaultRuntimeProvisioningResult,
  NativeRuntimeAvailabilityStatus,
  NativeRuntimeActivationInput,
  NativeExecutionHostSummary,
  NativeModelInstallationSummary,
  NativeRuntimeAgentSummary,
  NativeRuntimeBindingModelSummary,
  NativeRuntimeBindingSummary,
  NativeRuntimeModelSummary,
  NativeRuntimeResolutionInput,
  NativeRuntimeResolutionSource,
  ResolvedNativeRuntimeBinding,
  ResolvedNativeRuntimeModel
} from "@grogoni/shared-types";
import {
  isModelExecutionTarget,
  repositoryDefaultRuntimePolicy,
  resolveRuntimeModel
} from "@grogoni/shared-types";

import { Cp2Error } from "../../cp2-error.js";
import { runtimeAdapterIdForAgent } from "../../../agent-harness/agent-runtime-adapter.js";

export const nativeRuntimeContractVersion = "1";
export const builtinRuntimeAgentId = "builtin:pi:v1";
export const legacyBuiltinRuntimeAgentId = "builtin:grogoni-agent:v1";
export const globalDefaultRuntimeBindingId = "builtin:grogoni-default-runtime:v1";

export interface NativeRuntimeSnapshot {
  nativeRuntimeAgents?: NativeRuntimeAgentSummary[];
  nativeRuntimeModels?: NativeRuntimeModelSummary[];
  nativeExecutionHosts?: NativeExecutionHostSummary[];
  nativeModelInstallations?: NativeModelInstallationSummary[];
  nativeRuntimeBindings?: NativeRuntimeBindingSummary[];
  nativeRuntimeBindingModels?: NativeRuntimeBindingModelSummary[];
}

export class NativeRuntimeBindingStore {
  private readonly agents = new Map<string, NativeRuntimeAgentSummary>();
  private readonly models = new Map<string, NativeRuntimeModelSummary>();
  private readonly hosts = new Map<string, NativeExecutionHostSummary>();
  private readonly installations = new Map<string, NativeModelInstallationSummary>();
  private readonly bindings = new Map<string, NativeRuntimeBindingSummary>();
  private readonly bindingModels = new Map<string, NativeRuntimeBindingModelSummary>();

  constructor(
    private readonly defaultRuntimePolicy: PlatformDefaultRuntimePolicy = repositoryDefaultRuntimePolicy
  ) {
    this.ensureGlobalDefault();
  }

  // Safe in-memory/bootstrap shape: the built-in agent and global slot exist before persistence is
  // restored, without fabricating an executable host. Production migration 077 materializes this
  // same slot in place as Pi + SmolLM + the backend host; a configured adapter can also lazily
  // materialize the same ordinary graph for a tenant in memory.
  ensureGlobalDefault(now: Date = new Date()): NativeRuntimeBindingSummary {
    const timestamp = now.toISOString();
    const agentId = this.defaultRuntimePolicy.agentId;
    const adapterId = this.defaultRuntimePolicy.agentRuntimeAdapterId;
    const existingAgent = this.agents.get(agentId);
    const desiredAgent = {
      id: agentId,
      businessId: null,
      accountId: null,
      name: this.defaultRuntimePolicy.agentName,
      provider: agentProviderFor(adapterId),
      packageRef: agentPackageRefFor(adapterId),
      version: "1",
      runtimeContractVersion: nativeRuntimeContractVersion,
      capabilities: ["tools", "mcp"],
      configuration: {
        runtimeAdapterId: this.defaultRuntimePolicy.agentRuntimeAdapterId,
        requiredModelCapabilities: ["chat"]
      },
      status: "active" as const
    };
    // Rewritten only when its content changes. Every request runs this after hydrating; stamping
    // updatedAt each time made every signed-in request write this one shared row, so concurrent
    // requests failed their optimistic save with 40001 and the Edge API answered 503.
    if (
      existingAgent === undefined ||
      !isDeepStrictEqual(
        { ...existingAgent, createdAt: undefined, updatedAt: undefined },
        { ...desiredAgent, createdAt: undefined, updatedAt: undefined }
      )
    )
      this.agents.set(agentId, {
        ...desiredAgent,
        createdAt: existingAgent?.createdAt ?? timestamp,
        updatedAt: timestamp
      });
    const existing = this.bindings.get(globalDefaultRuntimeBindingId);
    if (existing === undefined) {
      this.bindings.set(globalDefaultRuntimeBindingId, {
        id: globalDefaultRuntimeBindingId,
        businessId: null,
        accountId: null,
        agentId,
        name: `${this.defaultRuntimePolicy.agentName} default runtime`,
        status: "draft",
        isDefault: true,
        configuration: { source: "repository-default" },
        runtimeContractVersion: nativeRuntimeContractVersion,
        createdAt: timestamp,
        updatedAt: timestamp,
        updatedBy: "system"
      });
    }
    return this.bindings.get(globalDefaultRuntimeBindingId) as NativeRuntimeBindingSummary;
  }

  // The general-purpose "choose a model" operation for the global default runtime slot: any
  // catalog model on any execution target can occupy it, and calling this again with a different
  // model swaps the primary assignment in place - the binding's id (and therefore every
  // conversation.runtimeBindingId pointing at it) never changes. This is the provider-neutral
  // replacement for the old hardcoded openai-fast seed: a backend model, an owner-node model, or
  // any future registered provider all go through this same call.
  activateGlobalDefaultModel(input: {
    model: AiModelSummary;
    executionTarget: ModelExecutionTarget;
    checkedAt: string;
    updatedBy: string;
  }): NativeRuntimeBindingSummary {
    const binding = this.bindings.get(globalDefaultRuntimeBindingId);
    const agent = this.agents.get(this.defaultRuntimePolicy.agentId);
    if (binding === undefined || agent === undefined) {
      throw new Cp2Error(
        503,
        "RUNTIME_DEFAULT_MISSING",
        "No global default runtime binding is configured."
      );
    }
    const model = this.upsertCatalogModel(input.model, input.executionTarget, input.checkedAt);
    this.validateCapabilityMatch(agent, model);
    const host = this.upsertVerifiedHost({
      accountId: null,
      businessId: null,
      executionTarget: input.executionTarget,
      checkedAt: input.checkedAt
    });
    this.upsertInstallation(model.id, host.id, input.checkedAt);
    for (const [id, role] of this.bindingModels) {
      if (role.runtimeBindingId === binding.id && role.role === "primary") {
        this.bindingModels.delete(id);
      }
    }
    const role = roleRecord(binding.id, model.id, "primary", 0, host.id, input.checkedAt);
    this.bindingModels.set(role.id, role);
    const nextBinding: NativeRuntimeBindingSummary = {
      ...binding,
      status: "active",
      updatedAt: input.checkedAt,
      updatedBy: input.updatedBy
    };
    this.bindings.set(binding.id, nextBinding);
    return { ...nextBinding };
  }

  activateVerifiedModel(input: NativeRuntimeActivationInput): NativeRuntimeBindingSummary {
    const timestamp = input.checkedAt;
    // Precedence: an explicit request always wins (this is how a caller synced to a business's
    // current agent-definition choice - see agent-runtime/store.ts's finalizeVerifiedActivation -
    // applies it); otherwise keep this shop's already-chosen engine in place (a model swap alone
    // must not silently reset it); a shop with no prior activation starts from the platform
    // default, not a hardcoded engine.
    const existingAgent = this.agents.get(input.agentId);
    const adapterId =
      input.agentRuntimeAdapterId ??
      (existingAgent === undefined
        ? this.defaultRuntimePolicy.agentRuntimeAdapterId
        : runtimeAdapterIdForAgent(existingAgent));
    const agent = this.upsertAgent({
      id: input.agentId,
      businessId: input.businessId,
      accountId: input.accountId,
      name: input.agentName,
      provider: agentProviderFor(adapterId),
      packageRef: agentPackageRefFor(adapterId),
      version: "1",
      runtimeContractVersion: nativeRuntimeContractVersion,
      capabilities: ["tools", "mcp"],
      configuration: {
        runtimeAdapterId: adapterId,
        requiredModelCapabilities: ["chat"]
      },
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const primaryModel = this.upsertCatalogModel(input.model, input.executionTarget, timestamp);
    const primaryHost = this.upsertVerifiedHost({
      accountId: input.accountId,
      businessId: input.businessId,
      executionTarget: input.executionTarget,
      checkedAt: timestamp
    });
    this.upsertInstallation(primaryModel.id, primaryHost.id, timestamp);

    // accountId must scope this lookup exactly like every other binding lookup in this store
    // (ensureDefaultRuntimeBinding's "existing" check, assignConversationBinding) - otherwise two
    // staff accounts on the same shop share one agentId, and the second account's first activation
    // silently reassigns the first account's already-provisioned binding to itself instead of
    // creating its own.
    const matching = [...this.bindings.values()].find(
      (binding) =>
        binding.businessId === input.businessId &&
        binding.accountId === input.accountId &&
        binding.agentId === agent.id &&
        binding.status === "active"
    );
    const bindingId =
      matching?.id ??
      stableUuid(`native-runtime-binding:${input.accountId}:${input.businessId}:${input.agentId}`);
    const binding: NativeRuntimeBindingSummary = {
      id: bindingId,
      businessId: input.businessId,
      accountId: input.accountId,
      agentId: agent.id,
      name: `${input.agentName} runtime`,
      status: "active",
      isDefault: false,
      configuration: { source: "model-activation" },
      runtimeContractVersion: nativeRuntimeContractVersion,
      createdAt: matching?.createdAt ?? timestamp,
      updatedAt: timestamp,
      updatedBy: input.updatedBy
    };

    const roles: NativeRuntimeBindingModelSummary[] = [
      roleRecord(binding.id, primaryModel.id, "primary", 0, primaryHost.id, timestamp)
    ];
    if (input.fallbackModel !== null) {
      const fallbackTarget = input.fallbackExecutionTarget ?? input.executionTarget;
      const fallbackModel = this.upsertCatalogModel(input.fallbackModel, fallbackTarget, timestamp);
      const fallbackHost = this.upsertVerifiedHost({
        accountId: input.accountId,
        businessId: input.businessId,
        executionTarget: fallbackTarget,
        checkedAt: timestamp
      });
      this.upsertInstallation(fallbackModel.id, fallbackHost.id, timestamp);
      roles.push(
        roleRecord(binding.id, fallbackModel.id, "fallback", 0, fallbackHost.id, timestamp)
      );
    }

    validateActiveTopology(binding, roles);
    for (const existingBinding of this.bindings.values()) {
      if (
        existingBinding.id !== binding.id &&
        existingBinding.accountId === binding.accountId &&
        existingBinding.agentId === binding.agentId &&
        existingBinding.status === "active"
      ) {
        this.bindings.set(existingBinding.id, {
          ...existingBinding,
          status: "inactive",
          isDefault: false,
          updatedAt: timestamp,
          updatedBy: input.updatedBy
        });
      }
    }
    for (const [id, role] of this.bindingModels) {
      if (role.runtimeBindingId === binding.id) this.bindingModels.delete(id);
    }
    for (const role of roles) this.bindingModels.set(role.id, role);
    this.bindings.set(binding.id, binding);
    return { ...binding };
  }

  /**
   * Idempotently provisions the minimum shop-scoped graph needed by first chat. Candidates have
   * already passed adapter availability checks, so this method performs no network I/O. Existing
   * active bindings are never reset: explicit local-only/model preferences remain authoritative.
   * Stable IDs make simultaneous first-chat requests converge even across API processes.
   */
  ensureDefaultRuntimeBinding(
    input: NativeDefaultRuntimeProvisioningInput
  ): NativeDefaultRuntimeProvisioningResult {
    const candidates = dedupeProvisioningCandidates(input.candidates);
    const existing = [...this.bindings.values()]
      .filter(
        (binding) =>
          binding.businessId === input.businessId &&
          binding.accountId === input.accountId &&
          binding.agentId === input.agentId &&
          binding.status === "active"
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (existing !== undefined) {
      // An explicit local preference remains the primary. When its policy permits fallback, the
      // domain calls this method with an adapter-verified hosted candidate (Vercel today; any
      // execution target the caller offers) so a later server request has somewhere legitimate to
      // run instead of treating the local host as reachable from the API process.
      const roles = [...this.bindingModels.values()].filter(
        (role) => role.runtimeBindingId === existing.id && role.enabled
      );
      const candidateTargets = new Set(candidates.map((candidate) => candidate.executionTarget));
      const hasMatchingHostedRole = roles.some((role) => {
        const target =
          role.executionHostId === null
            ? this.models.get(role.modelId)?.configuration.executionTarget
            : this.hosts.get(role.executionHostId)?.type;
        return isModelExecutionTarget(target) && candidateTargets.has(target);
      });
      const hostedCandidate = hasMatchingHostedRole ? undefined : candidates[0];
      if (hostedCandidate !== undefined) {
        const agent = this.requireActiveAgent(existing);
        const model = this.upsertCatalogModel(
          hostedCandidate.model,
          hostedCandidate.executionTarget,
          input.checkedAt
        );
        this.validateCapabilityMatch(agent, model);
        const host = this.upsertVerifiedHost({
          accountId: input.accountId,
          businessId: input.businessId,
          executionTarget: hostedCandidate.executionTarget,
          checkedAt: input.checkedAt
        });
        this.upsertInstallation(model.id, host.id, input.checkedAt);
        const fallbackPriority =
          Math.max(
            -1,
            ...roles.filter((role) => role.role === "fallback").map((role) => role.priority)
          ) + 1;
        const fallback = roleRecord(
          existing.id,
          model.id,
          "fallback",
          fallbackPriority,
          host.id,
          input.checkedAt
        );
        this.bindingModels.set(fallback.id, fallback);
        const extended: NativeRuntimeBindingSummary = {
          ...existing,
          configuration: { ...existing.configuration, allowFallback: true },
          updatedAt: input.checkedAt,
          updatedBy: input.updatedBy
        };
        this.bindings.set(extended.id, extended);
        return {
          binding: { ...extended },
          created: false,
          resolutionReason: "hosted-fallback-attached"
        };
      }
      return {
        binding: { ...existing },
        created: false,
        resolutionReason: "existing-binding-preserved"
      };
    }
    const [primary, ...fallbacks] = candidates;
    if (primary === undefined) {
      throw new Cp2Error(
        503,
        "RUNTIME_MODELS_UNAVAILABLE",
        "Grogoni AI is temporarily unavailable because no execution host can run a compatible model.",
        true
      );
    }

    const binding = this.activateVerifiedModel({
      businessId: input.businessId,
      accountId: input.accountId,
      agentId: input.agentId,
      agentName: input.agentName,
      ...(input.agentRuntimeAdapterId === undefined
        ? {}
        : { agentRuntimeAdapterId: input.agentRuntimeAdapterId }),
      model: primary.model,
      executionTarget: primary.executionTarget,
      fallbackModel: fallbacks[0]?.model ?? null,
      ...(fallbacks[0] === undefined
        ? {}
        : { fallbackExecutionTarget: fallbacks[0].executionTarget }),
      updatedBy: input.updatedBy,
      checkedAt: input.checkedAt
    });
    // isDefault stays false: in Postgres it marks only the global slot (063's default_scope_check
    // and one_global_default_idx). A shop row with isDefault true can never be saved, and because
    // collections are saved whole it would fail every later save in the process. The
    // configuration.source below is what marks this binding as the shop's provisioned default.
    const provisioned: NativeRuntimeBindingSummary = {
      ...binding,
      isDefault: false,
      configuration: {
        ...binding.configuration,
        source: "zero-setup-provisioning",
        executionPolicy: "automatic-hosted-first",
        allowFallback: true
      }
    };
    this.bindings.set(provisioned.id, provisioned);
    return {
      binding: { ...provisioned },
      created: true,
      resolutionReason: "default-binding-created"
    };
  }

  bindingForBusinessAgent(
    businessId: string,
    agentId: string,
    accountId?: string
  ): NativeRuntimeBindingSummary | null {
    return (
      [...this.bindings.values()]
        .filter(
          (binding) =>
            binding.businessId === businessId &&
            binding.agentId === agentId &&
            (accountId === undefined || binding.accountId === accountId) &&
            binding.status === "active"
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null
    );
  }

  /** The single per-shop-agent binding + its enabled primary model, the sole read path for "which
   *  model is this agent using" (replaces the retired legacy agentModelBindings map/table).
   *  Returns null rather than throwing when nothing is active yet, or when a matched binding has no
   *  enabled primary role - both are normal "not configured" states for a GET/routing read, not
   *  errors. */
  getActiveBindingForAgent(
    businessId: string,
    agentId: string,
    accountId?: string
  ): ActiveNativeAgentBinding | null {
    const binding = this.bindingForBusinessAgent(businessId, agentId, accountId);
    if (binding === null) return null;
    const role = [...this.bindingModels.values()].find(
      (candidate) =>
        candidate.runtimeBindingId === binding.id &&
        candidate.enabled &&
        candidate.role === "primary"
    );
    if (role === undefined) return null;
    const model = this.models.get(role.modelId);
    if (model === undefined) return null;
    const hostType =
      role.executionHostId === null ? undefined : this.hosts.get(role.executionHostId)?.type;
    const executionTarget = isModelExecutionTarget(hostType)
      ? hostType
      : isModelExecutionTarget(model.configuration.executionTarget)
        ? model.configuration.executionTarget
        : null;
    if (executionTarget === null) return null;
    return { binding, model, role, executionTarget };
  }

  deactivateBusinessAgentBinding(
    businessId: string,
    accountId: string,
    agentId: string,
    updatedBy: string,
    now: Date = new Date()
  ): string | null {
    const binding = this.bindingForBusinessAgent(businessId, agentId, accountId);
    if (binding === null) return null;
    this.bindings.set(binding.id, {
      ...binding,
      status: "inactive",
      isDefault: false,
      updatedAt: now.toISOString(),
      updatedBy
    });
    return binding.id;
  }

  assignConversationBinding(input: {
    accountId: string;
    activeShopId: string | null;
    requestedBindingId?: string | null;
  }): string {
    if (input.requestedBindingId !== undefined && input.requestedBindingId !== null) {
      const requested = this.requireAssignableBinding(input.requestedBindingId, input);
      return requested.id;
    }
    if (input.activeShopId !== null) {
      const tenantBinding = [...this.bindings.values()]
        .filter(
          (binding) =>
            binding.businessId === input.activeShopId &&
            binding.accountId === input.accountId &&
            binding.status === "active"
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      if (tenantBinding !== undefined) return tenantBinding.id;
    }
    return this.requireGlobalDefault().id;
  }

  /**
   * The sole effective-runtime resolver. Both conversation chat and direct runtime-session chat
   * enter here and use the same deterministic precedence:
   *
   *   explicit conversation binding -> active shop/account binding -> platform default.
   *
   * A conversation pointing at the global default is an inherited default, not an explicit
   * override, so a later account selection still wins without rewriting every conversation.
   */
  resolveRuntimeBinding(
    input: NativeRuntimeResolutionInput,
    conversations: ReadonlyMap<string, ConversationSummary>
  ): ResolvedNativeRuntimeBinding {
    const conversation =
      input.conversationId === undefined ? undefined : conversations.get(input.conversationId);
    if (input.conversationId !== undefined && conversation === undefined) {
      throw new Cp2Error(404, "RUNTIME_CONVERSATION_NOT_FOUND", "Conversation was not found.");
    }
    if (
      conversation !== undefined &&
      conversation.activeShopId !== null &&
      conversation.activeShopId !== input.businessId
    ) {
      throw new Cp2Error(
        403,
        "RUNTIME_BINDING_FORBIDDEN",
        "The conversation cannot use this shop runtime."
      );
    }
    if (
      conversation !== undefined &&
      input.accountId !== undefined &&
      conversation.accountId !== input.accountId
    ) {
      throw new Cp2Error(
        403,
        "RUNTIME_BINDING_FORBIDDEN",
        "The conversation cannot use this account runtime."
      );
    }

    const candidates: Array<{
      binding: NativeRuntimeBindingSummary;
      source: NativeRuntimeResolutionSource;
    }> = [];
    const conversationBindingId = conversation?.runtimeBindingId ?? null;
    if (conversationBindingId !== null && conversationBindingId !== globalDefaultRuntimeBindingId) {
      const explicit = this.bindings.get(conversationBindingId);
      const effectiveAccountId = input.accountId ?? conversation?.accountId;
      if (
        explicit !== undefined &&
        (explicit.businessId === null || explicit.businessId === input.businessId) &&
        (explicit.accountId === null || explicit.accountId === effectiveAccountId)
      ) {
        candidates.push({ binding: explicit, source: "explicit-conversation" });
      }
    }
    const accountId = input.accountId ?? conversation?.accountId;
    const accountBinding = this.bindingForBusinessAgent(input.businessId, input.agentId, accountId);
    if (
      accountBinding !== null &&
      !candidates.some((candidate) => candidate.binding.id === accountBinding.id)
    ) {
      candidates.push({
        binding: accountBinding,
        source:
          accountBinding.isDefault ||
          accountBinding.configuration.source === "zero-setup-provisioning"
            ? "default"
            : "explicit-account"
      });
    }
    let lastResolutionError: Cp2Error | null = null;
    for (const candidate of candidates) {
      try {
        return this.resolveBinding(
          candidate.binding,
          input.conversationId ?? "runtime-unbound",
          candidate.source
        );
      } catch (error) {
        if (!(error instanceof Cp2Error)) throw error;
        lastResolutionError = error;
      }
    }
    try {
      const globalDefault = this.requireGlobalDefault();
      if (!candidates.some((candidate) => candidate.binding.id === globalDefault.id)) {
        return this.resolveBinding(
          globalDefault,
          input.conversationId ?? "runtime-unbound",
          "default"
        );
      }
    } catch (error) {
      if (!(error instanceof Cp2Error)) throw error;
      if (lastResolutionError === null) lastResolutionError = error;
    }
    throw (
      lastResolutionError ??
      new Cp2Error(503, "RUNTIME_DEFAULT_MISSING", "No effective runtime is configured.")
    );
  }

  resolveBindingForConversation(
    bindingId: string,
    conversationId = "runtime-unbound"
  ): ResolvedNativeRuntimeBinding {
    const binding = this.bindings.get(bindingId);
    if (binding === undefined) {
      throw new Cp2Error(409, "RUNTIME_BINDING_NOT_FOUND", "Runtime binding was not found.");
    }
    return this.resolveBinding(binding, conversationId, "explicit-conversation");
  }

  // The binding/agent-only half of structural validity: does the binding exist and belong to an
  // active agent with a compatible contract version. Deliberately says nothing about whether a
  // model is assigned - a conversation must be attachable to a binding (requireAssignableBinding
  // below) whether or not one has been chosen yet, exactly like the implicit global-default path
  // (requireGlobalDefault). See docs/architecture/provider-neutral-runtime.md §5.
  private requireActiveAgent(binding: NativeRuntimeBindingSummary): NativeRuntimeAgentSummary {
    if (binding.status !== "active" && binding.status !== "draft") {
      throw new Cp2Error(409, "RUNTIME_BINDING_INACTIVE", "Runtime binding is not active.");
    }
    const agent = this.agents.get(binding.agentId);
    if (agent === undefined || agent.status !== "active") {
      throw new Cp2Error(409, "RUNTIME_AGENT_UNAVAILABLE", "Runtime binding agent is unavailable.");
    }
    if (agent.runtimeContractVersion !== binding.runtimeContractVersion) {
      throw incompatibleContract(binding.id, agent.id, null);
    }
    return agent;
  }

  // Full structural validity for turn-time resolution: the binding/agent check above, plus
  // whether a model is actually assigned. Deliberately does not resolve installation/host
  // availability - that unreachable-model case is a turn-time concern checked separately by
  // resolveBinding below (RUNTIME_MODELS_UNAVAILABLE); this only reports whether a model was ever
  // chosen at all (RUNTIME_MODEL_NOT_CONFIGURED).
  private validateBindingStructure(binding: NativeRuntimeBindingSummary): {
    agent: NativeRuntimeAgentSummary;
    primaryRole: NativeRuntimeBindingModelSummary;
    enabledRoles: NativeRuntimeBindingModelSummary[];
  } {
    const agent = this.requireActiveAgent(binding);
    const enabledRoles = [...this.bindingModels.values()].filter(
      (role) => role.runtimeBindingId === binding.id && role.enabled
    );
    const primaryRoles = enabledRoles.filter((role) => role.role === "primary");
    if (primaryRoles.length === 0) {
      if (binding.status === "draft") {
        throw new Cp2Error(
          503,
          "RUNTIME_MODEL_NOT_CONFIGURED",
          "No model is assigned to this runtime. Choose or install a model before sending an AI message."
        );
      }
      throw new Cp2Error(
        409,
        "RUNTIME_PRIMARY_INVALID",
        "An active runtime binding must have exactly one enabled primary model."
      );
    }
    if (primaryRoles.length > 1) {
      throw new Cp2Error(
        409,
        "RUNTIME_PRIMARY_INVALID",
        "An active runtime binding must have exactly one enabled primary model."
      );
    }
    return {
      agent,
      primaryRole: primaryRoles[0] as NativeRuntimeBindingModelSummary,
      enabledRoles
    };
  }

  private resolveBinding(
    binding: NativeRuntimeBindingSummary,
    conversationId: string,
    source: NativeRuntimeResolutionSource
  ): ResolvedNativeRuntimeBinding {
    const { agent, primaryRole, enabledRoles } = this.validateBindingStructure(binding);
    const primary = this.resolveRole(binding, agent, primaryRole);
    const fallbacks = enabledRoles
      .filter((role) => role.role === "fallback")
      .sort(compareRoles)
      .map((role) => this.resolveRole(binding, agent, role));
    const auxiliaryEntries = enabledRoles
      .filter((role) => role.role !== "primary" && role.role !== "fallback")
      .sort(compareRoles)
      .map((role) => [role.role, this.resolveRole(binding, agent, role)] as const);
    const auxiliaries: Record<string, ResolvedNativeRuntimeModel[]> = {};
    for (const [role, resolved] of auxiliaryEntries) {
      (auxiliaries[role] ??= []).push(resolved);
    }
    const selected = [primary, ...fallbacks].find((candidate) => candidate.available);
    if (selected === undefined) {
      throw new Cp2Error(
        503,
        "RUNTIME_MODELS_UNAVAILABLE",
        "No available primary or fallback model exists for this runtime binding.",
        true,
        {
          bindingId: binding.id,
          candidates: JSON.stringify(
            [primary, ...fallbacks].map((candidate) => ({
              modelId: candidate.model.id,
              reason: candidate.unavailabilityReason
            }))
          )
        }
      );
    }
    return {
      conversationId,
      usedGlobalDefault: source === "default",
      source,
      binding: { ...binding },
      agent: { ...agent },
      primary,
      fallbacks,
      auxiliaries,
      selected,
      fallbackUsed: selected.bindingModel.role === "fallback",
      fallbackReason:
        selected.bindingModel.role === "fallback"
          ? (primary.unavailabilityReason ?? "PRIMARY_UNAVAILABLE")
          : null,
      configuration: { ...binding.configuration }
    };
  }

  private resolveRole(
    binding: NativeRuntimeBindingSummary,
    agent: NativeRuntimeAgentSummary,
    role: NativeRuntimeBindingModelSummary
  ): ResolvedNativeRuntimeModel {
    const model = this.models.get(role.modelId);
    if (model === undefined) {
      throw new Cp2Error(409, "RUNTIME_MODEL_NOT_FOUND", "A bound runtime model was not found.");
    }
    this.validateCompatibility(agent, model);
    if (model.status !== "active") return unavailable(role, model, "MODEL_INACTIVE");
    const installations = [...this.installations.values()]
      .filter(
        (installation) =>
          installation.modelId === model.id &&
          (role.executionHostId === null || installation.executionHostId === role.executionHostId)
      )
      .sort((left, right) => left.executionHostId.localeCompare(right.executionHostId));
    if (installations.length === 0) return unavailable(role, model, "INSTALLATION_MISSING");
    for (const installation of installations) {
      const host = this.hosts.get(installation.executionHostId);
      if (!availabilityStatusUsable(installation.status)) continue;
      if (host === undefined || !availabilityStatusUsable(host.status)) continue;
      if (!hostAuthorizedForBinding(host, binding)) continue;
      return {
        bindingModel: { ...role },
        model: { ...model },
        installation: { ...installation },
        host: { ...host },
        available: true,
        unavailabilityReason: null
      };
    }
    const installation = installations[0] as NativeModelInstallationSummary;
    const host = this.hosts.get(installation.executionHostId) ?? null;
    return {
      bindingModel: { ...role },
      model: { ...model },
      installation: { ...installation },
      host: host === null ? null : { ...host },
      available: false,
      unavailabilityReason: !availabilityStatusUsable(installation.status)
        ? "INSTALLATION_UNAVAILABLE"
        : host === null
          ? "EXECUTION_HOST_MISSING"
          : !hostAuthorizedForBinding(host, binding)
            ? "EXECUTION_HOST_FORBIDDEN"
            : "EXECUTION_HOST_UNAVAILABLE"
    };
  }

  private validateCompatibility(
    agent: NativeRuntimeAgentSummary,
    model: NativeRuntimeModelSummary
  ): void {
    if (model.runtimeContractVersion !== agent.runtimeContractVersion) {
      throw incompatibleContract("unknown", agent.id, model.id);
    }
    this.validateCapabilityMatch(agent, model);
  }

  // Capability compatibility is checked purely against agent.configuration.requiredModelCapabilities
  // vs model.capabilities - never against provider/vendor name, per docs/architecture/
  // provider-neutral-runtime.md §13: any model from any provider that declares the right
  // capabilities (chat, tool-routing, reasoning, vision, coding, ...) is usable.
  private validateCapabilityMatch(
    agent: NativeRuntimeAgentSummary,
    model: NativeRuntimeModelSummary
  ): void {
    const required = Array.isArray(agent.configuration.requiredModelCapabilities)
      ? agent.configuration.requiredModelCapabilities.filter(
          (capability): capability is string => typeof capability === "string"
        )
      : [];
    const missing = required.filter((capability) => !model.capabilities.includes(capability));
    if (missing.length > 0) {
      throw new Cp2Error(
        409,
        "RUNTIME_MODEL_CAPABILITY_MISMATCH",
        "The selected model does not satisfy the agent's required capabilities.",
        false,
        { agentId: agent.id, modelId: model.id, missingCapabilities: missing.join(",") }
      );
    }
  }

  private requireAssignableBinding(
    bindingId: string,
    input: { accountId: string; activeShopId: string | null }
  ): NativeRuntimeBindingSummary {
    const binding = this.bindings.get(bindingId);
    // draft is accepted here for the same reason requireGlobalDefault accepts it: explicitly
    // requesting the (currently unconfigured) global default binding must succeed exactly like
    // falling back to it implicitly does - conversation creation must not depend on a model
    // already being assigned. See docs/architecture/provider-neutral-runtime.md §4.
    if (binding === undefined || (binding.status !== "active" && binding.status !== "draft")) {
      throw new Cp2Error(400, "RUNTIME_BINDING_INVALID", "Requested runtime binding is invalid.");
    }
    if (binding.accountId !== null && binding.accountId !== input.accountId) {
      throw new Cp2Error(
        403,
        "RUNTIME_BINDING_FORBIDDEN",
        "Runtime binding belongs to another account."
      );
    }
    if (binding.businessId !== null && binding.businessId !== input.activeShopId) {
      throw new Cp2Error(
        403,
        "RUNTIME_BINDING_FORBIDDEN",
        "Runtime binding belongs to another shop."
      );
    }
    this.requireActiveAgent(binding);
    return binding;
  }

  // Structural lookup only - draft (unconfigured) counts as a valid default just as much as
  // active, since assigning a conversation to the default slot (assignConversationBinding) must
  // succeed whether or not a model has been chosen yet. Whether that slot can actually run
  // inference is a separate, later question answered by validateBindingStructure/resolveBinding.
  private requireGlobalDefault(): NativeRuntimeBindingSummary {
    const defaults = [...this.bindings.values()].filter(
      (binding) =>
        binding.isDefault &&
        binding.businessId === null &&
        binding.accountId === null &&
        (binding.status === "active" || binding.status === "draft")
    );
    if (defaults.length !== 1) {
      throw new Cp2Error(
        503,
        "RUNTIME_DEFAULT_MISSING",
        "No unique global runtime binding is configured."
      );
    }
    return defaults[0] as NativeRuntimeBindingSummary;
  }

  private upsertAgent(agent: NativeRuntimeAgentSummary): NativeRuntimeAgentSummary {
    const existing = this.agents.get(agent.id);
    const next = { ...agent, createdAt: existing?.createdAt ?? agent.createdAt };
    this.agents.set(next.id, next);
    return next;
  }

  private upsertCatalogModel(
    model: AiModelSummary,
    executionTarget: ModelExecutionTarget,
    timestamp: string
  ): NativeRuntimeModelSummary {
    const existing = this.models.get(model.id);
    const providerMapping = resolveRuntimeModel(model.id);
    const next: NativeRuntimeModelSummary = {
      id: model.id,
      name: model.label,
      provider: providerMapping?.provider ?? model.provider,
      providerModelId: providerMapping?.providerModelId ?? model.id,
      runtimeContractVersion: nativeRuntimeContractVersion,
      capabilities: [...model.capabilities],
      configuration: {
        executionTarget,
        source: model.source,
        format: model.format,
        contextWindow: model.contextWindow
      },
      status: model.available ? "active" : "inactive",
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
    this.models.set(next.id, next);
    return next;
  }

  private upsertVerifiedHost(input: {
    accountId: string | null;
    businessId: string | null;
    executionTarget: ModelExecutionTarget;
    checkedAt: string;
  }): NativeExecutionHostSummary {
    const id = stableUuid(
      `native-runtime-host:${input.accountId ?? "global"}:${input.businessId ?? "global"}:${input.executionTarget}`
    );
    const existing = this.hosts.get(id);
    const host: NativeExecutionHostSummary = {
      id,
      businessId: input.businessId,
      accountId: input.accountId,
      type: input.executionTarget,
      name: hostName(input.executionTarget),
      endpoint: null,
      status: "healthy",
      capabilities: [input.executionTarget],
      configuration: { executionTarget: input.executionTarget },
      credentialReference: null,
      lastKnownHealthyAt: input.checkedAt,
      createdAt: existing?.createdAt ?? input.checkedAt,
      updatedAt: input.checkedAt
    };
    this.hosts.set(host.id, host);
    return host;
  }

  private upsertInstallation(modelId: string, hostId: string, timestamp: string): void {
    const id = stableUuid(`native-runtime-installation:${modelId}:${hostId}`);
    const existing = this.installations.get(id);
    this.installations.set(id, {
      id,
      modelId,
      executionHostId: hostId,
      status: "available",
      configuration: {},
      lastKnownHealthyAt: timestamp,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp
    });
  }

  /**
   * Validates a candidate (agent, model, host) triple can actually execute together, reusing the
   * same compatibility rules turn-time resolution enforces (contract version match, capability
   * match, installation/host availability) - see docs/architecture/native-runtime-bindings.md
   * "Availability and compatibility". The Runtime Handoff Protocol's swap Prepare phase (protocol
   * doc section 10/11.1) calls this instead of re-implementing agent/model/host compatibility
   * checks.
   */
  validateCandidateExecutionChain(input: {
    agentId: string;
    modelId: string;
    executionHostId: string;
  }): {
    agent: NativeRuntimeAgentSummary;
    model: NativeRuntimeModelSummary;
    host: NativeExecutionHostSummary;
    installation: NativeModelInstallationSummary;
  } {
    const agent = this.agents.get(input.agentId);
    if (agent === undefined || agent.status !== "active") {
      throw new Cp2Error(409, "RUNTIME_AGENT_UNAVAILABLE", "Candidate agent is unavailable.");
    }
    const model = this.models.get(input.modelId);
    if (model === undefined || model.status !== "active") {
      throw new Cp2Error(409, "RUNTIME_MODEL_UNAVAILABLE", "Candidate model is unavailable.");
    }
    this.validateCompatibility(agent, model);
    const host = this.hosts.get(input.executionHostId);
    if (host === undefined || !availabilityStatusUsable(host.status)) {
      throw new Cp2Error(
        409,
        "RUNTIME_EXECUTION_HOST_UNAVAILABLE",
        "Candidate execution host is unavailable."
      );
    }
    const installation = [...this.installations.values()].find(
      (candidate) => candidate.modelId === model.id && candidate.executionHostId === host.id
    );
    if (installation === undefined || !availabilityStatusUsable(installation.status)) {
      throw new Cp2Error(
        409,
        "RUNTIME_INSTALLATION_UNAVAILABLE",
        "Candidate model is not installed on this execution host."
      );
    }
    return { agent, model, host, installation };
  }

  bindingScope(bindingId: string) {
    const binding = this.bindings.get(bindingId);
    return binding ? { accountId: binding.accountId, businessId: binding.businessId } : null;
  }

  /** Host ownership is independent of model/agent compatibility. Never infer it from an ID. */
  handoffHost(input: { executionHostId: string; accountId: string; businessId: string | null }) {
    const host = this.hosts.get(input.executionHostId);
    if (!host)
      throw new Cp2Error(409, "NO_EXECUTION_HOST", "The execution host is not registered.");
    if (
      (host.accountId !== null && host.accountId !== input.accountId) ||
      (host.businessId !== null && host.businessId !== input.businessId) ||
      (isLocalRuntimeHost(host.type) && host.accountId !== input.accountId)
    ) {
      throw new Cp2Error(
        403,
        "RUNTIME_HOST_FORBIDDEN",
        "This execution host belongs to another account or business."
      );
    }
    return host;
  }

  handoffHosts(input: { accountId: string; businessId: string | null }) {
    return [...this.hosts.values()].filter((host) => {
      try {
        this.handoffHost({ ...input, executionHostId: host.id });
        return true;
      } catch {
        return false;
      }
    });
  }

  /** An authenticated device may refresh only an already provisioned host assigned to it.
   * This does not install a model, create a host, or grant executor capabilities. */
  heartbeatHandoffHost(input: {
    executionHostId: string;
    accountId: string;
    businessId: string | null;
    deviceId: string;
    connected: boolean;
    now: Date;
  }) {
    const host = this.handoffHost(input);
    if (
      !isLocalRuntimeHost(host.type) ||
      host.configuration.deviceId !== input.deviceId ||
      ["disabled", "incompatible"].includes(host.status) ||
      !host.capabilities.includes("runtime-handoff-v1")
    ) {
      throw new Cp2Error(
        409,
        "LOCAL_RUNTIME_UNSUPPORTED",
        "This device has no provisioned portable runtime bridge."
      );
    }
    const timestamp = input.now.toISOString();
    this.hosts.set(host.id, {
      ...host,
      status: input.connected ? "available" : "unavailable",
      lastKnownHealthyAt: input.connected ? timestamp : host.lastKnownHealthyAt,
      updatedAt: timestamp,
      configuration: {
        ...host.configuration,
        handoffLeaseExpiresAt: new Date(
          input.now.getTime() + (input.connected ? 45_000 : 0)
        ).toISOString()
      }
    });
  }

  /**
   * Existence-only check for an (agent, model, host) triple - no status/availability/capability
   * checks, unlike `validateCandidateExecutionChain` above. Used by the Runtime Handoff Protocol's
   * offline checkpoint sync (protocol doc "Offline causal ancestry"): an offline-created checkpoint
   * was valid when the client created it, and Postgres foreign keys require the referenced rows to
   * still exist at sync time, but a model that is merely temporarily unavailable by sync time
   * should not block syncing a historical record of it.
   */
  runtimeRefExists(input: { agentId: string; modelId: string; executionHostId: string }): boolean {
    return (
      this.agents.has(input.agentId) &&
      this.models.has(input.modelId) &&
      this.hosts.has(input.executionHostId)
    );
  }

  /**
   * Creates (or, for an identical triple, deterministically reuses) a runtime binding scoped to
   * one account/business pair with a single enabled primary role, and never mutates an existing
   * binding in place. Bindings can be shared/reused across many conversations (protocol doc
   * section 9), so a per-task runtime swap must not risk silently changing another task that
   * happens to reference the same binding - the deterministic id (hashed from the exact
   * account/business/agent/model/host tuple) makes repeated identical swaps idempotent without a
   * separate lookup-then-create step, the same technique `roleRecord`/`stableUuid` already use
   * for value-like binding roles elsewhere in this file.
   */
  materializeConversationBinding(input: {
    accountId: string;
    businessId: string | null;
    agentId: string;
    modelId: string;
    executionHostId: string;
    updatedBy: string;
    now: Date;
  }): NativeRuntimeBindingSummary {
    const { agent } = this.validateCandidateExecutionChain(input);
    if (
      (agent.accountId !== null && agent.accountId !== input.accountId) ||
      (agent.businessId !== null && agent.businessId !== input.businessId)
    )
      throw new Cp2Error(
        403,
        "RUNTIME_AGENT_FORBIDDEN",
        "The selected agent belongs to another account or business."
      );
    this.handoffHost(input);
    const timestamp = input.now.toISOString();
    const bindingId = stableUuid(
      `runtime-handoff-binding:${input.accountId}:${input.businessId ?? "none"}:${input.agentId}:${input.modelId}:${input.executionHostId}`
    );
    const existingBinding = this.bindings.get(bindingId);
    const binding: NativeRuntimeBindingSummary = {
      id: bindingId,
      businessId: input.businessId,
      accountId: input.accountId,
      agentId: input.agentId,
      name: `${agent.name} + ${input.modelId}`,
      status: "active",
      isDefault: false,
      configuration: { source: "runtime-handoff-swap" },
      runtimeContractVersion: agent.runtimeContractVersion,
      createdAt: existingBinding?.createdAt ?? timestamp,
      updatedAt: timestamp,
      updatedBy: input.updatedBy
    };
    this.bindings.set(binding.id, binding);
    const role = roleRecord(
      binding.id,
      input.modelId,
      "primary",
      0,
      input.executionHostId,
      timestamp
    );
    const existingRole = this.bindingModels.get(role.id);
    this.bindingModels.set(role.id, { ...role, createdAt: existingRole?.createdAt ?? timestamp });
    return binding;
  }

  clear(): void {
    this.agents.clear();
    this.models.clear();
    this.hosts.clear();
    this.installations.clear();
    this.bindings.clear();
    this.bindingModels.clear();
  }

  restore(snapshot: NativeRuntimeSnapshot): void {
    this.clear();
    for (const record of snapshot.nativeRuntimeAgents ?? []) this.agents.set(record.id, record);
    for (const record of snapshot.nativeRuntimeModels ?? []) this.models.set(record.id, record);
    for (const record of snapshot.nativeExecutionHosts ?? []) this.hosts.set(record.id, record);
    for (const record of snapshot.nativeModelInstallations ?? []) {
      this.installations.set(record.id, record);
    }
    for (const record of snapshot.nativeRuntimeBindings ?? []) this.bindings.set(record.id, record);
    for (const record of snapshot.nativeRuntimeBindingModels ?? []) {
      this.bindingModels.set(record.id, record);
    }
    this.ensureGlobalDefault();
  }

  get agentsMap(): Map<string, NativeRuntimeAgentSummary> {
    return this.agents;
  }
  get modelsMap(): Map<string, NativeRuntimeModelSummary> {
    return this.models;
  }
  get hostsMap(): Map<string, NativeExecutionHostSummary> {
    return this.hosts;
  }
  get installationsMap(): Map<string, NativeModelInstallationSummary> {
    return this.installations;
  }
  get bindingsMap(): Map<string, NativeRuntimeBindingSummary> {
    return this.bindings;
  }
  get bindingModelsMap(): Map<string, NativeRuntimeBindingModelSummary> {
    return this.bindingModels;
  }
}

function roleRecord(
  bindingId: string,
  modelId: string,
  role: string,
  priority: number,
  hostId: string,
  timestamp: string
): NativeRuntimeBindingModelSummary {
  return {
    id: stableUuid(`native-runtime-role:${bindingId}:${role}:${priority}:${modelId}`),
    runtimeBindingId: bindingId,
    modelId,
    role,
    priority,
    executionHostId: hostId,
    configuration: {},
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function dedupeProvisioningCandidates(
  candidates: NativeDefaultRuntimeProvisioningInput["candidates"]
): NativeDefaultRuntimeProvisioningInput["candidates"] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.model.id}:${candidate.executionTarget}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unavailable(
  role: NativeRuntimeBindingModelSummary,
  model: NativeRuntimeModelSummary,
  reason: string
): ResolvedNativeRuntimeModel {
  return {
    bindingModel: { ...role },
    model: { ...model },
    installation: null,
    host: null,
    available: false,
    unavailabilityReason: reason
  };
}

function hostAuthorizedForBinding(
  host: NativeExecutionHostSummary,
  binding: NativeRuntimeBindingSummary
): boolean {
  const accountAllowed = host.accountId === null || host.accountId === binding.accountId;
  const businessAllowed = host.businessId === null || host.businessId === binding.businessId;
  return accountAllowed && businessAllowed;
}

function availabilityStatusUsable(status: NativeRuntimeAvailabilityStatus): boolean {
  return status === "available" || status === "healthy" || status === "online";
}

function validateActiveTopology(
  binding: NativeRuntimeBindingSummary,
  roles: NativeRuntimeBindingModelSummary[]
): void {
  if (binding.status !== "active") return;
  if (roles.filter((role) => role.enabled && role.role === "primary").length !== 1) {
    throw new Cp2Error(
      409,
      "RUNTIME_PRIMARY_INVALID",
      "An active runtime binding must have exactly one enabled primary model."
    );
  }
  const fallbackPriorities = roles
    .filter((role) => role.enabled && role.role === "fallback")
    .map((role) => role.priority);
  if (new Set(fallbackPriorities).size !== fallbackPriorities.length) {
    throw new Cp2Error(
      409,
      "RUNTIME_FALLBACK_PRIORITY_CONFLICT",
      "Fallback priorities must be unique within a runtime binding."
    );
  }
}

function compareRoles(
  left: NativeRuntimeBindingModelSummary,
  right: NativeRuntimeBindingModelSummary
): number {
  return left.priority - right.priority || left.id.localeCompare(right.id);
}

function stableUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16] ?? "0", 16) % 4] as string;
  const compact = hex.join("");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function hostName(target: ModelExecutionTarget): string {
  if (target === "remote-shop-device") return "Remote shop device runtime";
  return "Grogoni backend inference runtime";
}

function incompatibleContract(
  bindingId: string,
  agentId: string,
  modelId: string | null
): Cp2Error {
  return new Cp2Error(
    409,
    "RUNTIME_CONTRACT_INCOMPATIBLE",
    "The agent and model runtime contracts are incompatible.",
    false,
    { bindingId, agentId, modelId }
  );
}

/** Descriptive provenance for a native agent record, by engine. Execution never reads these. */
function agentProviderFor(adapterId: string): string {
  if (adapterId === "pi") return "pi";
  if (adapterId === "zeroclaw") return "zeroclaw";
  return "grogoni-business-agent";
}

function agentPackageRefFor(adapterId: string): string | null {
  if (adapterId === "pi") return "npm:@earendil-works/pi-agent-core@0.84.4";
  if (adapterId === "zeroclaw") return "github:zeroclaw-labs/zeroclaw";
  return null;
}
