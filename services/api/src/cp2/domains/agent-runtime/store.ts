import { withRuntimeDeadline } from "../../runtime-deadline.js";
/**
 * Ninth slice of in-process domain modularization for the Cp2Store monolith (see
 * docs/architecture/domain-modularization-roadmap.md). The largest slice by method count and by
 * total line volume: owns `activeAiModels`, `agentProfiles`, `agentRuntimeVersions`,
 * `agentContextSources`, `agentEvaluationEvents`, `agentOwnerCorrections`,
 * `installedAgentModels` (+ the ephemeral `agentModelActivationLocks` mutex Set),
 * `runtimeSessions`, `runtimeTurns`, and `pendingRuntimeActions` (never persisted - no
 * `Cp2Snapshot` field) - plus the entire `createRuntimeTurn` pipeline (context retrieval, tool
 * proposal, confirmation, execution, model routing, recall persistence) and every
 * AI-model-catalog/activation/assignment method.
 *
 * **There is no `agentModelBindings` map here.** "Which model is this agent using" has exactly
 * one answer, read/written entirely through `deps.getActiveNativeRuntimeBinding`/
 * `deps.activateVerifiedRuntimeBinding` into `NativeRuntimeBindingStore`
 * (`../native-runtime/store.ts`) - the sole runtime-binding source of truth. The legacy table this
 * domain used to own directly, and the even-older `agentModelAssignments`/
 * `browserInferenceAssignments` tables before it, are gone (see migrations 075 and 076 under
 * infra/db/migrations/); `native-binding-projection.ts` builds the `AgentModelBindingSummary`
 * wire shape `AgentModelPanel.tsx`/`QuickRuntimeSwitcher.tsx` read as a read-through projection of
 * the native graph, not a second persisted representation.
 *
 * **`mcpAccessTokens`/`mcpTokenIdByHash` deliberately stayed on `Cp2Store`, not here** - despite
 * being declared next to this domain's Maps. Zero code coupling either direction was found
 * (confirmed by exhaustive read), they have their own dedicated route module
 * (`services/api/src/mcp/routes.ts`, entirely separate from `cp2/routes.ts`'s agent-runtime
 * routes), and `scripts/purge-all-users.sql` classifies them in a different delete-batch from
 * every agent-runtime table. A generic external-API-credential concern, not an agent-runtime one.
 *
 * **`attemptPublicAgentReply` and `publicAgentReplyRateLimited` also stayed on `Cp2Store`**
 * (already established when the messaging domain was extracted) - `attemptPublicAgentReply`
 * depends on seven agent-runtime primitives (`createCustomerCatalogueRuntimeTurn`,
 * `computeAgentRuntimeReadiness`, `currentAgentProfile`, `resolveActiveRuntimeModelId`,
 * `buildShopAgentRuntime`, `resolveRuntimeModelProvider`, `contextSourcesForRuntime` - one more
 * than originally documented when messaging was extracted; `createCustomerCatalogueRuntimeTurn`
 * was missed until this domain's own dependency-mapping research caught it). Rather than
 * reshaping `MessagingDomain`'s deps to inject all seven individually,
 * `createCustomerCatalogueRuntimeTurn` and `agentModelRecoveryGuidance` became deliberately
 * public accessors here (mirroring `ComplianceDomain`'s public `getOrCreate*` pattern), and
 * `Cp2Store`'s own `attemptPublicAgentReply`/messaging-constructor-wiring now call
 * `this.agentRuntimeDomain.X(...)` directly instead of `this.X(...)`.
 *
 * **Known pre-existing gap, preserved as-is (zero-behavior-change refactor, not a bugfix
 * opportunity):** `deleteShopOwnedData` (business-scoped deletion, stays on `Cp2Store`) only
 * sweeps `runtimeSessions`/`runtimeTurns`/`pendingRuntimeActions` -
 * `activeAiModels`/`agentProfiles`/`agentRuntimeVersions`/`agentContextSources`/
 * `agentEvaluationEvents`/`agentOwnerCorrections`/`installedAgentModels`/the native runtime
 * binding graph are never touched by shop-level deletion, only by the account-level purge
 * (`deleteAccountOwnedData`, which sweeps all of them completely - see that method's own comment
 * for exactly which native-runtime maps it sweeps and why `modelsMap` is deliberately excluded).
 * This was true before this extraction; flagging it here rather than silently fixing it as a
 * side effect, since shop-deletion semantics for business-scoped agent config deserve a
 * deliberate product decision, not an incidental one made while moving code.
 *
 * Coupling with the not-yet-extracted core auth/identity kernel and other domains, resolved as
 * constructor-injected callbacks/raw Map references (same pattern used throughout this refactor):
 * `businesses`/`sessions`/`products`/`customers`/`invoices` as read-only raw Map references (this
 * domain's own tiny `productsForBusiness`/`customersForBusiness`/`invoicesForBusiness` filters,
 * duplicated inline rather than injected as callbacks since they're one-line filters, same
 * choice `MessagingDomain` made for its own core-kernel Map reads); `buildRuntimeContext`
 * (cross-cutting report builder, stays on `Cp2Store`), `imageForProduct` (`publicProductImage`,
 * shared with the non-agent `queryCatalogue` path), `importsForBusiness`/`requireDocumentImport`
 * (`DocumentImportDomain` public accessors), `suppliersForBusiness`/`purchaseReceipts`
 * (`SupplierDomain` public accessors), and the `executeRuntimeAction` tool-dispatch table's
 * callbacks into `Cp2Store`'s own commerce/customer/product/messaging/document-import public
 * methods (`queryCatalogue`, `listProducts`, `listInvoices`, `createProduct`, `deleteProduct`,
 * `createCustomer`, `listPurchaseReceipts`, `confirmProductImport`, `confirmSupplierImport`,
 * `sendChannelMessage`).
 */
import { randomUUID } from "node:crypto";
import type {
  ActiveAiModelSummary,
  ActiveNativeAgentBinding,
  AgentAudience,
  AgentContextSource,
  AgentEvaluationEvent,
  AgentEvaluationEventType,
  AgentEvaluationSummary,
  AgentModelActivationResult,
  AgentModelBindingPermissions,
  AgentModelBindingRemovalResult,
  AgentModelBindingSummary,
  AgentOwnerCorrection,
  AgentRuntimeReadiness,
  ContextRecipe,
  EffectiveRuntimeSummary,
  AgentRuntimeVersion,
  AiModelSummary,
  InstalledAgentModelSummary,
  ModelExecutionTarget,
  ModelRuntimeHealthSummary,
  NativeRuntimeAgentSummary,
  PreferredExecutionMode,
  RuntimeContextSummary,
  RuntimeParserIntent,
  RuntimeModelConversationMessage,
  RuntimeModelProvider,
  RuntimeModelTemplateRecipe,
  RuntimeModelTrace,
  RuntimePlannedAction,
  RuntimeSessionSummary,
  RuntimeTelemetryEvent,
  RuntimeExecutionEventType,
  RuntimeExperience,
  RuntimeReportCard,
  RuntimeToolName,
  RuntimeTurnResult,
  RuntimeTurnSummary,
  ShopAgentRuntime
} from "@grogoni/shared-types";
import {
  defaultAgentDefinitionId,
  isModelExecutionTarget,
  modelExecutionTargets,
  isPlatformIncludedModel
} from "@grogoni/shared-types";
import {
  createRuntimeToolProposal,
  createRuntimeToolProposalFromProductContextScript,
  parseMerchantCommand,
  parseProductContextScriptCommand,
  parseReceiptContextScriptCommand,
  parseRuntimeHashtagInvocation,
  productContextScriptMatchToParseResult,
  receiptContextScriptMatchToParseResult,
  runtimeToolRegistry
} from "@grogoni/tool-core";
import { queryCatalogueProducts, roleCan, type BusinessPermission } from "@grogoni/business-core";
import { Cp2Error } from "../../cp2-error.js";
import {
  asModelRuntimeError,
  type ModelRuntimeAdapter,
  type ModelRuntimeAvailability
} from "../../../inference/model-runtime.js";
import { runtimeAdapterIdForAgent } from "../../../agent-harness/agent-runtime-adapter.js";
import { normalizeRequiredBoundedText } from "../../text-normalization.js";
import {
  agentAudienceForBusinessRole,
  contextRecipeRegistry,
  enforceAgentPolicy,
  evaluateGrounding,
  groundingAbstentionMessage,
  resolveAgentContext,
  type retrieveAgentContext
} from "../../agent-business-runtime.js";
import type { CustomerRuntimeCapabilityRecord } from "../../domain-contracts.js";
import type { Cp2Snapshot } from "../../store.js";
import type { AgentRuntimeDomainDeps } from "./domain-deps.js";
export type { AgentRuntimeDomainDeps } from "./domain-deps.js";
import {
  buildShopAgentRuntime as buildShopAgentRuntimeModule,
  contextSourcesForRuntime as contextSourcesForRuntimeModule
} from "./runtime-context.js";
import { createRuntimeModelRoute } from "./runtime-model-routing.js";
import { buildRuntimeReportCard } from "./report-card.js";
import {
  purgeExpiredRuntimeExperiences as purgeExpiredRuntimeExperiencesModule,
  recordFallbackExperience as recordFallbackExperienceModule,
  validatedRuntimeExperiencesForBusiness as validatedRuntimeExperiencesForBusinessModule
} from "./experience.js";
import {
  assertResolvedRuntimeAvailable,
  resolveNativeRuntimeModelProvider,
  type ExecutionTargetResolutionSource
} from "./native-runtime-routing.js";
import { projectActiveNativeBinding, projectNativeBinding } from "./native-binding-projection.js";
import {
  executeRuntimeCapability,
  findRuntimeUnknownEntityReferenceError
} from "./capabilities.js";
import {
  createRuntimeDocumentImportProposal,
  createRuntimeCommerceProposal,
  createRuntimeMessagingProposal,
  createRuntimeNetworkProposal,
  createRuntimeReceiptProposal
} from "./planning.js";
import {
  cloneAgentContextSource,
  cloneAgentInstructions,
  cloneAgentPersonality,
  cloneAgentRuntimeVersion,
  cloneAgentSkillBinding,
  cloneBusinessAgentProfile,
  cloneInstalledAgentModel,
  contextCharacterBudgetForModel,
  contextKeywords,
  contextSourceRecord,
  createDefaultBusinessAgentProfile,
  createRuntimePlan,
  createRuntimeResponse,
  createRuntimeVerification,
  defaultAiModelId,
  downloadableAiModelIdPattern,
  ensureRequiredAgentContextScripts,
  healthSummary,
  hydrateBusinessAgentProfile,
  isUnavailableRuntimeCode,
  maxRuntimeTurnsPerSession,
  modelHealthError,
  normalizeBusinessAgentProfile,
  normalizeInstalledAgentModel,
  normalizeModelCatalogSearch,
  resolveDefaultDeviceModelId,
  runtimeAgentProfileFromStored,
  runtimeEvaluationSampled,
  runtimeExecutionFailureResponse,
  runtimeStatusFromPlan,
  validateAgentModelBindingConfiguration,
  type BusinessAgentProfileInput,
  type BusinessAgentProfileSummary,
  type PendingRuntimeAction
} from "./shared.js";
/**
 * Maps this domain's existing, already-instrumented `RuntimeTelemetryEvent` lifecycle states onto
 * the durable execution event log's taxonomy (docs/architecture/durable-execution-plane.md). This
 * piggybacks on every `appendTelemetry(...)` call site rather than adding a second, parallel set of
 * instrumentation calls - the two closures below (`executeRuntimeTurn`'s and
 * `confirmRuntimeAction`'s) already fire at exactly the lifecycle points this taxonomy needs.
 * `null` means "no durable event for this telemetry point" (a few `RuntimeTelemetryState` values -
 * `model.fallback`/`recall.*` - are provider/memory-internal detail the spec's taxonomy has no
 * corresponding class for; logging them as, say, EXECUTION_STARTED again would be noise, not
 * signal).
 */
function runtimeExecutionEventTypeForTelemetry(
  state: RuntimeTelemetryEvent["state"],
  status: RuntimeTelemetryEvent["status"]
): RuntimeExecutionEventType | null {
  switch (state) {
    case "turn.received":
      return "EXECUTION_STARTED";
    case "turn.rate_limited":
    case "turn.blocked":
      return "EXECUTION_FAILED";
    case "context.built":
      return "CONTEXT_RESOLVED";
    case "agent.started":
      return "BINDING_RESOLUTION_STARTED";
    case "agent.completed":
      return "BINDING_RESOLVED";
    case "model.inference_started":
      return "MODEL_INVOCATION_STARTED";
    case "model.completed":
      return status === "completed" ? "MODEL_INVOCATION_COMPLETED" : "MODEL_INVOCATION_FAILED";
    case "intent.routed":
      return "CAPABILITIES_RESOLVED";
    case "plan.created":
      return "TOOL_REQUESTED";
    case "verification.completed":
      return status === "blocked" || status === "clarification_required"
        ? "AUTHORIZATION_DENIED"
        : "AUTHORIZATION_COMPLETED";
    case "confirmation.required":
      return "EXECUTION_SUSPENDED";
    case "tool.executed":
      return status === "completed"
        ? "TOOL_COMPLETED"
        : status === "blocked"
          ? "TOOL_DENIED"
          : "TOOL_FAILED";
    case "response.generated":
      return status === "completed"
        ? "EXECUTION_COMPLETED"
        : status === "needs_confirmation" || status === "clarifying"
          ? "EXECUTION_SUSPENDED"
          : "EXECUTION_FAILED";
    default:
      return null;
  }
}

export class AgentRuntimeDomain {
  private readonly activeAiModels = new Map<string, ActiveAiModelSummary>();
  private readonly agentProfiles = new Map<string, BusinessAgentProfileSummary>();
  private readonly agentRuntimeVersions = new Map<string, AgentRuntimeVersion>();
  private readonly agentContextSources = new Map<string, AgentContextSource>();
  private readonly agentEvaluationEvents = new Map<string, AgentEvaluationEvent>();
  private readonly agentOwnerCorrections = new Map<string, AgentOwnerCorrection>();
  private readonly runtimeExperiences = new Map<string, RuntimeExperience>();
  private readonly installedAgentModels = new Map<string, InstalledAgentModelSummary>();
  private readonly agentModelActivationLocks = new Set<string>();
  private readonly runtimeSessions = new Map<string, RuntimeSessionSummary>();
  private readonly runtimeTurns = new Map<string, RuntimeTurnSummary>();
  private readonly pendingRuntimeActions = new Map<string, PendingRuntimeAction>();

  constructor(private readonly deps: AgentRuntimeDomainDeps) {}

  get activeAiModelsMap(): Map<string, ActiveAiModelSummary> {
    return this.activeAiModels;
  }

  get agentProfilesMap(): Map<string, BusinessAgentProfileSummary> {
    return this.agentProfiles;
  }

  get agentRuntimeVersionsMap(): Map<string, AgentRuntimeVersion> {
    return this.agentRuntimeVersions;
  }

  get agentContextSourcesMap(): Map<string, AgentContextSource> {
    return this.agentContextSources;
  }

  get agentEvaluationEventsMap(): Map<string, AgentEvaluationEvent> {
    return this.agentEvaluationEvents;
  }

  get agentOwnerCorrectionsMap(): Map<string, AgentOwnerCorrection> {
    return this.agentOwnerCorrections;
  }

  get runtimeExperiencesMap(): Map<string, RuntimeExperience> {
    return this.runtimeExperiences;
  }

  get installedAgentModelsMap(): Map<string, InstalledAgentModelSummary> {
    return this.installedAgentModels;
  }

  get runtimeSessionsMap(): Map<string, RuntimeSessionSummary> {
    return this.runtimeSessions;
  }

  get runtimeTurnsMap(): Map<string, RuntimeTurnSummary> {
    return this.runtimeTurns;
  }

  get pendingRuntimeActionsMap(): Map<string, PendingRuntimeAction> {
    return this.pendingRuntimeActions;
  }

  clear(): void {
    this.activeAiModels.clear();
    this.agentProfiles.clear();
    this.agentRuntimeVersions.clear();
    this.agentContextSources.clear();
    this.agentEvaluationEvents.clear();
    this.agentOwnerCorrections.clear();
    this.runtimeExperiences.clear();
    this.installedAgentModels.clear();
    this.agentModelActivationLocks.clear();
    this.runtimeSessions.clear();
    this.runtimeTurns.clear();
    this.pendingRuntimeActions.clear();
  }

  restore(snapshot: Cp2Snapshot): void {
    for (const selection of snapshot.activeAiModels ?? []) {
      this.activeAiModels.set(selection.businessId, selection);
    }

    for (const profile of snapshot.agentProfiles ?? []) {
      this.agentProfiles.set(
        profile.businessId,
        cloneBusinessAgentProfile(hydrateBusinessAgentProfile(profile))
      );
    }

    for (const version of snapshot.agentRuntimeVersions ?? []) {
      this.agentRuntimeVersions.set(version.id, cloneAgentRuntimeVersion(version));
    }

    for (const source of snapshot.agentContextSources ?? []) {
      this.agentContextSources.set(source.id, cloneAgentContextSource(source));
    }

    for (const event of snapshot.agentEvaluationEvents ?? []) {
      this.agentEvaluationEvents.set(event.id, {
        ...event,
        metadata: { ...event.metadata }
      });
    }

    for (const correction of snapshot.agentOwnerCorrections ?? []) {
      this.agentOwnerCorrections.set(correction.id, { ...correction });
    }

    for (const experience of snapshot.runtimeExperiences ?? []) {
      this.runtimeExperiences.set(experience.id, {
        ...experience,
        evidenceRefs: [...experience.evidenceRefs],
        toolSequence: [...experience.toolSequence]
      });
    }

    for (const model of snapshot.installedAgentModels ?? []) {
      this.installedAgentModels.set(model.id, cloneInstalledAgentModel(model));
    }

    for (const item of snapshot.runtimeSessions) {
      this.runtimeSessions.set(item.id, item);
    }

    for (const item of snapshot.runtimeTurns) {
      const legacy = item as RuntimeTurnSummary & Partial<{ runtimeVersion: number }>;
      this.runtimeTurns.set(item.id, {
        ...item,
        runtimeVersion:
          legacy.runtimeVersion ?? this.agentProfiles.get(item.businessId)?.runtimeVersion ?? 1
      });
    }
  }

  listAiModels(search?: string): AiModelSummary[] {
    const normalizedSearch = search?.trim().toLowerCase();
    const compactSearch =
      normalizedSearch === undefined ? undefined : normalizeModelCatalogSearch(normalizedSearch);
    return this.deps
      .listModelCatalog()
      .filter((model) => {
        if (!normalizedSearch) return true;
        const exactMatch =
          model.label.toLowerCase().includes(normalizedSearch) ||
          model.description.toLowerCase().includes(normalizedSearch) ||
          model.capabilities.some((capability) =>
            capability.toLowerCase().includes(normalizedSearch)
          ) ||
          model.id.toLowerCase().includes(normalizedSearch);
        return (
          exactMatch ||
          (compactSearch !== undefined &&
            normalizeModelCatalogSearch(
              `${model.id} ${model.label} ${model.description} ${model.capabilities.join(" ")}`
            ).includes(compactSearch))
        );
      })
      .map((model) => {
        const hostedExecutionTarget = this.hostedExecutionTargetFor(model);
        return {
          ...model,
          capabilities: [...model.capabilities],
          costResponsibility: isPlatformIncludedModel(model) ? "platform-included" : "merchant",
          // The "backend" key is the frontend's stable field name for "is a server-hosted adapter
          // configured for this model" (apps/web/src/AgentModelPanel.tsx, QuickRuntimeSwitcher.tsx)
          // - it does not mean the "backend" ModelExecutionTarget literal specifically.
          // hostedExecutionTarget says which target that adapter actually serves.
          runtimeAvailability: {
            backend: hostedExecutionTarget === undefined ? "unconfigured" : "configured"
          },
          ...(hostedExecutionTarget === undefined ? {} : { hostedExecutionTarget })
        };
      });
  }

  /**
   * The live platform default target first ("local" Ollama today), then the router's targets
   * ("backend" for older rows, which nothing serves now; "browser-local"/"installed-app"). Never guesses: a target is
   * returned only when an adapter is actually registered for it.
   */
  private hostedExecutionTargetFor(model: AiModelSummary): ModelExecutionTarget | undefined {
    const candidates = [
      this.deps.platformDefaultRuntime.executionTarget,
      ...(model.inference === undefined
        ? []
        : (["backend", "browser-local", "installed-app"] as const))
    ];
    return candidates.find(
      (executionTarget) =>
        this.deps.modelRuntimeAdapterResolver?.({
          modelId: model.id,
          executionTarget,
          agentId: "model-catalog",
          shopId: "model-catalog"
        }) !== undefined
    );
  }

  getActiveAiModel(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): ActiveAiModelSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "business:read",
      now
    );
    const stored = this.activeAiModels.get(input.businessId);
    const preferredModelId = stored?.modelId ?? "grogoniclaw-local";
    const modelId = resolveDefaultDeviceModelId(
      preferredModelId,
      this.deps.resolveCatalogModel(preferredModelId)
    );
    return {
      businessId: input.businessId,
      modelId,
      activatedAt: stored?.activatedAt ?? now.toISOString(),
      activatedBy: stored?.activatedBy ?? session.user.id
    };
  }

  activateAiModel(input: {
    sessionId: string | null;
    businessId: string;
    modelId: string;
    now?: Date;
  }): ActiveAiModelSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "membership:manage",
      now
    );
    const model = this.deps.resolveCatalogModel(input.modelId);
    if (model === undefined || model.source !== "hosted" || !model.available) {
      throw new Cp2Error(
        400,
        "cloud_model_unavailable",
        "The selected backend fallback model is unavailable."
      );
    }
    const selection: ActiveAiModelSummary = {
      businessId: input.businessId,
      modelId: model?.id ?? input.modelId,
      activatedAt: now.toISOString(),
      activatedBy: session.user.id
    };
    this.activeAiModels.set(input.businessId, selection);
    this.deps.recordAuditEvent({
      type: "cloud_fallback_model.selected",
      aggregateType: "business",
      aggregateId: input.businessId,
      actorId: session.user.id,
      occurredAt: now.toISOString(),
      payload: { modelId: selection.modelId }
    });
    const profile = this.currentAgentProfile(input.businessId, now);
    const revised = {
      ...profile,
      modelId: selection.modelId,
      runtimeVersion: profile.runtimeVersion + 1,
      updatedAt: now.toISOString(),
      updatedBy: session.user.id
    };
    this.agentProfiles.set(input.businessId, revised);
    this.recordAgentRuntimeVersion(revised, session.user.id, "Cloud fallback model changed");
    return selection;
  }

  getActiveAgentModelBinding(input: {
    sessionId: string | null;
    businessId: string;
    agentId: string;
    now?: Date;
  }): AgentModelBindingSummary | null {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "business:read",
      now
    );
    this.requireBusinessAgent(input.businessId, input.agentId, now);
    const active = this.deps.getActiveNativeRuntimeBinding(
      input.businessId,
      input.agentId,
      session.account.id
    );
    return projectActiveNativeBinding(active, input.businessId, session.account.id);
  }

  removeAgentModelBinding(input: {
    sessionId: string | null;
    businessId: string;
    agentId: string;
    now?: Date;
  }): AgentModelBindingRemovalResult {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "membership:manage",
      now
    );
    const profile = this.requireBusinessAgent(input.businessId, input.agentId, now);
    if (this.agentModelActivationLocks.has(input.agentId)) {
      throw new Cp2Error(
        409,
        "MODEL_ACTIVATION_CONFLICT",
        "Another model activation is already running for this agent.",
        true,
        { agentId: input.agentId }
      );
    }

    const active = this.deps.getActiveNativeRuntimeBinding(
      input.businessId,
      input.agentId,
      session.account.id
    );
    if (active === null) {
      return {
        agentId: input.agentId,
        shopId: input.businessId,
        binding: null,
        removedBindingId: null
      };
    }

    const removedAt = now.toISOString();
    this.deps.deactivateRuntimeBinding({
      businessId: input.businessId,
      accountId: session.account.id,
      agentId: input.agentId,
      updatedBy: session.user.id,
      now
    });
    const inactive: AgentModelBindingSummary = {
      ...projectNativeBinding(active, input.businessId, session.account.id),
      status: "inactive",
      updatedAt: removedAt,
      updatedBy: session.user.id
    };

    const fallbackModelId = resolveDefaultDeviceModelId(
      this.activeAiModels.get(input.businessId)?.modelId ?? defaultAiModelId,
      this.deps.resolveCatalogModel(
        this.activeAiModels.get(input.businessId)?.modelId ?? defaultAiModelId
      )
    );
    const revised: BusinessAgentProfileSummary = {
      ...profile,
      modelId: fallbackModelId,
      runtimeVersion: profile.runtimeVersion + 1,
      updatedAt: removedAt,
      updatedBy: session.user.id
    };
    this.agentProfiles.set(input.businessId, revised);
    this.recordAgentRuntimeVersion(revised, session.user.id, "Agent model binding removed");
    this.recordAgentModelBindingAudit("agent_model.binding_removed", inactive, session.user.id, {});

    return {
      agentId: input.agentId,
      shopId: input.businessId,
      binding: null,
      removedBindingId: inactive.id
    };
  }

  async testAgentModel(input: {
    sessionId: string | null;
    businessId: string;
    agentId: string;
    modelId: string;
    executionTarget: ModelExecutionTarget;
    signal?: AbortSignal;
    now?: Date;
  }): Promise<ModelRuntimeHealthSummary> {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "membership:manage",
      now
    );
    this.requireBusinessAgent(input.businessId, input.agentId, now);
    this.requireCanonicalAiModel(input.modelId);
    const adapter = this.requireModelRuntimeAdapter(input);
    const health = await withRuntimeDeadline((signal) =>
      adapter.healthCheck({
        agentId: input.agentId,
        shopId: input.businessId,
        accountId: session.account.id,
        modelId: input.modelId,
        signal: input.signal ? AbortSignal.any([signal, input.signal]) : signal
      })
    );
    const summary = healthSummary(health, now);
    if (!summary.ok) {
      throw modelHealthError(summary);
    }
    return summary;
  }

  async activateAgentModel(input: {
    sessionId: string | null;
    businessId: string;
    agentId: string;
    modelId: string;
    executionTarget: ModelExecutionTarget;
    executionMode: PreferredExecutionMode;
    permissions: AgentModelBindingPermissions;
    costResponsibility?: "merchant";
    signal?: AbortSignal;
    onStage?: (stage: string, elapsedMs: number) => void;
    now?: Date;
  }): Promise<AgentModelActivationResult> {
    const now = input.now ?? new Date();
    const startedAt = Date.now();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "membership:manage",
      now
    );
    input.onStage?.("auth_resolved", Date.now() - startedAt);
    this.requireBusinessAgent(input.businessId, input.agentId, now);
    input.onStage?.("agent_resolved", Date.now() - startedAt);
    const model = this.requireCanonicalAiModel(input.modelId);
    if (!isPlatformIncludedModel(model) && input.costResponsibility !== "merchant") {
      throw new Cp2Error(
        402,
        "CUSTOM_MODEL_COST_ACCEPTANCE_REQUIRED",
        "Custom models are merchant-funded. Accept model usage and hosting costs before activation.",
        false,
        { modelId: model.id, costResponsibility: "merchant" }
      );
    }
    validateAgentModelBindingConfiguration(input, model);
    input.onStage?.("model_resolved", Date.now() - startedAt);
    const existingActive = this.deps.getActiveNativeRuntimeBinding(
      input.businessId,
      input.agentId,
      session.account.id
    );
    if (
      existingActive !== null &&
      existingActive.model.id === input.modelId &&
      existingActive.executionTarget === input.executionTarget
    ) {
      input.onStage?.("runtime_probe_started", Date.now() - startedAt);
      const health = healthSummary(
        await withRuntimeDeadline((signal) =>
          this.requireModelRuntimeAdapter(input).healthCheck({
            agentId: input.agentId,
            shopId: input.businessId,
            accountId: session.account.id,
            modelId: input.modelId,
            signal: input.signal ? AbortSignal.any([signal, input.signal]) : signal
          })
        ),
        now
      );
      input.onStage?.("runtime_probe_completed", Date.now() - startedAt);
      if (!health.ok) throw modelHealthError(health);
      const result = this.finalizeVerifiedActivation({
        businessId: input.businessId,
        agentId: input.agentId,
        accountId: session.account.id,
        actorId: session.user.id,
        model,
        executionTarget: input.executionTarget,
        checkedAt: health.checkedAt,
        auditType: "agent_model.activation_reverified",
        latencyMs: health.latencyMs,
        // Model and execution target are unchanged from what's already active - this is a health
        // re-verification, not a configuration change, so the agent profile's runtimeVersion must
        // not bump (matches the pre-consolidation fast path, which never touched agentProfiles).
        bumpProfile: false
      });
      input.onStage?.("binding_staged", Date.now() - startedAt);
      return { binding: result, healthCheck: health };
    }
    if (this.agentModelActivationLocks.has(input.agentId)) {
      throw new Cp2Error(
        409,
        "MODEL_ACTIVATION_CONFLICT",
        "Another model activation is already running for this agent.",
        true,
        { agentId: input.agentId }
      );
    }

    this.agentModelActivationLocks.add(input.agentId);
    try {
      const adapter = this.requireModelRuntimeAdapter(input);
      input.onStage?.("runtime_probe_started", Date.now() - startedAt);
      const health = healthSummary(
        await withRuntimeDeadline((signal) =>
          adapter.healthCheck({
            agentId: input.agentId,
            shopId: input.businessId,
            accountId: session.account.id,
            modelId: input.modelId,
            signal: input.signal ? AbortSignal.any([signal, input.signal]) : signal
          })
        ),
        now
      );
      input.onStage?.("runtime_probe_completed", Date.now() - startedAt);
      if (!health.ok) {
        this.recordAgentModelBindingAudit(
          "agent_model.activation_failed",
          failedActivationAuditFields(input, health.checkedAt, health.errorCode),
          session.user.id,
          { errorCode: health.errorCode, latencyMs: health.latencyMs }
        );
        throw modelHealthError(health);
      }

      const result = this.finalizeVerifiedActivation({
        businessId: input.businessId,
        agentId: input.agentId,
        accountId: session.account.id,
        actorId: session.user.id,
        model,
        executionTarget: input.executionTarget,
        checkedAt: health.checkedAt,
        auditType: "agent_model.activation_succeeded",
        latencyMs: health.latencyMs,
        bumpProfile: true
      });
      input.onStage?.("binding_staged", Date.now() - startedAt);
      return { binding: result, healthCheck: health };
    } catch (error) {
      if (error instanceof Cp2Error) {
        const failedAt = new Date().toISOString();
        this.recordAgentModelBindingAudit(
          "agent_model.activation_failed",
          failedActivationAuditFields(input, failedAt, error.code),
          session.user.id,
          { errorCode: error.code }
        );
        throw error;
      }
      const runtimeError = asModelRuntimeError(error);
      const failedAt = new Date().toISOString();
      this.recordAgentModelBindingAudit(
        "agent_model.activation_failed",
        failedActivationAuditFields(input, failedAt, runtimeError.code),
        session.user.id,
        { errorCode: runtimeError.code }
      );
      throw new Cp2Error(
        runtimeError.code === "INFERENCE_TIMEOUT" ? 504 : 503,
        runtimeError.code,
        runtimeError.message,
        runtimeError.retryable,
        {
          agentId: input.agentId,
          modelId: input.modelId,
          executionTarget: input.executionTarget
        }
      );
    } finally {
      this.agentModelActivationLocks.delete(input.agentId);
    }
  }

  /** Writes the (sole) native runtime binding and re-reads it back joined with its model/role so
   *  the HTTP response and audit trail are built from exactly what was persisted, not from the
   *  input that requested it. Shared by activateAgentModel's fast (re-verify) and full paths -
   *  both do nothing but a health check before reaching here. The engine (AgentRuntimeAdapter) is
   *  never an independent input here - it's always read off the business's current agent
   *  definition, so swapping engines happens by picking a different agent definition
   *  (updateAgentProfile's agentDefinitionId), not by passing an adapter id into activation. */
  private finalizeVerifiedActivation(input: {
    businessId: string;
    agentId: string;
    accountId: string;
    actorId: string;
    model: AiModelSummary;
    executionTarget: ModelExecutionTarget;
    checkedAt: string;
    auditType: string;
    latencyMs: number;
    bumpProfile: boolean;
  }): AgentModelBindingSummary {
    const profile = this.currentAgentProfile(input.businessId, new Date(input.checkedAt));
    const agentDefinition = this.deps.resolveAgentCatalogEntry(profile.agentDefinitionId);
    if (this.deps.agentRuntimeAdapterResolver(agentDefinition.runtimeAdapterId) === undefined) {
      throw new Cp2Error(
        404,
        "AGENT_RUNTIME_ADAPTER_NOT_FOUND",
        "This agent's runtime adapter is not registered."
      );
    }
    const nativeBinding = this.deps.activateVerifiedRuntimeBinding({
      businessId: input.businessId,
      accountId: input.accountId,
      agentId: profile.agentId,
      agentName: profile.name,
      agentRuntimeAdapterId: agentDefinition.runtimeAdapterId,
      model: input.model,
      executionTarget: input.executionTarget,
      fallbackModel: null,
      updatedBy: input.actorId,
      checkedAt: input.checkedAt
    });
    const refreshed = this.deps.getActiveNativeRuntimeBinding(
      input.businessId,
      input.agentId,
      input.accountId
    );
    if (refreshed === null) {
      throw new Cp2Error(
        500,
        "RUNTIME_BINDING_WRITE_FAILED",
        "Failed to persist the activated runtime binding."
      );
    }
    const verified = projectNativeBinding(refreshed, input.businessId, input.accountId);
    if (input.bumpProfile) {
      const revised = {
        ...profile,
        modelId: input.model.id,
        runtimeVersion: profile.runtimeVersion + 1,
        updatedAt: input.checkedAt,
        updatedBy: input.actorId
      };
      this.agentProfiles.set(input.businessId, revised);
      this.recordAgentRuntimeVersion(revised, input.actorId, "Verified agent model activated");
    }
    this.recordAgentModelBindingAudit(input.auditType, verified, input.actorId, {
      latencyMs: input.latencyMs,
      nativeRuntimeBindingId: nativeBinding.id,
      costResponsibility: isPlatformIncludedModel(input.model) ? "platform-included" : "merchant"
    });
    return verified;
  }

  listInstalledAgentModels(input: {
    sessionId: string | null;
    deviceId?: string;
    now?: Date;
  }): InstalledAgentModelSummary[] {
    const session = this.deps.requirePinVerifiedSession(input.sessionId, input.now ?? new Date());
    return [...this.installedAgentModels.values()]
      .filter(
        (model) =>
          model.accountId === session.account.id &&
          model.userId === session.user.id &&
          (input.deviceId === undefined || model.deviceId === input.deviceId) &&
          model.installationStatus !== "REMOVED"
      )
      .sort((left, right) => right.installedAt.localeCompare(left.installedAt))
      .map(cloneInstalledAgentModel);
  }

  registerInstalledAgentModel(input: {
    sessionId: string | null;
    model: Omit<InstalledAgentModelSummary, "accountId" | "userId">;
    now?: Date;
  }): InstalledAgentModelSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const model = normalizeInstalledAgentModel(input.model, session.account.id, session.user.id);
    const existing = this.installedAgentModels.get(model.id);
    if (
      existing !== undefined &&
      (existing.accountId !== session.account.id ||
        existing.userId !== session.user.id ||
        existing.deviceId !== model.deviceId)
    ) {
      throw new Cp2Error(
        403,
        "model_installation_owner_mismatch",
        "This model installation belongs to another account or device."
      );
    }
    this.installedAgentModels.set(model.id, model);
    this.deps.recordAuditEvent({
      type: "agent_model.installation_registered",
      aggregateType: "model_installation",
      aggregateId: model.id,
      actorId: session.user.id,
      occurredAt: now.toISOString(),
      payload: {
        modelId: model.modelId,
        deviceId: model.deviceId,
        installationStatus: model.installationStatus,
        compatibilityStatus: model.compatibilityStatus,
        runtimeBackend: model.runtimeBackend
      }
    });
    return cloneInstalledAgentModel(model);
  }

  validateInstalledAgentModel(input: {
    sessionId: string | null;
    installationId: string;
    deviceId: string;
    installationStatus: InstalledAgentModelSummary["installationStatus"];
    compatibilityStatus: InstalledAgentModelSummary["compatibilityStatus"];
    validationError: string | null;
    now?: Date;
  }): InstalledAgentModelSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requirePinVerifiedSession(input.sessionId, now);
    const existing = this.requireOwnedModelInstallation(
      session.account.id,
      session.user.id,
      input.deviceId,
      input.installationId
    );
    const updated: InstalledAgentModelSummary = {
      ...existing,
      installationStatus: input.installationStatus,
      compatibilityStatus: input.compatibilityStatus,
      validationError:
        input.validationError === null
          ? null
          : normalizeRequiredBoundedText(input.validationError, "validation error", 120),
      lastVerifiedAt: now.toISOString()
    };
    this.installedAgentModels.set(updated.id, updated);
    return cloneInstalledAgentModel(updated);
  }

  getAgentProfile(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): BusinessAgentProfileSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "business:read",
      now
    );
    const stored = this.agentProfiles.get(input.businessId);
    if (stored !== undefined) {
      return cloneBusinessAgentProfile({
        ...hydrateBusinessAgentProfile(stored),
        contextScripts: ensureRequiredAgentContextScripts(stored.contextScripts)
      });
    }

    const business = this.deps.requireBusiness(input.businessId);
    return createDefaultBusinessAgentProfile({
      business,
      modelId: this.activeAiModels.get(input.businessId)?.modelId ?? defaultAiModelId,
      updatedAt: now.toISOString(),
      updatedBy: session.user.id,
      agentDefinition: this.deps.resolveAgentCatalogEntry(defaultAgentDefinitionId)
    });
  }

  updateAgentProfile(input: {
    sessionId: string | null;
    businessId: string;
    profile: BusinessAgentProfileInput;
    now?: Date;
  }): BusinessAgentProfileSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "membership:manage",
      now
    );
    const profile = normalizeBusinessAgentProfile(input.profile);
    const business = this.deps.requireBusiness(input.businessId);
    const current = hydrateBusinessAgentProfile(
      this.agentProfiles.get(input.businessId) ??
        createDefaultBusinessAgentProfile({
          business,
          modelId: this.activeAiModels.get(input.businessId)?.modelId ?? defaultAiModelId,
          updatedAt: now.toISOString(),
          updatedBy: session.user.id,
          agentDefinition: this.deps.resolveAgentCatalogEntry(defaultAgentDefinitionId)
        })
    );
    const model = this.deps.resolveCatalogModel(profile.modelId);
    const deviceModel = downloadableAiModelIdPattern.test(profile.modelId);
    if ((!deviceModel && model === undefined) || model?.available === false) {
      throw new Cp2Error(400, "ai_model_unavailable", "The selected AI model is unavailable.");
    }
    const updated: BusinessAgentProfileSummary = {
      businessId: input.businessId,
      tenantId: input.businessId,
      shopId: input.businessId,
      agentId: current.agentId,
      runtimeVersion: current.runtimeVersion + 1,
      createdAt: current.createdAt,
      ...profile,
      contextScripts: ensureRequiredAgentContextScripts(profile.contextScripts),
      modelId: model?.id ?? profile.modelId,
      updatedAt: now.toISOString(),
      updatedBy: session.user.id
    };
    if (this.runtimeVersionsForBusiness(input.businessId).length === 0) {
      this.synchronizeProfileContextSources(current, new Date(current.updatedAt));
      this.recordAgentRuntimeVersion(current, session.user.id, "Initial business runtime");
    }
    this.agentProfiles.set(input.businessId, updated);
    this.synchronizeProfileContextSources(updated, now);
    this.recordAgentRuntimeVersion(updated, session.user.id, "Agent profile updated");
    this.deps.recordAuditEvent({
      type: "agent_profile.updated",
      aggregateType: "business",
      aggregateId: input.businessId,
      actorId: session.user.id,
      occurredAt: updated.updatedAt,
      payload: {
        agentDefinitionId: updated.agentDefinitionId,
        language: updated.language,
        modelId: updated.modelId,
        status: updated.status
      }
    });

    return cloneBusinessAgentProfile(updated);
  }

  getAgentRuntime(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): ShopAgentRuntime {
    const now = input.now ?? new Date();
    this.deps.requireAuthorizedSession(input.sessionId, input.businessId, "business:read", now);
    return this.buildShopAgentRuntime(
      this.currentAgentProfile(input.businessId, now),
      now,
      "owner"
    );
  }

  listAgentRuntimeVersions(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): AgentRuntimeVersion[] {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "business:read",
      input.now ?? new Date()
    );
    return this.runtimeVersionsForBusiness(input.businessId).map(cloneAgentRuntimeVersion);
  }

  rollbackAgentRuntimeVersion(input: {
    sessionId: string | null;
    businessId: string;
    version: number;
    now?: Date;
  }): ShopAgentRuntime {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "membership:manage",
      now
    );
    const target = this.runtimeVersionsForBusiness(input.businessId).find(
      (candidate) => candidate.version === input.version
    );
    if (target === undefined) {
      throw new Cp2Error(404, "agent_runtime_version_not_found", "Runtime version was not found.");
    }
    const current = this.currentAgentProfile(input.businessId, now);
    const runtime = target.runtime;
    const targetContextSourceIds = new Set(runtime.context.sources.map((source) => source.id));
    const restoredContextScripts = runtime.context.sources
      .filter((source) => source.type === "context_script" && source.status === "active")
      .map(
        (source) =>
          source.retrievalMetadata.content ??
          this.agentContextSources.get(source.id)?.retrievalMetadata.content ??
          ""
      )
      .filter((content) => content !== "");
    for (const source of this.agentContextSources.values()) {
      if (source.shopId !== input.businessId || source.type === "context_script") continue;
      const targetSource = runtime.context.sources.find((candidate) => candidate.id === source.id);
      if (targetSource === undefined || !targetContextSourceIds.has(source.id)) {
        source.status = "archived";
        source.deletedAt = now.toISOString();
      } else {
        source.status = targetSource.status;
        source.deletedAt = targetSource.status === "archived" ? now.toISOString() : null;
      }
      source.updatedAt = now.toISOString();
    }
    const restored: BusinessAgentProfileSummary = {
      ...current,
      name: runtime.identity.agentName,
      description: runtime.identity.shopDescription,
      modelId: runtime.model.modelId,
      role: runtime.identity.role,
      language: runtime.identity.supportedLanguages[0] ?? current.language,
      supportedLanguages: [...runtime.identity.supportedLanguages],
      businessCategory: runtime.identity.businessCategory,
      publicIntroduction: runtime.identity.publicIntroduction,
      personality: runtime.personality.additionalGuidance || current.personality,
      personalityConfig: cloneAgentPersonality(runtime.personality),
      instructions: runtime.instructions.generalOperatingRules.join("\n") || current.instructions,
      instructionPolicy: cloneAgentInstructions(runtime.instructions),
      skillBindings: runtime.skills.map(cloneAgentSkillBinding),
      memoryPolicy: { ...runtime.memory },
      evaluationPolicy: { ...runtime.evaluations },
      contextScripts: restoredContextScripts,
      status:
        runtime.status === "paused" || runtime.status === "archived" ? "draft" : runtime.status,
      runtimeVersion: current.runtimeVersion + 1,
      updatedAt: now.toISOString(),
      updatedBy: session.user.id
    };
    this.agentProfiles.set(input.businessId, restored);
    this.synchronizeProfileContextSources(restored, now);
    this.recordAgentRuntimeVersion(
      restored,
      session.user.id,
      `Rolled back to runtime version ${target.version}`
    );
    this.deps.recordAuditEvent({
      type: "agent_runtime.rolled_back",
      aggregateType: "business",
      aggregateId: input.businessId,
      actorId: session.user.id,
      occurredAt: now.toISOString(),
      payload: {
        fromVersion: current.runtimeVersion,
        targetVersion: target.version,
        activeVersion: restored.runtimeVersion
      }
    });
    return this.buildShopAgentRuntime(restored, now, "owner");
  }

  getAgentRuntimeReadiness(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): AgentRuntimeReadiness {
    const now = input.now ?? new Date();
    this.deps.requireAuthorizedSession(input.sessionId, input.businessId, "business:read", now);
    return this.computeAgentRuntimeReadiness(input.businessId, now);
  }

  /** Resolves and verifies the same native runtime graph used by chat. Settings must consume this
   * method rather than reconstructing readiness from catalog rows in React. */
  async getEffectiveRuntime(input: {
    sessionId: string | null;
    businessId: string;
    conversationId?: string;
    now?: Date;
  }): Promise<EffectiveRuntimeSummary> {
    const now = input.now ?? new Date();
    const auth = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "business:read",
      now
    );
    const profile = this.currentAgentProfile(input.businessId, now);
    const agentDefinition = this.deps.resolveAgentCatalogEntry(profile.agentDefinitionId);
    // An untouched business displays the repository's hosted-first zero-setup engine (Pi), matching
    // what ensureDefaultRuntimeForTurn actually provisions for it below - not Shopkeeper's own
    // declared engine, which would misreport what's really running until a chat turn or explicit
    // activation catches the native runtime record up to the agent definition's choice.
    const usesPlatformDefaultAgent = profile.agentDefinitionId === defaultAgentDefinitionId;
    const defaultDisplayAdapterId = usesPlatformDefaultAgent
      ? this.deps.platformDefaultRuntime.agentRuntimeAdapterId
      : agentDefinition.runtimeAdapterId;
    // Settings (the quick switcher and the readiness banner) reads this endpoint to show a shop's
    // runtime as ready the moment it exists, without requiring a chat message first - so this
    // still runs the same idempotent zero-setup repair the first chat turn would. That repair step
    // is now bounded by a single control-plane deadline (see ensureDefaultRuntimeForTurn) so a
    // degraded or unreachable inference host makes this endpoint report UNAVAILABLE quickly
    // instead of blocking the settings page for the full inference timeout budget.
    await this.ensureDefaultRuntimeForTurn({
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      businessId: input.businessId,
      accountId: auth.account.id,
      userId: auth.user.id,
      profile,
      now
    });
    const resolution = this.deps.resolveNativeRuntimeBinding({
      businessId: input.businessId,
      accountId: auth.account.id,
      agentId: profile.agentId,
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId })
    });
    if (resolution === null) {
      const defaultModel = this.deps.resolveCatalogModel(this.deps.platformDefaultRuntime.modelId);
      return {
        agent: {
          id: agentDefinition.id,
          name: agentDefinition.displayName,
          runtimeAdapterId: defaultDisplayAdapterId
        },
        model: {
          id: this.deps.platformDefaultRuntime.modelId,
          name: defaultModel?.label ?? this.deps.platformDefaultRuntime.modelId
        },
        execution: {
          type: this.deps.platformDefaultRuntime.executionTarget,
          hostId: null,
          ready: false
        },
        binding: null,
        source: "default",
        status: "UNAVAILABLE",
        ready: false
      };
    }

    const agentRuntimeAdapterId = runtimeAdapterIdForAgent(resolution.agent);
    const executionTargetCandidate = resolution.selected.host?.type;
    const executionTarget = isModelExecutionTarget(executionTargetCandidate)
      ? executionTargetCandidate
      : undefined;
    const adapter =
      executionTarget === undefined
        ? undefined
        : this.deps.modelRuntimeAdapterResolver?.({
            modelId: resolution.selected.model.id,
            executionTarget,
            agentId: resolution.agent.id,
            shopId: input.businessId
          });
    const runtimeAdapter = this.deps.agentRuntimeAdapterResolver(agentRuntimeAdapterId);
    let ready =
      resolution.selected.available && adapter !== undefined && runtimeAdapter !== undefined;
    if (ready && adapter !== undefined && runtimeAdapter !== undefined) {
      try {
        const [modelAvailability, runtimeAdapterAvailability] = await withRuntimeDeadline(
          (signal) =>
            Promise.all([
              adapter.canRun({
                modelId: resolution.selected.model.id,
                agentId: resolution.agent.id,
                shopId: input.businessId,
                signal
              }),
              runtimeAdapter.canRun({
                agent: resolution.agent,
                modelId: resolution.selected.model.id,
                conversationId: input.conversationId ?? "runtime-unbound",
                shopId: input.businessId
              })
            ])
        );
        ready = modelAvailability.available && runtimeAdapterAvailability.available;
      } catch {
        ready = false;
      }
    }
    return {
      agent: {
        id: agentDefinition.id,
        name: agentDefinition.displayName,
        // The actually-resolved native runtime agent's adapter, not the definition's own declared
        // one - they can briefly disagree for an untouched account until a turn or explicit
        // activation catches the native runtime record up to the agent definition's choice (see
        // defaultDisplayAdapterId above for the same reasoning in the no-binding-yet branch).
        runtimeAdapterId: agentRuntimeAdapterId
      },
      model: { id: resolution.selected.model.id, name: resolution.selected.model.name },
      execution: {
        type: executionTarget ?? this.deps.platformDefaultRuntime.executionTarget,
        hostId: resolution.selected.host?.id ?? null,
        ready
      },
      binding: { id: resolution.binding.id },
      source: resolution.source,
      status: ready ? "READY" : "UNAVAILABLE",
      ready
    };
  }

  /**
   * The readiness computation itself does not depend on who is asking — only on the business's
   * own agent configuration — so it is factored out from the authorization check above. Reused by
   * the public, memberless storefront-reply path, which has no session to authorize.
   */
  computeAgentRuntimeReadiness(businessId: string, now: Date): AgentRuntimeReadiness {
    const business = this.deps.businesses.get(businessId);
    const profile = this.agentProfiles.get(businessId);
    const effectiveProfile =
      business === undefined ? null : this.currentAgentProfile(businessId, now);
    const issues: AgentRuntimeReadiness["issues"] = [];
    if (business === undefined || effectiveProfile === null) {
      issues.push({
        code: "AGENT_NOT_FOUND",
        message: "The business agent was not found.",
        actionable: true
      });
    } else {
      if (effectiveProfile.tenantId !== businessId || effectiveProfile.shopId !== businessId) {
        issues.push({
          code: "TENANT_BINDING_INVALID",
          message: "The runtime tenant and shop binding is invalid.",
          actionable: true
        });
      }
      if (effectiveProfile.modelId.trim() === "") {
        issues.push({
          code: "MODEL_NOT_SELECTED",
          message: "Select a model for this agent.",
          actionable: true
        });
      } else if (
        !downloadableAiModelIdPattern.test(effectiveProfile.modelId) &&
        this.deps.resolveCatalogModel(effectiveProfile.modelId)?.available !== true &&
        effectiveProfile.modelId !== "grogoniclaw-local"
      ) {
        issues.push({
          code: "MODEL_UNAVAILABLE",
          message: "The selected model is unavailable.",
          actionable: true
        });
      }
      if (
        effectiveProfile.skillBindings.length === 0 ||
        effectiveProfile.skillBindings.some((binding) => !(binding.skillId in runtimeToolRegistry))
      ) {
        issues.push({
          code: "TOOL_REGISTRY_UNAVAILABLE",
          message: "The runtime tool registry does not match the active skill bindings.",
          actionable: true
        });
      }
      if (profile !== undefined && profile.status !== "active") {
        issues.push({
          code: "INVALID_RUNTIME_PROFILE",
          message: "Activate the agent profile before using chat.",
          actionable: true
        });
      }
    }
    return {
      tenantId: businessId,
      shopId: businessId,
      agentId: effectiveProfile?.agentId ?? businessId,
      runtimeVersion: effectiveProfile?.runtimeVersion ?? 0,
      ready: issues.length === 0,
      issues,
      checkedAt: now.toISOString()
    };
  }

  listAgentContextSources(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): AgentContextSource[] {
    const now = input.now ?? new Date();
    this.deps.requireAuthorizedSession(input.sessionId, input.businessId, "business:read", now);
    return this.contextSourcesForRuntime(this.currentAgentProfile(input.businessId, now)).map(
      cloneAgentContextSource
    );
  }

  upsertAgentContextSource(input: {
    sessionId: string | null;
    businessId: string;
    sourceId?: string;
    type: AgentContextSource["type"];
    title: string;
    content: string;
    sensitivity: AgentContextSource["sensitivity"];
    customerVisible: boolean;
    status: AgentContextSource["status"];
    now?: Date;
  }): AgentContextSource {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "membership:manage",
      now
    );
    const existing =
      input.sourceId === undefined ? undefined : this.agentContextSources.get(input.sourceId);
    if (
      existing !== undefined &&
      (existing.tenantId !== input.businessId || existing.shopId !== input.businessId)
    ) {
      throw new Cp2Error(403, "agent_context_tenant_mismatch", "Context source access was denied.");
    }
    const profile = this.currentAgentProfile(input.businessId, now);
    if (this.runtimeVersionsForBusiness(input.businessId).length === 0) {
      this.synchronizeProfileContextSources(profile, new Date(profile.updatedAt));
      this.recordAgentRuntimeVersion(profile, session.user.id, "Initial business runtime");
    }
    if (existing !== undefined) {
      this.agentContextSources.set(existing.id, {
        ...existing,
        status: "archived",
        updatedAt: now.toISOString(),
        deletedAt: now.toISOString()
      });
    }
    const source: AgentContextSource = {
      id: randomUUID(),
      tenantId: input.businessId,
      shopId: input.businessId,
      type: input.type,
      title: normalizeRequiredBoundedText(input.title, "context title", 160),
      status: input.status,
      sensitivity: input.sensitivity,
      accessRules: {
        audiences: input.customerVisible ? ["owner", "staff", "customer"] : ["owner", "staff"],
        requiredPermission: input.customerVisible ? null : "business:read",
        customerVisible: input.customerVisible
      },
      freshnessTimestamp: now.toISOString(),
      version: (existing?.version ?? 0) + 1,
      retrievalMetadata: {
        keywords: contextKeywords(`${input.title} ${input.content}`),
        sourceRecordId: null,
        content: normalizeRequiredBoundedText(input.content, "context content", 4000)
      },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      deletedAt: input.status === "archived" ? now.toISOString() : null
    };
    this.agentContextSources.set(source.id, source);
    const revised = {
      ...profile,
      runtimeVersion: profile.runtimeVersion + 1,
      updatedAt: now.toISOString(),
      updatedBy: session.user.id
    };
    this.agentProfiles.set(input.businessId, revised);
    this.recordAgentRuntimeVersion(
      revised,
      session.user.id,
      `Context source ${source.title} updated`
    );
    return cloneAgentContextSource(source);
  }

  listAgentOwnerCorrections(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): AgentOwnerCorrection[] {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "business:read",
      input.now ?? new Date()
    );
    return this.ownerCorrectionsForBusiness(input.businessId).map((correction) => ({
      ...correction
    }));
  }

  submitAgentOwnerCorrection(input: {
    sessionId: string | null;
    businessId: string;
    correction: string;
    category: AgentOwnerCorrection["category"];
    sourceMessageId?: string | null;
    promoteToInstruction: boolean;
    now?: Date;
  }): AgentOwnerCorrection {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "membership:manage",
      now
    );
    const current = this.currentAgentProfile(input.businessId, now);
    const correctionText = normalizeRequiredBoundedText(input.correction, "owner correction", 1000);
    if (this.runtimeVersionsForBusiness(input.businessId).length === 0) {
      this.synchronizeProfileContextSources(current, new Date(current.updatedAt));
      this.recordAgentRuntimeVersion(current, session.user.id, "Initial business runtime");
    }
    const revised: BusinessAgentProfileSummary = {
      ...current,
      ...(input.promoteToInstruction
        ? {
            instructions: [current.instructions, correctionText].filter(Boolean).join("\n"),
            instructionPolicy: {
              ...cloneAgentInstructions(current.instructionPolicy),
              generalOperatingRules: [
                ...current.instructionPolicy.generalOperatingRules,
                correctionText
              ]
            }
          }
        : {}),
      runtimeVersion: current.runtimeVersion + 1,
      updatedAt: now.toISOString(),
      updatedBy: session.user.id
    };
    this.agentProfiles.set(input.businessId, revised);
    this.recordAgentRuntimeVersion(
      revised,
      session.user.id,
      input.promoteToInstruction ? "Owner correction promoted" : "Owner correction memory added"
    );
    const runtimeVersion = revised.runtimeVersion;
    const correction: AgentOwnerCorrection = {
      id: randomUUID(),
      tenantId: input.businessId,
      shopId: input.businessId,
      agentId: current.agentId,
      runtimeVersion,
      correction: correctionText,
      category: input.category,
      status: "active",
      sourceMessageId: input.sourceMessageId ?? null,
      promotedToInstruction: input.promoteToInstruction,
      createdBy: session.user.id,
      createdAt: now.toISOString(),
      disabledAt: null
    };
    this.agentOwnerCorrections.set(correction.id, correction);
    this.recordAgentEvaluationEvent({
      businessId: input.businessId,
      runtimeVersion,
      modelId: current.modelId,
      eventType: "owner_correction",
      outcome: "success",
      score: 1,
      reason: input.promoteToInstruction
        ? "Owner correction promoted to a structured instruction."
        : "Owner correction saved as runtime memory.",
      metadata: { category: input.category, promoted: input.promoteToInstruction },
      sessionId: null,
      messageId: input.sourceMessageId ?? null,
      now
    });
    return { ...correction };
  }

  disableAgentOwnerCorrection(input: {
    sessionId: string | null;
    businessId: string;
    correctionId: string;
    now?: Date;
  }): AgentOwnerCorrection {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "membership:manage",
      now
    );
    const existing = this.agentOwnerCorrections.get(input.correctionId);
    if (existing === undefined || existing.shopId !== input.businessId) {
      throw new Cp2Error(404, "agent_correction_not_found", "Owner correction was not found.");
    }
    const updated = this.disableOwnerCorrectionRecord(existing, now);
    this.bumpAgentRuntimeVersionForCorrectionChange(
      input.businessId,
      session.user.id,
      now,
      "Owner correction memory disabled"
    );
    return { ...updated };
  }

  /**
   * Automatic counterpart to disableAgentOwnerCorrection, run by a background sweep rather than an
   * owner action. Disables (never hard-deletes, matching disableAgentOwnerCorrection's own
   * audit-preserving contract) every active correction older than its business's own configured
   * memoryPolicy.retentionDays. Closes the gap docs/agent-evaluation-feedback-loop.md names
   * explicitly: "automatic retention cleanup ... [is] not yet a background job."
   */
  purgeExpiredAgentOwnerCorrections(now = new Date()): number {
    const disabledCountByBusiness = new Map<string, number>();
    for (const correction of this.agentOwnerCorrections.values()) {
      if (correction.status !== "active") continue;
      const stored = this.agentProfiles.get(correction.shopId);
      // No stored profile to consult a retention policy from (e.g. the business's runtime was
      // never otherwise touched, or has since been removed) - skip rather than fabricate one, a
      // background sweep should never have the side effect of creating a fresh default profile.
      if (stored === undefined) continue;
      const retentionMs =
        hydrateBusinessAgentProfile(stored).memoryPolicy.retentionDays * 24 * 60 * 60 * 1000;
      const ageMs = now.getTime() - Date.parse(correction.createdAt);
      if (ageMs <= retentionMs) continue;
      this.disableOwnerCorrectionRecord(correction, now);
      disabledCountByBusiness.set(
        correction.shopId,
        (disabledCountByBusiness.get(correction.shopId) ?? 0) + 1
      );
    }
    let totalDisabled = 0;
    for (const [businessId, count] of disabledCountByBusiness) {
      totalDisabled += count;
      this.bumpAgentRuntimeVersionForCorrectionChange(
        businessId,
        "system",
        now,
        `Retention sweep disabled ${count} expired owner correction${count === 1 ? "" : "s"}.`
      );
    }
    return totalDisabled;
  }

  private disableOwnerCorrectionRecord(
    correction: AgentOwnerCorrection,
    now: Date
  ): AgentOwnerCorrection {
    const updated = { ...correction, status: "disabled" as const, disabledAt: now.toISOString() };
    this.agentOwnerCorrections.set(updated.id, updated);
    return updated;
  }

  /** See experience.ts for the extraction logic itself - split out for store.ts's line budget. */
  private recordFallbackExperience(input: {
    businessId: string;
    agentId: string;
    turnId: string;
    intent: RuntimeParserIntent;
    recipe: ContextRecipe | undefined;
    evidenceRefs: string[];
    toolName: RuntimeToolName;
    fallbackReason: string;
    now: Date;
    appendTelemetry: (
      state: RuntimeTelemetryEvent["state"],
      status: RuntimeTelemetryEvent["status"],
      toolName: RuntimeToolName | null,
      risk: RuntimePlannedAction["risk"] | null,
      metadata?: RuntimeTelemetryEvent["metadata"]
    ) => void;
  }): void {
    recordFallbackExperienceModule(this.runtimeExperiences, input);
  }

  /** Recall-eligible experiences for a business: validated only, per the brief's "prevent one bad
   *  execution from poisoning memory" requirement - a "candidate" is never surfaced into a prompt. */
  validatedRuntimeExperiencesForBusiness(businessId: string): RuntimeExperience[] {
    return validatedRuntimeExperiencesForBusinessModule(this.runtimeExperiences, businessId);
  }

  /**
   * Automatic counterpart to an explicit disable (not yet exposed as an owner action - this pass
   * scopes the lifecycle to automatic promotion/retention only, per the audit's bounded-scope
   * decision). Deprecates (never hard-deletes) every experience older than its business's
   * configured memoryPolicy.retentionDays.
   */
  purgeExpiredRuntimeExperiences(now = new Date()): number {
    return purgeExpiredRuntimeExperiencesModule(this.runtimeExperiences, this.agentProfiles, now);
  }

  private bumpAgentRuntimeVersionForCorrectionChange(
    businessId: string,
    actorId: string,
    now: Date,
    reason: string
  ): void {
    const profile = this.currentAgentProfile(businessId, now);
    const revised = {
      ...profile,
      runtimeVersion: profile.runtimeVersion + 1,
      updatedAt: now.toISOString(),
      updatedBy: actorId
    };
    this.agentProfiles.set(businessId, revised);
    this.recordAgentRuntimeVersion(revised, actorId, reason);
  }

  submitAgentFeedback(input: {
    sessionId: string | null;
    businessId: string;
    messageId?: string | null;
    correct: boolean;
    reason?: string | null;
    now?: Date;
  }): AgentEvaluationEvent {
    const now = input.now ?? new Date();
    this.deps.requireAuthorizedSession(input.sessionId, input.businessId, "business:read", now);
    const profile = this.currentAgentProfile(input.businessId, now);
    return this.recordAgentEvaluationEvent({
      businessId: input.businessId,
      runtimeVersion: profile.runtimeVersion,
      modelId: profile.modelId,
      eventType: "owner_feedback",
      outcome: input.correct ? "success" : "failure",
      score: input.correct ? 1 : 0,
      reason:
        input.reason === undefined || input.reason === null
          ? null
          : normalizeRequiredBoundedText(input.reason, "feedback reason", 500),
      metadata: { correct: input.correct },
      sessionId: null,
      messageId: input.messageId ?? null,
      now
    });
  }

  getAgentEvaluationSummary(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): AgentEvaluationSummary {
    const now = input.now ?? new Date();
    this.deps.requireAuthorizedSession(input.sessionId, input.businessId, "business:read", now);
    const profile = this.currentAgentProfile(input.businessId, now);
    const events = this.evaluationEventsForBusiness(input.businessId);
    const scores = events
      .map((event) => event.score)
      .filter((score): score is number => score !== null);
    const clarifyingEvents = events.filter((event) => event.metadata.status === "clarifying");
    const clarifyingTurnCounts = clarifyingEvents
      .map((event) => event.metadata.turnCount)
      .filter((value): value is number => typeof value === "number");
    return {
      tenantId: input.businessId,
      shopId: input.businessId,
      runtimeVersion: profile.runtimeVersion,
      total: events.length,
      success: events.filter((event) => event.outcome === "success").length,
      partial: events.filter((event) => event.outcome === "partial").length,
      failure: events.filter((event) => event.outcome === "failure").length,
      blocked: events.filter((event) => event.outcome === "blocked").length,
      averageScore:
        scores.length === 0 ? null : scores.reduce((sum, score) => sum + score, 0) / scores.length,
      clarifying: clarifyingEvents.length,
      averageSessionTurnCountAtClarify:
        clarifyingTurnCounts.length === 0
          ? null
          : clarifyingTurnCounts.reduce((sum, turnCount) => sum + turnCount, 0) /
            clarifyingTurnCounts.length,
      recentEvents: events.slice(0, 20).map((event) => ({ ...event }))
    };
  }

  agentModelRecoveryGuidance(businessId: string, error: Cp2Error): string {
    const profile = this.agentProfiles.get(businessId);
    const binding =
      profile === undefined
        ? null
        : this.deps.getActiveNativeRuntimeBinding(businessId, profile.agentId);
    if (binding === null) {
      return [
        "I can’t use a working model for this chat yet, but your message is saved.",
        "To continue:",
        "1. Open Agent settings → Model.",
        "2. Test an available model, then activate it for this agent.",
        "3. Return here and send your message again."
      ].join("\n");
    }

    const modelName = this.deps.resolveCatalogModel(binding.model.id)?.label ?? binding.model.id;
    return [
      `I couldn’t reach ${modelName}, but your message is saved.`,
      "To continue:",
      "1. Retry in a moment, or open Agent settings → Model and run the model test.",
      "2. If it keeps failing, activate a different available model for this agent.",
      "3. Return here and send your message again.",
      `Reference: ${error.code}.`
    ].join("\n");
  }

  createRuntimeSession(input: {
    sessionId: string | null;
    businessId: string;
    idempotencyKey?: string;
    now?: Date;
  }): RuntimeSessionSummary {
    const now = input.now ?? new Date();
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "business:read",
      now
    );
    const idempotencyKey = input.idempotencyKey?.trim();
    if (
      idempotencyKey !== undefined &&
      (idempotencyKey.length < 8 || idempotencyKey.length > 120)
    ) {
      throw new Cp2Error(
        400,
        "runtime_session_idempotency_key_invalid",
        "Runtime session idempotency key must be between 8 and 120 characters."
      );
    }
    if (idempotencyKey !== undefined) {
      const existing = [...this.runtimeSessions.values()].find(
        (candidate) =>
          candidate.businessId === input.businessId &&
          candidate.userId === session.user.id &&
          candidate.idempotencyKey === idempotencyKey
      );
      if (existing !== undefined) return existing;
    }
    const runtimeSession: RuntimeSessionSummary = {
      id: randomUUID(),
      businessId: input.businessId,
      userId: session.user.id,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      status: "active",
      turnCount: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };

    this.runtimeSessions.set(runtimeSession.id, runtimeSession);
    this.deps.recordAuditEvent({
      type: "runtime.session_created",
      aggregateType: "runtime_session",
      aggregateId: runtimeSession.id,
      actorId: session.user.id,
      occurredAt: now.toISOString(),
      payload: {
        businessId: input.businessId
      }
    });

    return runtimeSession;
  }

  listRuntimeSessions(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): RuntimeSessionSummary[] {
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "business:read",
      input.now
    );

    return [...this.runtimeSessions.values()]
      .filter(
        (runtimeSession) =>
          runtimeSession.businessId === input.businessId &&
          runtimeSession.userId === session.user.id
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  listRuntimeTurns(input: {
    sessionId: string | null;
    businessId: string;
    runtimeSessionId: string;
    now?: Date;
  }): RuntimeTurnSummary[] {
    const session = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "business:read",
      input.now
    );
    const runtimeSession = this.requireRuntimeSession(input.businessId, input.runtimeSessionId);

    if (runtimeSession.userId !== session.user.id) {
      throw new Cp2Error(403, "runtime_actor_mismatch", "Runtime session belongs to another user.");
    }

    return [...this.runtimeTurns.values()]
      .filter((turn) => turn.sessionId === runtimeSession.id)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  createCustomerCatalogueRuntimeTurn(input: {
    capability: CustomerRuntimeCapabilityRecord;
    message: string;
    now: Date;
  }): RuntimeTurnResult | null {
    const match = parseProductContextScriptCommand({
      message: input.message,
      tenantId: input.capability.businessId
    });
    if (match === null) return null;
    const proposal = createRuntimeToolProposalFromProductContextScript(match);
    if (proposal.toolName !== "products.list") return null;
    const runtimeSession =
      [...this.runtimeSessions.values()].find(
        (candidate) =>
          candidate.businessId === input.capability.businessId &&
          candidate.userId === `external:${input.capability.platformIdentityId}` &&
          candidate.status === "active" &&
          candidate.turnCount < maxRuntimeTurnsPerSession
      ) ??
      this.createCustomerRuntimeSession({
        businessId: input.capability.businessId,
        actorId: `external:${input.capability.platformIdentityId}`,
        now: input.now
      });
    const query =
      typeof proposal.input.query === "string" ? proposal.input.query : input.message.trim();
    const result = queryCatalogueProducts({
      businessId: input.capability.businessId,
      products: [...this.deps.products.values()],
      query,
      imageForProduct: (product) => this.deps.imageForProduct(product)
    });
    const plan = createRuntimePlan({
      toolName: "products.list",
      input: { query },
      validationErrors: [],
      confirmationToken: null,
      status: "safe_to_execute"
    });
    plan.executedAt = input.now.toISOString();
    const verification = createRuntimeVerification({
      requiresConfirmation: false,
      confirmationSatisfied: false,
      roleAllowed: true,
      rateLimited: false,
      errors: []
    });
    const context = this.buildCustomerRuntimeContext(
      input.capability.businessId,
      `external:${input.capability.platformIdentityId}`
    );
    const turnId = randomUUID();
    const telemetry: RuntimeTelemetryEvent[] = [
      {
        id: randomUUID(),
        sessionId: runtimeSession.id,
        turnId,
        state: "turn.received",
        occurredAt: input.now.toISOString(),
        toolName: null,
        risk: null,
        status: "completed",
        metadata: { principal: "customer_capability" }
      },
      {
        id: randomUUID(),
        sessionId: runtimeSession.id,
        turnId,
        state: "tool.executed",
        occurredAt: input.now.toISOString(),
        toolName: "products.list",
        risk: "low",
        status: "completed",
        metadata: { resultCount: result.total }
      }
    ];
    return this.storeRuntimeTurn({
      runtimeSession,
      turn: {
        id: turnId,
        sessionId: runtimeSession.id,
        businessId: input.capability.businessId,
        actorId: `external:${input.capability.platformIdentityId}`,
        message: input.message,
        normalizedInput: input.message.trim().toLowerCase(),
        parserIntent: "show_products",
        parserConfidence: match.confidence,
        status: "completed",
        context,
        plan,
        verification,
        model: null,
        response: createRuntimeResponse({
          plan,
          proposalReason: proposal.reason,
          toolResult: result,
          verification
        }),
        toolResult: result,
        telemetry,
        runtimeVersion: this.currentAgentProfile(input.capability.businessId, input.now)
          .runtimeVersion,
        createdAt: input.now.toISOString()
      },
      now: input.now
    });
  }

  private createCustomerRuntimeSession(input: {
    businessId: string;
    actorId: string;
    now: Date;
  }): RuntimeSessionSummary {
    const session: RuntimeSessionSummary = {
      id: randomUUID(),
      businessId: input.businessId,
      userId: input.actorId,
      status: "active",
      turnCount: 0,
      createdAt: input.now.toISOString(),
      updatedAt: input.now.toISOString()
    };
    this.runtimeSessions.set(session.id, session);
    return session;
  }

  private buildCustomerRuntimeContext(businessId: string, actorId: string): RuntimeContextSummary {
    return {
      businessId,
      userId: actorId,
      role: "view_only",
      productCount: [...this.deps.products.values()].filter(
        (product) => product.businessId === businessId
      ).length,
      customerCount: 0,
      supplierCount: 0,
      invoiceCount: 0,
      openInvoiceCount: 0,
      paymentCount: 0,
      importJobCount: 0,
      logisticsCount: 0,
      activeLogisticsCount: 0,
      complianceExportCount: 0,
      scheduledDeletionCount: 0,
      verificationTier: "unverified",
      deviceTrustLevel: "unknown",
      betaAccessStatus: "not_invited",
      betaReadinessStatus: "blocked",
      openSupportTicketCount: 0,
      crashFreeSessionRate: 1,
      publicLaunchStatus: "closed",
      launchReadinessStatus: "blocked",
      openLaunchIncidentCount: 0,
      lowStockCount: 0,
      outstandingDebtTotal: 0,
      unreadNotificationCount: 0,
      knowledgeFactCount: 0
    };
  }

  async createRuntimeTurn(
    input: Parameters<AgentRuntimeDomain["executeRuntimeTurn"]>[0]
  ): Promise<RuntimeTurnResult> {
    const auth = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "business:read",
      input.now ?? new Date()
    );
    const acquired = input.conversationId
      ? this.deps.acquireRuntimeTurn?.(input.conversationId, auth.account.id, input.businessId)
      : undefined;
    try {
      const result = await this.executeRuntimeTurn(input);
      if (input.conversationId)
        this.deps.checkpointRuntimeTurn?.(input.conversationId, result.turn, acquired?.fenceToken);
      return result;
    } finally {
      acquired?.release();
    }
  }

  private async executeRuntimeTurn(input: {
    sessionId: string | null;
    businessId: string;
    conversationId?: string;
    runtimeSessionId?: string;
    message: string;
    conversationHistory?: RuntimeModelConversationMessage[];
    confirmationToken?: string;
    signal?: AbortSignal;
    now?: Date;
  }): Promise<RuntimeTurnResult> {
    const now = input.now ?? new Date();
    const auth = this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "business:read",
      now
    );
    // Every current caller of this method is an authenticated business member (this endpoint
    // requires "business:read"); there is no customer-facing entry point yet. Only the owner role
    // gets the "owner" context/prompt audience; every other membership role is treated as "staff"
    // so non-owner members never see owner-only context sources. "customer" audience remains
    // reserved for a future customer-facing entry point and is intentionally never derived here.
    const callerAudience: AgentAudience = agentAudienceForBusinessRole(
      this.deps.requireMembership(input.businessId, auth.user.id).role
    );
    const readiness = this.getAgentRuntimeReadiness({
      sessionId: input.sessionId,
      businessId: input.businessId,
      now
    });
    if (!readiness.ready) {
      throw new Cp2Error(
        409,
        "agent_runtime_not_ready",
        readiness.issues.map((issue) => issue.message).join(" ")
      );
    }
    const hashtagInvocation = parseRuntimeHashtagInvocation(input.message);
    const storedAgentProfile = this.currentAgentProfile(input.businessId, now);
    if (input.confirmationToken === undefined && hashtagInvocation === null) {
      await this.ensureDefaultRuntimeForTurn({
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
        businessId: input.businessId,
        accountId: auth.account.id,
        userId: auth.user.id,
        profile: storedAgentProfile,
        now
      });
    }
    const { activeBinding, activeModelId, nativeResolution } = this.resolveActiveRuntimeModelId(
      input.businessId,
      storedAgentProfile,
      input.conversationId,
      auth.account.id
    );
    if (
      input.conversationId === undefined &&
      this.deps.modelRuntimeAdapterResolver !== undefined &&
      nativeResolution === null &&
      activeBinding === null &&
      input.confirmationToken === undefined &&
      hashtagInvocation === null
    ) {
      throw new Cp2Error(
        409,
        "AGENT_MODEL_NOT_CONFIGURED",
        "This agent does not have a working model yet. Open Agent model settings and activate one.",
        false,
        { agentId: storedAgentProfile.agentId, shopId: input.businessId }
      );
    }
    const runtimeModelId = activeModelId;
    const agentProfile = runtimeAgentProfileFromStored(storedAgentProfile, runtimeModelId);
    const shopRuntime = this.buildShopAgentRuntime(
      storedAgentProfile,
      now,
      callerAudience,
      runtimeModelId,
      activeBinding
    );
    const modelTemplate = this.deps.resolveProductionModelTemplate?.(
      input.businessId,
      storedAgentProfile.agentId,
      runtimeModelId,
      parseMerchantCommand(input.message).intent
    );
    if (modelTemplate !== undefined && modelTemplate !== null) {
      shopRuntime.instructions.generalOperatingRules = [
        ...shopRuntime.instructions.generalOperatingRules,
        ...modelTemplate.compiledInstructions
      ];
    }
    const runtimeSession =
      input.runtimeSessionId === undefined
        ? this.createRuntimeSession({
            sessionId: input.sessionId,
            businessId: input.businessId,
            now
          })
        : this.requireRuntimeSession(input.businessId, input.runtimeSessionId);

    if (runtimeSession.userId !== auth.user.id) {
      throw new Cp2Error(403, "runtime_actor_mismatch", "Runtime session belongs to another user.");
    }

    const context = this.deps.buildRuntimeContext(input.businessId, auth.user.id);
    const turnId = randomUUID();
    const startedAt = now.toISOString();
    const telemetry: RuntimeTelemetryEvent[] = [];
    const appendTelemetry = (
      state: RuntimeTelemetryEvent["state"],
      status: RuntimeTelemetryEvent["status"],
      toolName: RuntimeToolName | null,
      risk: RuntimePlannedAction["risk"] | null,
      metadata: RuntimeTelemetryEvent["metadata"] = {}
    ) => {
      telemetry.push({
        id: randomUUID(),
        sessionId: runtimeSession.id,
        turnId,
        state,
        occurredAt: now.toISOString(),
        toolName,
        risk,
        status,
        metadata
      });
      // Durable execution event log (docs/architecture/durable-execution-plane.md). Only for turns
      // attached to a task (conversation) - a turn with no conversationId never participates in the
      // Runtime Handoff Protocol either (see the checkpointRuntimeTurn call in createRuntimeTurn).
      if (input.conversationId === undefined) return;
      const eventType = runtimeExecutionEventTypeForTelemetry(state, status);
      if (eventType === null) return;
      this.deps.appendRuntimeExecutionEvent?.({
        taskId: input.conversationId,
        eventType,
        executionId: turnId,
        runtimeInstanceId: nativeResolution?.binding.id ?? activeBinding?.binding.id ?? null,
        executionHostId: nativeResolution?.selected.host?.id ?? null,
        payload: { toolName, risk },
        now
      });
    };

    appendTelemetry("turn.received", "completed", null, null, {
      messageLength: input.message.trim().length,
      hasConfirmationToken: input.confirmationToken !== undefined,
      runtimeBindingId: nativeResolution?.binding.id ?? activeBinding?.binding.id ?? null,
      runtimeAgentId: nativeResolution?.agent.id ?? storedAgentProfile.agentId,
      selectedPrimaryModelId: nativeResolution?.primary.model.id ?? activeBinding?.model.id ?? null,
      selectedActualModelId: nativeResolution?.selected.model.id ?? activeBinding?.model.id ?? null,
      executionHostId: nativeResolution?.selected.host?.id ?? null,
      modelInstallationId: nativeResolution?.selected.installation?.id ?? null,
      fallbackUsed: nativeResolution?.fallbackUsed ?? false,
      fallbackReason: nativeResolution?.fallbackReason ?? null,
      modelTemplateId: modelTemplate?.templateId ?? null,
      modelTemplateVersionId: modelTemplate?.templateVersionId ?? null,
      modelTemplateVersion: modelTemplate?.version ?? null
    });

    if (runtimeSession.turnCount >= maxRuntimeTurnsPerSession) {
      const plan = createRuntimePlan({
        toolName: "unknown.clarify",
        input: {},
        validationErrors: ["Runtime session turn limit reached."],
        confirmationToken: null,
        status: "blocked"
      });
      const verification = createRuntimeVerification({
        requiresConfirmation: false,
        confirmationSatisfied: false,
        roleAllowed: true,
        rateLimited: true,
        errors: ["Runtime session turn limit reached."]
      });
      appendTelemetry("turn.rate_limited", "rate_limited", plan.toolName, plan.risk, {
        maxTurns: maxRuntimeTurnsPerSession
      });

      return this.storeRuntimeTurn({
        runtimeSession,
        turn: {
          id: turnId,
          sessionId: runtimeSession.id,
          businessId: input.businessId,
          actorId: auth.user.id,
          message: input.message,
          normalizedInput: input.message.trim().toLowerCase(),
          parserIntent: "unknown",
          parserConfidence: 0,
          status: "rate_limited",
          context,
          plan,
          verification,
          model: null,
          response: "This runtime session has reached its action limit. Start a new session.",
          toolResult: null,
          telemetry,
          runtimeVersion: shopRuntime.version,
          createdAt: startedAt
        },
        now
      });
    }

    appendTelemetry("context.built", "completed", null, null, {
      productCount: context.productCount,
      invoiceCount: context.invoiceCount,
      importJobCount: context.importJobCount
    });

    if (input.confirmationToken !== undefined) {
      return await this.confirmRuntimeAction({
        authUserId: auth.user.id,
        businessId: input.businessId,
        context,
        message: input.message,
        now,
        runtimeSession,
        telemetry,
        turnId,
        token: input.confirmationToken,
        runtimeVersion: shopRuntime.version,
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId })
      });
    }

    const documentImportProposal = createRuntimeDocumentImportProposal(
      this.deps,
      input.businessId,
      input.message
    );
    const messagingProposal = createRuntimeMessagingProposal(
      this.deps,
      input.businessId,
      input.message
    );
    const networkProposal = createRuntimeNetworkProposal(input.message);
    const commerceProposal = createRuntimeCommerceProposal(input.message);
    const receiptContextScriptMatch = parseReceiptContextScriptCommand({
      message: input.message,
      tenantId: input.businessId,
      contextScripts: agentProfile?.contextScripts ?? []
    });
    const receiptProposal =
      receiptContextScriptMatch === null
        ? null
        : createRuntimeReceiptProposal(this.deps, {
            sessionId: input.sessionId,
            businessId: input.businessId,
            message: input.message,
            match: receiptContextScriptMatch,
            now
          });
    const contextScriptMatch = parseProductContextScriptCommand({
      message: input.message,
      tenantId: input.businessId,
      contextScripts: agentProfile?.contextScripts ?? []
    });
    const effectiveContextScriptMatch = receiptContextScriptMatch ?? contextScriptMatch;
    const parserResult =
      effectiveContextScriptMatch === null
        ? parseMerchantCommand(input.message)
        : receiptContextScriptMatch !== null
          ? receiptContextScriptMatchToParseResult(receiptContextScriptMatch)
          : productContextScriptMatchToParseResult(contextScriptMatch!);
    const { items: retrievedContext, diagnostics: contextDiagnostics } = resolveAgentContext({
      sources: this.contextSourcesForRuntime(storedAgentProfile),
      query: input.message,
      audience: callerAudience,
      limit: 6,
      intent: parserResult.intent,
      characterBudget: contextCharacterBudgetForModel(
        runtimeModelId,
        this.deps.resolveCatalogModel(runtimeModelId)
      )
    });
    appendTelemetry("context.plan.completed", "completed", null, null, {
      candidateNodes: contextDiagnostics.candidateNodes,
      selectedNodes: contextDiagnostics.selectedNodes,
      rejectedNodes: contextDiagnostics.rejectedNodes,
      estimatedTokens: contextDiagnostics.estimatedTokens,
      tokenBudget: contextDiagnostics.tokenBudget
    });
    const contextRecipe = contextRecipeRegistry[parserResult.intent];
    const grounding = evaluateGrounding({
      recipe: contextRecipe,
      retrievedContext,
      diagnostics: contextDiagnostics
    });
    const willCallModel =
      hashtagInvocation === null &&
      documentImportProposal === null &&
      messagingProposal === null &&
      networkProposal === null &&
      commerceProposal === null &&
      effectiveContextScriptMatch === null;
    appendTelemetry(
      grounding.status === "grounded" ? "grounding.accepted" : "grounding.rejected",
      "completed",
      null,
      null,
      {
        recipeId: contextRecipe?.id ?? null,
        status: grounding.status,
        missing: grounding.status === "insufficient_evidence" ? grounding.missing.join(",") : null,
        missingScopes:
          grounding.status === "unauthorized" ? grounding.missingScopes.join(",") : null
      }
    );
    const runtimeMemory = shopRuntime.memory.ownerCorrectionsEnabled
      ? this.ownerCorrectionsForBusiness(input.businessId)
          .filter((correction) => correction.status === "active")
          .slice(0, shopRuntime.memory.maximumItemsPerScope)
          .map((correction) => correction.correction)
      : [];
    const modelRoute = willCallModel
      ? await this.createRuntimeModelRoute({
          message: input.message,
          accountId: auth.account.id,
          ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
          ...(input.conversationHistory === undefined
            ? {}
            : { conversationHistory: input.conversationHistory }),
          modelId: runtimeModelId,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          context,
          now,
          appendTelemetry,
          shopRuntime,
          retrievedContext,
          memory: runtimeMemory,
          intent: parserResult.intent,
          ...(modelTemplate === undefined || modelTemplate === null
            ? {}
            : {
                modelTemplate: {
                  templateId: modelTemplate.templateId,
                  templateVersionId: modelTemplate.templateVersionId,
                  version: modelTemplate.version,
                  task: modelTemplate.task,
                  allowedTools: modelTemplate.allowedTools as RuntimeToolName[],
                  contextRequirements: modelTemplate.contextRequirements,
                  ...(modelTemplate.outputSchema === undefined
                    ? {}
                    : { outputSchema: modelTemplate.outputSchema }),
                  constraints: modelTemplate.constraints,
                  templateVocabularySnapshot: modelTemplate.templateVocabularySnapshot,
                  currentVocabularySnapshot: modelTemplate.currentVocabularySnapshot
                }
              })
        })
      : {
          proposal: null,
          trace: null
        };
    if (
      activeBinding !== null &&
      modelRoute.trace !== null &&
      modelRoute.trace.status !== "available"
    ) {
      throw new Cp2Error(
        modelRoute.trace.status === "timeout" ? 504 : 503,
        "AGENT_MODEL_UNAVAILABLE",
        "The active agent model could not complete this message.",
        true,
        {
          bindingId: activeBinding.binding.id,
          modelId: activeBinding.model.id,
          executionTarget: activeBinding.executionTarget,
          runtimeErrorCode: modelRoute.trace.errorCode
        }
      );
    }
    assertResolvedRuntimeAvailable(nativeResolution, modelRoute.trace);
    appendTelemetry("intent.routed", "completed", null, null, {
      intent: parserResult.intent,
      confidence: parserResult.confidence,
      source:
        hashtagInvocation !== null
          ? "hashtag"
          : documentImportProposal !== null
            ? "document_import"
            : messagingProposal !== null
              ? "messaging"
              : networkProposal !== null
                ? "network"
                : commerceProposal !== null
                  ? "commerce"
                  : effectiveContextScriptMatch === null
                    ? modelRoute.proposal === null
                      ? "parser"
                      : "local_model"
                    : "context_script",
      scriptId: effectiveContextScriptMatch?.scriptId ?? null,
      matchedPhrase: effectiveContextScriptMatch?.matchedPhrase ?? null,
      canonicalIntent: effectiveContextScriptMatch?.intent ?? null,
      cardinality: contextScriptMatch?.cardinality ?? null,
      clarificationRequired: effectiveContextScriptMatch?.clarificationRequired ?? false,
      fallbackReason: effectiveContextScriptMatch === null ? "no_context_script_match" : null
    });
    const resolvedProposal =
      hashtagInvocation?.proposal ??
      documentImportProposal ??
      messagingProposal ??
      networkProposal ??
      commerceProposal ??
      (effectiveContextScriptMatch === null
        ? (modelRoute.proposal ?? createRuntimeToolProposal(parserResult))
        : receiptContextScriptMatch !== null
          ? receiptProposal!
          : createRuntimeToolProposalFromProductContextScript(contextScriptMatch!));
    // Grounding gate (brief-adoption §6): only ever narrows an already-unresolved turn - never
    // overrides a deterministic parser proposal or a model-proposed tool call, both of which are
    // grounded by construction (they execute against, and are validated against, live authoritative
    // records; see findRuntimeUnknownEntityReferenceError above and executeRuntimeCapability below).
    // The one case this closes: `parseRuntimeModelOutput`'s "response" kind
    // (packages/tool-core/src/parsers/model-output.ts) lets the model answer in free text instead of
    // proposing a tool - it maps to `toolName: "unknown.clarify"`, `validation: valid()`, and
    // `reason: <the model's own free text>`, which `createRuntimeResponse` falls through to
    // returning verbatim for any unmatched toolName. That free text is model output, not evidence -
    // for a task whose recipe requires evidence that wasn't actually resolved, it must never reach
    // the merchant. Forcing `validation.ok = false` here turns it into an ordinary, already-handled
    // `clarification_required` plan whose response is the deterministic grounding message instead.
    const proposal: typeof resolvedProposal =
      resolvedProposal.toolName === "unknown.clarify" && grounding.status !== "grounded"
        ? {
            ...resolvedProposal,
            validation: { ok: false, errors: [groundingAbstentionMessage(grounding)] }
          }
        : resolvedProposal;
    const definition = runtimeToolRegistry[proposal.toolName];
    const roleAllowed = roleCan(context.role, definition.requiredPermission as BusinessPermission);
    if (input.conversationId !== undefined) {
      this.deps.appendRuntimeExecutionEvent?.({
        taskId: input.conversationId,
        eventType: "AUTHORIZATION_STARTED",
        executionId: turnId,
        runtimeInstanceId: nativeResolution?.binding.id ?? activeBinding?.binding.id ?? null,
        executionHostId: nativeResolution?.selected.host?.id ?? null,
        payload: { toolName: proposal.toolName },
        now
      });
    }
    const entityReferenceError = findRuntimeUnknownEntityReferenceError(
      this.deps,
      input.businessId,
      proposal.toolName,
      proposal.input
    );
    const policyErrors = [
      ...(entityReferenceError === null ? [] : [entityReferenceError]),
      ...enforceAgentPolicy({
        runtime: shopRuntime,
        toolName: proposal.toolName,
        toolInput: proposal.input,
        intent: parserResult.intent
      })
    ];
    const skillBinding = shopRuntime.skills.find(
      (binding) => binding.skillId === proposal.toolName
    );
    const runtimeRequiresConfirmation =
      definition.requiresConfirmation ||
      shopRuntime.instructions.ownerApprovalRequiredFor.includes(proposal.toolName) ||
      (skillBinding !== undefined && skillBinding.requiredConfirmationLevel !== "none");
    const proposalAllowed = proposal.validation.ok && policyErrors.length === 0;
    const confirmationToken = proposalAllowed && runtimeRequiresConfirmation ? randomUUID() : null;
    const plan = createRuntimePlan({
      toolName: proposal.toolName,
      input: proposal.input,
      validationErrors: [...proposal.validation.errors, ...policyErrors],
      confirmationToken,
      status: proposalAllowed
        ? runtimeRequiresConfirmation
          ? "needs_confirmation"
          : "safe_to_execute"
        : "clarification_required"
    });
    const verificationErrors = [
      ...proposal.validation.errors,
      ...policyErrors,
      ...(roleAllowed ? [] : ["Actor role cannot use the proposed runtime tool."])
    ];
    const verification = createRuntimeVerification({
      requiresConfirmation: runtimeRequiresConfirmation,
      confirmationSatisfied: false,
      roleAllowed,
      rateLimited: false,
      errors: verificationErrors
    });
    appendTelemetry("plan.created", plan.status, plan.toolName, plan.risk, {
      requiresConfirmation: plan.requiresConfirmation,
      readOnly: definition.readOnly
    });
    appendTelemetry("verification.completed", plan.status, plan.toolName, plan.risk, {
      ok: verification.ok,
      roleAllowed: verification.roleAllowed
    });
    // Distinct from AUTHORIZATION_COMPLETED (the authorization *check* finishing, whatever its
    // outcome - emitted above via the verification.completed mapping): TOOL_AUTHORIZED confirms
    // this specific tool call is cleared to run, whether it executes immediately or waits for
    // confirmation first.
    if (verification.ok && input.conversationId !== undefined) {
      this.deps.appendRuntimeExecutionEvent?.({
        taskId: input.conversationId,
        eventType: "TOOL_AUTHORIZED",
        executionId: turnId,
        runtimeInstanceId: nativeResolution?.binding.id ?? activeBinding?.binding.id ?? null,
        executionHostId: nativeResolution?.selected.host?.id ?? null,
        payload: { toolName: plan.toolName, actionId: plan.id },
        now
      });
    }

    if (confirmationToken !== null) {
      this.pendingRuntimeActions.set(confirmationToken, {
        sessionId: runtimeSession.id,
        businessId: input.businessId,
        actorId: auth.user.id,
        action: plan
      });
      appendTelemetry("confirmation.required", "needs_confirmation", plan.toolName, plan.risk, {
        actionId: plan.id
      });
    }

    // Deliberately NOT wrapped in try/catch, unlike confirmRuntimeAction below: this auto-execute
    // branch is also reached by hashtag-invoked, confirmation-free tools (e.g. workspace.deliver)
    // through the messaging domain's own createRuntimeTurn call
    // (services/api/src/cp2/domains/messaging/store.ts), which relies on execution failures
    // propagating as real thrown errors - its own try/catch there (isRecoverableAgentModelChatError)
    // deliberately re-throws anything that isn't a model/runtime-availability error, exactly so a
    // hashtag command's file-not-found/storage-failed surfaces loudly rather than being silently
    // absorbed into a soft chat reply. See tests/workspace-conversation-delivery.test.ts.
    const canExecute = plan.status === "safe_to_execute" && verification.ok;
    if (canExecute && input.conversationId !== undefined) {
      this.deps.appendRuntimeExecutionEvent?.({
        taskId: input.conversationId,
        eventType: "TOOL_STARTED",
        executionId: turnId,
        runtimeInstanceId: nativeResolution?.binding.id ?? activeBinding?.binding.id ?? null,
        executionHostId: nativeResolution?.selected.host?.id ?? null,
        payload: { toolName: plan.toolName, actionId: plan.id },
        now
      });
    }
    const toolResult = canExecute
      ? await executeRuntimeCapability(this.deps, {
          sessionId: input.sessionId,
          businessId: input.businessId,
          ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
          action: plan,
          now
        })
      : null;

    if (canExecute) {
      appendTelemetry("tool.executed", "completed", plan.toolName, plan.risk, {
        actionId: plan.id
      });
      plan.executedAt = now.toISOString();
    }

    const status = runtimeStatusFromPlan(plan, verification);
    appendTelemetry("response.generated", status, plan.toolName, plan.risk, {
      actionId: plan.id
    });

    if (modelRoute.trace?.fallbackUsed === true && status === "completed" && verification.ok) {
      this.recordFallbackExperience({
        businessId: input.businessId,
        agentId: shopRuntime.agentId,
        turnId,
        intent: parserResult.intent,
        recipe: contextRecipe,
        evidenceRefs: retrievedContext.map((item) => item.sourceId),
        toolName: plan.toolName,
        fallbackReason: modelRoute.trace.fallbackReason ?? "unspecified",
        now,
        appendTelemetry
      });
    }

    return this.storeRuntimeTurn({
      runtimeSession,
      turn: {
        id: turnId,
        sessionId: runtimeSession.id,
        businessId: input.businessId,
        actorId: auth.user.id,
        message: input.message,
        normalizedInput: parserResult.normalizedInput,
        parserIntent:
          documentImportProposal === null ? parserResult.intent : "confirm_document_import",
        parserConfidence: documentImportProposal === null ? parserResult.confidence : 1,
        status,
        context,
        plan,
        verification,
        model: modelRoute.trace,
        response: createRuntimeResponse({
          plan,
          proposalReason: proposal.reason,
          toolResult,
          verification
        }),
        toolResult,
        telemetry,
        runtimeVersion: shopRuntime.version,
        createdAt: startedAt
      },
      now
    });
  }

  private requireOwnedModelInstallation(
    accountId: string,
    userId: string,
    deviceId: string,
    installationId: string
  ): InstalledAgentModelSummary {
    const model = this.installedAgentModels.get(installationId);
    if (
      model === undefined ||
      model.accountId !== accountId ||
      model.userId !== userId ||
      model.deviceId !== deviceId
    ) {
      throw new Cp2Error(
        404,
        "model_installation_not_found",
        "The model installation was not found on this device."
      );
    }
    return model;
  }

  private async confirmRuntimeAction(input: {
    authUserId: string;
    businessId: string;
    context: RuntimeContextSummary;
    message: string;
    now: Date;
    signal?: AbortSignal;
    runtimeSession: RuntimeSessionSummary;
    telemetry: RuntimeTelemetryEvent[];
    turnId: string;
    token: string;
    runtimeVersion: number;
    conversationId?: string;
  }): Promise<RuntimeTurnResult> {
    const pending = this.pendingRuntimeActions.get(input.token);

    if (pending === undefined) {
      throw new Cp2Error(
        404,
        "runtime_confirmation_not_found",
        "Runtime confirmation was not found."
      );
    }

    if (
      pending.sessionId !== input.runtimeSession.id ||
      pending.businessId !== input.businessId ||
      pending.actorId !== input.authUserId
    ) {
      throw new Cp2Error(
        403,
        "runtime_confirmation_mismatch",
        "Runtime confirmation is not valid."
      );
    }

    const action: RuntimePlannedAction = {
      ...pending.action,
      status: "safe_to_execute",
      confirmationToken: input.token
    };
    const definition = runtimeToolRegistry[action.toolName as RuntimeToolName];
    const roleAllowed = roleCan(
      input.context.role,
      definition.requiredPermission as BusinessPermission
    );
    if (input.conversationId !== undefined) {
      this.deps.appendRuntimeExecutionEvent?.({
        taskId: input.conversationId,
        eventType: "AUTHORIZATION_STARTED",
        executionId: input.turnId,
        runtimeInstanceId: null,
        executionHostId: null,
        payload: { toolName: action.toolName },
        now: input.now
      });
    }
    const verification = createRuntimeVerification({
      requiresConfirmation: action.requiresConfirmation,
      confirmationSatisfied: true,
      roleAllowed,
      rateLimited: false,
      errors: roleAllowed ? [] : ["Actor role cannot use the confirmed runtime tool."]
    });
    const appendTelemetry = (
      state: RuntimeTelemetryEvent["state"],
      status: RuntimeTelemetryEvent["status"],
      metadata: RuntimeTelemetryEvent["metadata"] = {}
    ) => {
      input.telemetry.push({
        id: randomUUID(),
        sessionId: input.runtimeSession.id,
        turnId: input.turnId,
        state,
        occurredAt: input.now.toISOString(),
        toolName: action.toolName,
        risk: action.risk,
        status,
        metadata
      });
      if (input.conversationId === undefined) return;
      const eventType = runtimeExecutionEventTypeForTelemetry(state, status);
      if (eventType === null) return;
      this.deps.appendRuntimeExecutionEvent?.({
        taskId: input.conversationId,
        eventType,
        executionId: input.turnId,
        runtimeInstanceId: null,
        executionHostId: null,
        payload: { toolName: action.toolName, risk: action.risk },
        now: input.now
      });
    };

    appendTelemetry("intent.routed", "completed", {
      confirmation: true
    });
    appendTelemetry("plan.created", action.status, {
      actionId: action.id
    });
    appendTelemetry("verification.completed", action.status, {
      ok: verification.ok,
      roleAllowed: verification.roleAllowed
    });
    if (verification.ok && input.conversationId !== undefined) {
      this.deps.appendRuntimeExecutionEvent?.({
        taskId: input.conversationId,
        eventType: "TOOL_AUTHORIZED",
        executionId: input.turnId,
        runtimeInstanceId: null,
        executionHostId: null,
        payload: { toolName: action.toolName, actionId: action.id },
        now: input.now
      });
    }

    let toolResult: unknown = null;
    let executionError: Cp2Error | null = null;
    if (verification.ok) {
      if (input.conversationId !== undefined) {
        this.deps.appendRuntimeExecutionEvent?.({
          taskId: input.conversationId,
          eventType: "TOOL_STARTED",
          executionId: input.turnId,
          runtimeInstanceId: null,
          executionHostId: null,
          payload: { toolName: action.toolName, actionId: action.id },
          now: input.now
        });
      }
      try {
        toolResult = await executeRuntimeCapability(this.deps, {
          sessionId: this.requireSessionIdForUser(input.authUserId),
          businessId: input.businessId,
          action,
          now: input.now
        });
      } catch (error) {
        executionError =
          error instanceof Cp2Error
            ? error
            : new Cp2Error(
                500,
                "runtime_tool_execution_failed",
                "That action could not be completed."
              );
      }
    }

    const executed = verification.ok && executionError === null;
    if (executed) {
      action.executedAt = input.now.toISOString();
      appendTelemetry("tool.executed", "completed", {
        actionId: action.id
      });
    } else if (executionError !== null) {
      appendTelemetry("tool.executed", "blocked", {
        actionId: action.id,
        errorCode: executionError.code,
        retryable: executionError.retryable ?? false
      });
    }

    // A retryable execution failure keeps the confirmation token alive so a plain follow-up
    // "confirm" retries the SAME already-approved action, instead of forcing the merchant to
    // redraft it from scratch - a non-retryable failure (or a success, which no longer needs the
    // token) consumes it, since retrying identical input would only fail identically again.
    if (executed || (executionError !== null && executionError.retryable !== true)) {
      this.pendingRuntimeActions.delete(input.token);
    }

    appendTelemetry("response.generated", executed ? "completed" : "blocked", {
      actionId: action.id
    });

    return this.storeRuntimeTurn({
      runtimeSession: input.runtimeSession,
      turn: {
        id: input.turnId,
        sessionId: input.runtimeSession.id,
        businessId: input.businessId,
        actorId: input.authUserId,
        message: input.message,
        normalizedInput: input.message.trim().toLowerCase(),
        parserIntent:
          action.toolName === "document_import.confirm" ? "confirm_document_import" : "unknown",
        parserConfidence: 1,
        status: executed ? "completed" : "blocked",
        context: input.context,
        plan: action,
        verification,
        model: null,
        response:
          executionError !== null
            ? runtimeExecutionFailureResponse(executionError)
            : executed
              ? `Confirmed and executed ${action.toolName}.`
              : "I could not execute the confirmed action.",
        toolResult,
        telemetry: input.telemetry,
        runtimeVersion: input.runtimeVersion,
        createdAt: input.now.toISOString()
      },
      now: input.now
    });
  }

  runtimeTurnsForBusiness(businessId: string): RuntimeTurnSummary[] {
    return [...this.runtimeTurns.values()].filter((turn) => turn.businessId === businessId);
  }

  /** MUSE-adoption brief §16/§17 - see report-card.ts for the aggregation itself. */
  runtimeReportCard(input: {
    sessionId: string | null;
    businessId: string;
    now?: Date;
  }): RuntimeReportCard[] {
    this.deps.requireAuthorizedSession(
      input.sessionId,
      input.businessId,
      "business:read",
      input.now ?? new Date()
    );
    return buildRuntimeReportCard(this.runtimeTurnsForBusiness(input.businessId));
  }

  private requireBusinessAgent(
    businessId: string,
    agentId: string,
    now: Date
  ): BusinessAgentProfileSummary {
    const profile = this.currentAgentProfile(businessId, now);
    if (profile.agentId !== agentId || profile.businessId !== businessId) {
      throw new Cp2Error(404, "AGENT_NOT_FOUND", "The requested business agent was not found.");
    }
    return profile;
  }

  private requireCanonicalAiModel(modelId: string): AiModelSummary {
    const model = this.deps.resolveCatalogModel(modelId);
    if (model === undefined) {
      throw new Cp2Error(404, "MODEL_NOT_FOUND", "The requested model was not found.");
    }
    return model;
  }

  private requireModelRuntimeAdapter(input: {
    modelId: string;
    executionTarget: ModelExecutionTarget;
    agentId: string;
    businessId: string;
  }): ModelRuntimeAdapter {
    const adapter = this.deps.modelRuntimeAdapterResolver?.({
      modelId: input.modelId,
      executionTarget: input.executionTarget,
      agentId: input.agentId,
      shopId: input.businessId
    });
    if (adapter === undefined) {
      throw new Cp2Error(
        503,
        "RUNTIME_NOT_CONFIGURED",
        "The selected model runtime is not configured for this deployment.",
        false,
        { modelId: input.modelId, executionTarget: input.executionTarget }
      );
    }
    return adapter;
  }

  /** Shared by createRuntimeTurn and the public storefront agent reply path. */
  resolveActiveRuntimeModelId(
    businessId: string,
    storedAgentProfile: BusinessAgentProfileSummary,
    conversationId?: string,
    accountId?: string
  ): {
    activeBinding: ActiveNativeAgentBinding | null;
    activeModelId: string;
    nativeResolution: ReturnType<AgentRuntimeDomainDeps["resolveNativeRuntimeBinding"]> | null;
  } {
    const activeBinding = this.deps.getActiveNativeRuntimeBinding(
      businessId,
      storedAgentProfile.agentId,
      accountId
    );
    const nativeResolution = this.deps.resolveNativeRuntimeBinding({
      businessId,
      ...(accountId === undefined ? {} : { accountId }),
      agentId: storedAgentProfile.agentId,
      ...(conversationId === undefined ? {} : { conversationId })
    });
    const selectedCloudFallbackModelId = resolveDefaultDeviceModelId(
      this.activeAiModels.get(businessId)?.modelId ?? defaultAiModelId,
      this.deps.resolveCatalogModel(
        this.activeAiModels.get(businessId)?.modelId ?? defaultAiModelId
      )
    );
    const requestedModelId = storedAgentProfile.modelId;
    const activeModelId =
      nativeResolution?.selected.model.id ??
      activeBinding?.model.id ??
      (this.deps.runtimeModelProviderResolver === undefined ||
      requestedModelId === selectedCloudFallbackModelId
        ? selectedCloudFallbackModelId
        : "grogoniclaw-local");
    return { activeBinding, activeModelId, nativeResolution };
  }

  /**
   * Lazy, idempotent first-chat provisioning. Only server-reachable adapters participate here;
   * normal chat never depends on a browser model, web-cached weights, or a per-device install.
   * A configured server adapter (local Ollama) must affirm availability before its host is persisted as
   * usable.
   */
  private async ensureDefaultRuntimeForTurn(input: {
    conversationId?: string;
    businessId: string;
    accountId: string;
    userId: string;
    profile: BusinessAgentProfileSummary;
    now: Date;
  }): Promise<void> {
    const usesPlatformDefaultAgent = input.profile.agentDefinitionId === defaultAgentDefinitionId;
    const agentId = input.profile.agentId;
    const agentName = usesPlatformDefaultAgent
      ? this.deps.platformDefaultRuntime.agentName
      : input.profile.name;
    // An untouched business (still on the platform default agent definition) gets the repository's
    // hosted-first zero-setup engine (Pi), matching the platform default model/execution target it
    // also gets below - this is a deployment-wide bootstrap choice, not a per-agent one. Any other,
    // explicitly chosen agent definition uses its own declared engine instead of being hardcoded to
    // "grogoni" regardless of choice - this is how picking a different agent definition
    // (updateAgentProfile's agentDefinitionId) swaps engines, matching finalizeVerifiedActivation's
    // derivation for the explicit-activation path.
    const agentRuntimeAdapterId = usesPlatformDefaultAgent
      ? this.deps.platformDefaultRuntime.agentRuntimeAdapterId
      : this.deps.resolveAgentCatalogEntry(input.profile.agentDefinitionId).runtimeAdapterId;

    const nativeResolution = this.deps.resolveNativeRuntimeBinding({
      businessId: input.businessId,
      accountId: input.accountId,
      agentId,
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId })
    });
    const hasHostedRuntime =
      nativeResolution !== null &&
      [nativeResolution.primary, ...nativeResolution.fallbacks].some(
        (candidate) =>
          candidate.available &&
          (candidate.host?.type ?? candidate.model.configuration.executionTarget) ===
            this.deps.platformDefaultRuntime.executionTarget
      );
    if (hasHostedRuntime) return;
    // A member who chose an on-device model chose to keep conversations on their device: never
    // attach a hosted (possibly cloud) fallback behind it (ADR-explicit-device-local-models.md).
    // If no device is online the turn fails with LOCAL_DEVICE_UNAVAILABLE instead.
    const primaryTarget =
      nativeResolution?.primary.host?.type ??
      nativeResolution?.primary.model.configuration.executionTarget;
    if (primaryTarget === "browser-local" || primaryTarget === "installed-app") return;
    const modelRuntimeAdapterResolver = this.deps.modelRuntimeAdapterResolver;
    if (modelRuntimeAdapterResolver === undefined) return;

    const agentAdapter = this.deps.agentRuntimeAdapterResolver(agentRuntimeAdapterId);
    if (
      agentAdapter === undefined ||
      this.deps.platformDefaultRuntime.executionTarget === "remote-shop-device"
    ) {
      return;
    }
    const agent: NativeRuntimeAgentSummary = {
      id: agentId,
      businessId: input.businessId,
      accountId: input.accountId,
      name: agentName,
      provider: agentRuntimeAdapterId === "pi" ? "pi" : "grogoni-business-agent",
      packageRef: null,
      version: "1",
      runtimeContractVersion: "1",
      capabilities: ["tools", "mcp"],
      configuration: {
        runtimeAdapterId: agentRuntimeAdapterId,
        requiredModelCapabilities: ["chat"]
      },
      status: "active",
      createdAt: input.now.toISOString(),
      updatedAt: input.now.toISOString()
    };
    let agentAvailable = false;
    try {
      // Bounded the same way as every other live runtime probe in this file (see
      // withRuntimeDeadline usages above and in getEffectiveRuntime) - a hung or unreachable
      // execution host must not block this repair step for its full inference timeout budget
      // (LOCAL_INFERENCE_TIMEOUT_MS defaults to 5 minutes, sized for real generation, not a
      // lightweight availability check). Without this bound a degraded inference host turns
      // every chat send that reaches this path into the client-visible generic request timeout
      // instead of a fast, typed runtime-unavailable failure.
      agentAvailable = (
        await withRuntimeDeadline(() =>
          agentAdapter.canRun({
            agent,
            modelId: this.deps.platformDefaultRuntime.modelId,
            conversationId: input.conversationId ?? "runtime-unbound",
            shopId: input.businessId
          })
        )
      ).available;
    } catch {
      return;
    }
    if (!agentAvailable) return;

    const preferredIds = uniqueModelIds([
      this.activeAiModels.get(input.businessId)?.modelId,
      usesPlatformDefaultAgent ? this.deps.platformDefaultRuntime.modelId : input.profile.modelId,
      input.profile.modelId,
      defaultAiModelId,
      ...this.deps
        .listModelCatalog()
        .filter((model) => model.available && model.capabilities.includes("chat"))
        .sort((left, right) => Number(right.recommended) - Number(left.recommended))
        .map((model) => model.id)
    ]);
    const defaultExecutionTarget = this.deps.platformDefaultRuntime.executionTarget;
    const probeTargets = preferredIds
      .map((modelId) => {
        const model = this.deps.resolveCatalogModel(modelId);
        if (model === undefined || !model.available || !model.capabilities.includes("chat")) {
          return null;
        }
        const adapter = modelRuntimeAdapterResolver({
          modelId,
          executionTarget: defaultExecutionTarget,
          agentId,
          shopId: input.businessId
        });
        return adapter === undefined ? null : { modelId, model, adapter };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    // Probe every remaining candidate concurrently under one shared control-plane deadline instead
    // of one deadline per candidate applied serially - with several catalog models and an
    // unreachable inference host, per-candidate bounds alone could still add up to minutes of total
    // latency (N candidates x the per-probe timeout) before this repair step gives up. A single
    // shared deadline caps the whole step at withRuntimeDeadline's bound regardless of how many
    // candidates exist; Promise.allSettled never itself rejects; it is the deadline race that
    // guarantees this resolves even if some adapters never answer.
    let settled: PromiseSettledResult<ModelRuntimeAvailability>[];
    try {
      settled = await withRuntimeDeadline((signal) =>
        Promise.allSettled(
          probeTargets.map(({ modelId, adapter }) =>
            adapter.canRun({ modelId, agentId, shopId: input.businessId, signal })
          )
        )
      );
    } catch {
      return;
    }
    const candidates: Array<{
      model: AiModelSummary;
      executionTarget: ModelExecutionTarget;
      checkedAt: string;
    }> = [];
    for (let index = 0; index < probeTargets.length; index += 1) {
      const result = settled[index];
      if (result?.status === "fulfilled" && result.value.available) {
        candidates.push({
          model: (probeTargets[index] as (typeof probeTargets)[number]).model,
          executionTarget: defaultExecutionTarget,
          checkedAt: input.now.toISOString()
        });
      }
      if (candidates.length >= 2) break;
    }
    if (candidates.length === 0) return;
    this.deps.ensureDefaultRuntimeBinding({
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      businessId: input.businessId,
      accountId: input.accountId,
      agentId,
      agentName,
      agentRuntimeAdapterId,
      candidates,
      updatedBy: input.userId,
      checkedAt: input.now.toISOString()
    });
  }

  private recordAgentModelBindingAudit(
    type: string,
    binding: AgentModelBindingAuditFields,
    actorId: string,
    extra: Record<string, string | number | boolean | null>
  ): void {
    this.deps.recordAuditEvent({
      type,
      aggregateType: "agent_model_binding",
      aggregateId: binding.id,
      actorId,
      occurredAt: binding.updatedAt,
      payload: {
        shopId: binding.shopId,
        agentId: binding.agentId,
        modelId: binding.modelId,
        executionTarget: binding.executionTarget,
        status: binding.status,
        ...extra
      }
    });
  }

  currentAgentProfile(businessId: string, now: Date): BusinessAgentProfileSummary {
    const stored = this.agentProfiles.get(businessId);
    if (stored !== undefined) return hydrateBusinessAgentProfile(stored);
    return createDefaultBusinessAgentProfile({
      business: this.deps.requireBusiness(businessId),
      modelId:
        this.activeAiModels.get(businessId)?.modelId ?? this.deps.platformDefaultRuntime.modelId,
      updatedAt: now.toISOString(),
      updatedBy: "00000000-0000-4000-8000-000000000000",
      agentDefinition: this.deps.resolveAgentCatalogEntry(defaultAgentDefinitionId)
    });
  }

  buildShopAgentRuntime(
    profile: BusinessAgentProfileSummary,
    now: Date,
    audience: AgentAudience,
    modelId = profile.modelId,
    activeBinding?: ActiveNativeAgentBinding | null
  ): ShopAgentRuntime {
    const contextSources = this.contextSourcesForRuntime(profile);
    return buildShopAgentRuntimeModule(
      {
        deps: this.deps,
        activeBinding:
          activeBinding === undefined
            ? this.deps.getActiveNativeRuntimeBinding(profile.businessId, profile.agentId)
            : activeBinding,
        contextSources
      },
      profile,
      now,
      audience,
      modelId
    );
  }

  contextSourcesForRuntime(profile: BusinessAgentProfileSummary): AgentContextSource[] {
    return contextSourcesForRuntimeModule(
      {
        deps: this.deps,
        agentContextSources: this.agentContextSources,
        ownerCorrections: this.ownerCorrectionsForBusiness(profile.businessId),
        runtimeExperiences: this.validatedRuntimeExperiencesForBusiness(profile.businessId)
      },
      profile
    );
  }
  private synchronizeProfileContextSources(profile: BusinessAgentProfileSummary, now: Date): void {
    for (const source of this.agentContextSources.values()) {
      if (source.shopId === profile.businessId && source.type === "context_script") {
        source.status = "archived";
        source.deletedAt = now.toISOString();
        source.updatedAt = now.toISOString();
      }
    }
    profile.contextScripts.forEach((content, index) => {
      const source = contextSourceRecord({
        id: randomUUID(),
        businessId: profile.businessId,
        type: "context_script",
        title: `Context script ${index + 1}`,
        content,
        sensitivity: "internal",
        customerVisible: false,
        sourceRecordId: null,
        now
      });
      this.agentContextSources.set(source.id, source);
    });
  }

  private runtimeVersionsForBusiness(businessId: string): AgentRuntimeVersion[] {
    return [...this.agentRuntimeVersions.values()]
      .filter((version) => version.shopId === businessId)
      .sort((left, right) => right.version - left.version);
  }

  private recordAgentRuntimeVersion(
    profile: BusinessAgentProfileSummary,
    actorId: string,
    changeSummary: string
  ): AgentRuntimeVersion {
    const runtime = this.buildShopAgentRuntime(profile, new Date(profile.updatedAt), "owner");
    const version: AgentRuntimeVersion = {
      id: randomUUID(),
      tenantId: profile.tenantId,
      shopId: profile.shopId,
      agentId: profile.agentId,
      version: profile.runtimeVersion,
      runtime: {
        ...runtime,
        context: {
          ...runtime.context,
          sources: runtime.context.sources.map((source) => ({
            ...cloneAgentContextSource(source),
            retrievalMetadata: { ...source.retrievalMetadata, content: null }
          }))
        }
      },
      createdBy: actorId,
      changeSummary: normalizeRequiredBoundedText(changeSummary, "runtime change summary", 500),
      createdAt: profile.updatedAt,
      previousVersion: profile.runtimeVersion > 1 ? profile.runtimeVersion - 1 : null
    };
    const existing = this.runtimeVersionsForBusiness(profile.businessId).find(
      (candidate) => candidate.version === version.version
    );
    if (existing !== undefined) this.agentRuntimeVersions.delete(existing.id);
    this.agentRuntimeVersions.set(version.id, version);
    return cloneAgentRuntimeVersion(version);
  }

  private ownerCorrectionsForBusiness(businessId: string): AgentOwnerCorrection[] {
    return [...this.agentOwnerCorrections.values()]
      .filter((correction) => correction.shopId === businessId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private evaluationEventsForBusiness(businessId: string): AgentEvaluationEvent[] {
    return [...this.agentEvaluationEvents.values()]
      .filter((event) => event.shopId === businessId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private recordAgentEvaluationEvent(input: {
    businessId: string;
    runtimeVersion: number;
    modelId: string | null;
    eventType: AgentEvaluationEventType;
    outcome: AgentEvaluationEvent["outcome"];
    score: number | null;
    reason: string | null;
    metadata: AgentEvaluationEvent["metadata"];
    sessionId: string | null;
    messageId: string | null;
    now: Date;
  }): AgentEvaluationEvent {
    const profile = this.currentAgentProfile(input.businessId, input.now);
    const event: AgentEvaluationEvent = {
      id: randomUUID(),
      tenantId: input.businessId,
      shopId: input.businessId,
      agentId: profile.agentId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      eventType: input.eventType,
      outcome: input.outcome,
      score: input.score,
      reason: input.reason,
      metadata: { ...input.metadata },
      runtimeVersion: input.runtimeVersion,
      modelId: input.modelId,
      createdAt: input.now.toISOString()
    };
    this.agentEvaluationEvents.set(event.id, event);
    return { ...event, metadata: { ...event.metadata } };
  }

  resolveRuntimeModelProvider(
    shopRuntime: ShopAgentRuntime,
    modelId: string,
    conversationId?: string,
    attemptedRuntimeKeys?: ReadonlySet<string>,
    accountId?: string
  ): {
    provider: RuntimeModelProvider | undefined;
    executionTarget: ModelExecutionTarget | undefined;
    resolutionSource: ExecutionTargetResolutionSource | null;
    runtimeKey: string | null;
    runtimeBindingId: string | null;
    resolvedModelId: string;
    executionHostId: string | null;
    fallbackIndex: number;
  } {
    const nativeResolution = this.deps.resolveNativeRuntimeBinding({
      businessId: shopRuntime.shopId,
      ...(accountId === undefined ? {} : { accountId }),
      agentId: shopRuntime.agentId,
      ...(conversationId === undefined ? {} : { conversationId })
    });
    return resolveNativeRuntimeModelProvider({
      shopRuntime,
      requestedModelId: modelId,
      nativeResolution,
      requireAdapter: (adapterInput) => this.requireModelRuntimeAdapter(adapterInput),
      adapterResolverConfigured: this.deps.modelRuntimeAdapterResolver !== undefined,
      ...(accountId === undefined ? {} : { accountId }),
      ...(this.deps.runtimeModelProvider === undefined
        ? {}
        : { runtimeModelProvider: this.deps.runtimeModelProvider }),
      ...(this.deps.runtimeModelProviderResolver === undefined
        ? {}
        : { runtimeModelProviderResolver: this.deps.runtimeModelProviderResolver }),
      ...(attemptedRuntimeKeys === undefined ? {} : { attemptedRuntimeKeys }),
      // Remote-shop-device execution is negotiated by the authenticated owner-node client
      // protocol. This in-process provider call can execute only server-reachable hosted targets
      // (local Ollama today) - any ModelExecutionTarget except remote-shop-device.
      eligibleExecutionTargets: new Set<ModelExecutionTarget>(
        modelExecutionTargets.filter((target) => target !== "remote-shop-device")
      )
    });
  }

  private async createRuntimeModelRoute(input: {
    accountId: string;
    conversationHistory?: RuntimeModelConversationMessage[];
    conversationId?: string;
    message: string;
    modelId: string;
    context: RuntimeContextSummary;
    shopRuntime: ShopAgentRuntime;
    retrievedContext: ReturnType<typeof retrieveAgentContext>;
    memory: string[];
    intent: RuntimeTurnSummary["parserIntent"];
    modelTemplate?: RuntimeModelTemplateRecipe;
    now: Date;
    appendTelemetry: (
      state: RuntimeTelemetryEvent["state"],
      status: RuntimeTelemetryEvent["status"],
      toolName: RuntimeToolName | null,
      risk: RuntimePlannedAction["risk"] | null,
      metadata?: RuntimeTelemetryEvent["metadata"]
    ) => void;
  }): Promise<{
    proposal: ReturnType<typeof createRuntimeToolProposal> | null;
    trace: RuntimeModelTrace | null;
  }> {
    const resolvedAgent = this.deps.resolveNativeRuntimeBinding({
      businessId: input.shopRuntime.shopId,
      accountId: input.accountId,
      agentId: input.shopRuntime.agentId,
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId })
    })?.agent;
    const agent: NativeRuntimeAgentSummary = resolvedAgent ?? {
      id: input.shopRuntime.agentId,
      businessId: input.shopRuntime.shopId,
      accountId: null,
      name: input.shopRuntime.identity.agentName,
      provider: "grogoni-legacy-runtime",
      packageRef: null,
      version: String(input.shopRuntime.version),
      runtimeContractVersion: "1",
      capabilities: ["tools", "mcp"],
      configuration: { runtimeAdapterId: "grogoni" },
      status: "active",
      createdAt: input.now.toISOString(),
      updatedAt: input.now.toISOString()
    };
    return createRuntimeModelRoute(
      {
        resolveRuntimeModelProvider: (runtime, modelId, attemptedRuntimeKeys) =>
          this.resolveRuntimeModelProvider(
            runtime,
            modelId,
            input.conversationId,
            attemptedRuntimeKeys,
            input.accountId
          ),
        resolveAgentRuntimeAdapter: (adapterId) => this.deps.agentRuntimeAdapterResolver(adapterId)
      },
      {
        ...input,
        agent,
        ...(input.conversationId && this.deps.activeRuntimeCheckpoint?.(input.conversationId)
          ? { runtimeHandoff: this.deps.activeRuntimeCheckpoint(input.conversationId)! }
          : {})
      }
    );
  }
  private requireRuntimeSession(
    businessId: string,
    runtimeSessionId: string
  ): RuntimeSessionSummary {
    const runtimeSession = this.runtimeSessions.get(runtimeSessionId);

    if (runtimeSession === undefined || runtimeSession.businessId !== businessId) {
      throw new Cp2Error(404, "runtime_session_not_found", "Runtime session was not found.");
    }

    if (runtimeSession.status !== "active") {
      throw new Cp2Error(409, "runtime_session_closed", "Runtime session is closed.");
    }

    return runtimeSession;
  }

  private requireSessionIdForUser(userId: string): string | null {
    const session = [...this.deps.sessions.values()]
      .filter((candidate) => candidate.userId === userId && candidate.revokedAt === null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];

    return session?.id ?? null;
  }

  private storeRuntimeTurn(input: {
    runtimeSession: RuntimeSessionSummary;
    turn: RuntimeTurnSummary;
    now: Date;
  }): RuntimeTurnResult {
    this.runtimeTurns.set(input.turn.id, input.turn);
    const updatedSession: RuntimeSessionSummary = {
      ...input.runtimeSession,
      turnCount: input.runtimeSession.turnCount + 1,
      updatedAt: input.now.toISOString()
    };
    this.runtimeSessions.set(updatedSession.id, updatedSession);
    this.deps.recordAuditEvent({
      type: "runtime.turn_recorded",
      aggregateType: "runtime_turn",
      aggregateId: input.turn.id,
      actorId: input.turn.actorId,
      occurredAt: input.now.toISOString(),
      payload: {
        businessId: input.turn.businessId,
        runtimeSessionId: input.turn.sessionId,
        parserIntent: input.turn.parserIntent,
        toolName: input.turn.plan.toolName,
        risk: input.turn.plan.risk,
        status: input.turn.status,
        messageLength: input.turn.message.length
      }
    });
    const profile = this.currentAgentProfile(input.turn.businessId, input.now);
    if (
      profile.evaluationPolicy.enabled &&
      runtimeEvaluationSampled(input.turn.id, profile.evaluationPolicy.sampleRate)
    ) {
      const outcome: AgentEvaluationEvent["outcome"] =
        input.turn.status === "completed"
          ? "success"
          : input.turn.status === "clarifying" || input.turn.status === "needs_confirmation"
            ? "partial"
            : "blocked";
      this.recordAgentEvaluationEvent({
        businessId: input.turn.businessId,
        runtimeVersion: input.turn.runtimeVersion,
        modelId: profile.modelId,
        eventType:
          input.turn.plan.executedAt !== null && profile.evaluationPolicy.recordToolOutcomes
            ? "tool_execution"
            : input.turn.verification.errors.length > 0 &&
                profile.evaluationPolicy.recordPolicyBlocks
              ? "policy_compliance"
              : "intent_classification",
        outcome,
        score: outcome === "success" ? 1 : outcome === "partial" ? 0.5 : 0,
        reason:
          input.turn.verification.errors[0] ??
          (input.turn.plan.executedAt !== null
            ? "Verified runtime action completed."
            : "Runtime turn recorded."),
        metadata: {
          intent: input.turn.parserIntent,
          toolName: input.turn.plan.toolName,
          status: input.turn.status,
          // Session turn count at the moment of this event - the raw signal
          // getAgentEvaluationSummary's averageSessionTurnCountAtClarify aggregates, so a real
          // increase in clarifies-happening-late-in-long-sessions is a traceable number, not an
          // impression (METR's finding: models degrade on long, under-specified interactions).
          turnCount: updatedSession.turnCount
        },
        sessionId: input.turn.sessionId,
        messageId: null,
        now: input.now
      });
      if (
        profile.evaluationPolicy.recordLatency &&
        typeof input.turn.model?.durationMs === "number"
      ) {
        this.recordAgentEvaluationEvent({
          businessId: input.turn.businessId,
          runtimeVersion: input.turn.runtimeVersion,
          modelId: profile.modelId,
          eventType: "response_latency",
          outcome: input.turn.model?.status === "available" ? "success" : "partial",
          score: null,
          reason: "Provider-neutral model completion latency.",
          metadata: {
            durationMs: input.turn.model?.durationMs ?? 0,
            provider: input.turn.model?.provider ?? "none"
          },
          sessionId: input.turn.sessionId,
          messageId: null,
          now: input.now
        });
      }
    }

    return {
      session: updatedSession,
      turn: input.turn
    };
  }
}

/** The minimal shape recordAgentModelBindingAudit needs - satisfied by a full projected
 *  AgentModelBindingSummary (the success paths) or by failedActivationAuditFields below (the
 *  failure paths, which never persist a native binding so there is no real one to project). */
interface AgentModelBindingAuditFields {
  id: string;
  updatedAt: string;
  shopId: string;
  agentId: string;
  modelId: string;
  executionTarget: ModelExecutionTarget;
  status: string;
}

/** A failed activation attempt writes no runtime binding (native or otherwise) - this synthesizes
 *  just enough shape for the audit trail from the request that failed, keyed deterministically by
 *  agent+model so repeated failures for the same pair are easy to correlate in the audit log. */
function failedActivationAuditFields(
  input: {
    agentId: string;
    businessId: string;
    modelId: string;
    executionTarget: ModelExecutionTarget;
  },
  occurredAt: string,
  errorCode: string | null
): AgentModelBindingAuditFields {
  return {
    id: `activation-attempt:${input.agentId}:${input.modelId}`,
    updatedAt: occurredAt,
    shopId: input.businessId,
    agentId: input.agentId,
    modelId: input.modelId,
    executionTarget: input.executionTarget,
    status: isUnavailableRuntimeCode(errorCode) ? "unavailable" : "failed"
  };
}

function uniqueModelIds(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized === undefined || normalized === "" || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
