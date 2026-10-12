/**
 * Pure, stateless helpers and constants for the agent/AI-runtime domain
 * (services/api/src/cp2/domains/agent-runtime/store.ts) - AI model catalog data, agent-profile
 * normalization/cloning, context-source construction, runtime-plan/verification/response
 * builders, and model-fallback-quota validation. Split out from the domain's own store.ts
 * (same reasoning as every other domain's shared.ts) purely for file-size sanity - this is by
 * far the largest cluster of pure helpers in the whole modularization effort, at roughly 1600
 * lines with zero `this` dependency.
 */
/**
 * Ninth slice of in-process domain modularization for the Cp2Store monolith (see
 * docs/architecture/domain-modularization-roadmap.md). The largest slice by method count and by
 * total line volume: owns `activeAiModels`, `agentProfiles`, `agentRuntimeVersions`,
 * `agentContextSources`, `agentEvaluationEvents`, `agentOwnerCorrections`,
 * `installedAgentModels` (+ the ephemeral `agentModelActivationLocks` mutex Set),
 * `runtimeSessions`, `runtimeTurns`, and `pendingRuntimeActions` (never persisted - no
 * `Cp2Snapshot` field) - plus the entire `createRuntimeTurn` pipeline (context retrieval, tool
 * proposal, confirmation, execution, model routing, recall persistence) and every
 * AI-model-catalog/activation/assignment method. There is no `agentModelBindings` map - runtime
 * binding state lives solely in `NativeRuntimeBindingStore` (`../native-runtime/store.ts`); see
 * store.ts's own header comment for the full explanation.
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
 * (`deleteAccountOwnedData`, which sweeps all of them completely). This was true before this
 * extraction; flagging it here rather than silently fixing it as a side effect, since
 * shop-deletion semantics for business-scoped agent config deserve a deliberate product decision,
 * not an incidental one made while moving code.
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
import { createHash, randomUUID } from "node:crypto";
import type {
  AgentContextSource,
  AgentDefinitionId,
  AgentEvaluationPolicy,
  AgentDefinition,
  AgentInstructions,
  AgentMemoryPolicy,
  AgentModelBindingPermissions,
  AgentModelRuntimeBackend,
  AgentPersonality,
  AgentRuntimeVersion,
  AgentSkillBinding,
  AiModelSummary,
  BusinessSummary,
  CatalogueQueryResult,
  ChannelProvider,
  EvidenceProvenance,
  InstalledAgentModelSummary,
  ModelExecutionTarget,
  ModelRuntimeHealthSummary,
  PreferredExecutionMode,
  RuntimeContextSummary,
  RuntimeExperience,
  RuntimeModelCompletionResult,
  RuntimeModelConversationMessage,
  RuntimeModelPrompt,
  RuntimeModelTrace,
  RuntimeParserIntent,
  RuntimePlannedAction,
  RuntimeToolName,
  RuntimeTurnStatus,
  RuntimeVerificationResult,
  ShopAgentRuntime,
  SupportedLanguage
} from "@grogoni/shared-types";
import {
  defaultAgentDefinition,
  defaultAgentDefinitionId,
  isAgentDefinitionId
} from "@grogoni/shared-types";
import { runtimeToolRegistry, type parseRuntimeModelOutput } from "@grogoni/tool-core";
import { Cp2Error } from "../../cp2-error.js";
import type { ModelRuntimeAdapter } from "../../../inference/model-runtime.js";
import { isSupportedLanguage, normalizeRequiredBoundedText } from "../../text-normalization.js";
import {
  defaultAgentEvaluationPolicy,
  defaultAgentInstructions,
  defaultAgentMemoryPolicy,
  defaultAgentPersonality,
  defaultAgentSkillBindings
} from "../../agent-business-runtime.js";

export interface PendingRuntimeAction {
  sessionId: string;
  businessId: string;
  actorId: string;
  conversationId: string | null;
  expiresAt: string;
  /** Parser intent at proposal time: confirmation re-checks skill policy against this intent. */
  intent: RuntimeParserIntent;
  action: RuntimePlannedAction;
}

export interface RuntimeAgentProfile {
  behavior: string;
  contextScripts: string[];
  integrations: string[];
  knowledge: string;
  model: string;
  role: string;
  instructions: string;
  tools: string[];
}

export interface BusinessAgentProfileInput {
  agentDefinitionId?: AgentDefinitionId;
  name: string;
  description: string;
  modelId: string;
  role: string;
  language: SupportedLanguage;
  personality: string;
  instructions: string;
  knowledge: string;
  tools: string[];
  integrations: string[];
  contextScripts: string[];
  status: "active" | "draft";
  personalityConfig?: AgentPersonality;
  instructionPolicy?: AgentInstructions;
  skillBindings?: AgentSkillBinding[];
  memoryPolicy?: AgentMemoryPolicy;
  evaluationPolicy?: AgentEvaluationPolicy;
  supportedLanguages?: SupportedLanguage[];
  businessCategory?: string;
  publicIntroduction?: string;
}

export interface BusinessAgentProfileSummary extends Omit<
  BusinessAgentProfileInput,
  "agentDefinitionId"
> {
  agentDefinitionId: AgentDefinitionId;
  businessId: string;
  tenantId: string;
  shopId: string;
  agentId: string;
  runtimeVersion: number;
  createdAt: string;
  personalityConfig: AgentPersonality;
  instructionPolicy: AgentInstructions;
  skillBindings: AgentSkillBinding[];
  memoryPolicy: AgentMemoryPolicy;
  evaluationPolicy: AgentEvaluationPolicy;
  supportedLanguages: SupportedLanguage[];
  businessCategory: string;
  publicIntroduction: string;
  updatedAt: string;
  updatedBy: string;
}

export type NormalizedBusinessAgentProfile = Omit<
  BusinessAgentProfileInput,
  "agentDefinitionId"
> & {
  agentDefinitionId: AgentDefinitionId;
  personalityConfig: AgentPersonality;
  instructionPolicy: AgentInstructions;
  skillBindings: AgentSkillBinding[];
  memoryPolicy: AgentMemoryPolicy;
  evaluationPolicy: AgentEvaluationPolicy;
  supportedLanguages: SupportedLanguage[];
  businessCategory: string;
  publicIntroduction: string;
};

export const maxRuntimeTurnsPerSession = 20;

export function buildRuntimeModelPrompt(
  message: string,
  context: RuntimeContextSummary | undefined,
  conversationHistory?: RuntimeModelConversationMessage[],
  runtime?: Pick<
    RuntimeModelPrompt,
    | "runtimeVersion"
    | "compiledInstructions"
    | "retrievedContext"
    | "allowedTools"
    | "modelTemplate"
    | "agentInstructions"
  >
): RuntimeModelPrompt {
  return {
    message,
    ...(runtime?.agentInstructions === undefined
      ? {}
      : { agentInstructions: runtime.agentInstructions }),
    ...(conversationHistory === undefined ? {} : { conversationHistory }),
    ...(context === undefined ? {} : { context }),
    allowedTools: runtime?.allowedTools ?? (Object.keys(runtimeToolRegistry) as RuntimeToolName[]),
    ...(runtime?.runtimeVersion === undefined ? {} : { runtimeVersion: runtime.runtimeVersion }),
    ...(runtime?.compiledInstructions === undefined
      ? {}
      : { compiledInstructions: runtime.compiledInstructions }),
    ...(runtime?.retrievedContext === undefined
      ? {}
      : { retrievedContext: runtime.retrievedContext }),
    ...(runtime?.modelTemplate === undefined ? {} : { modelTemplate: runtime.modelTemplate }),
    schemaVersion: "cp11-runtime-model-v1"
  };
}

/** Matches agent-business-runtime.ts's maxUntrustedContextLength - same order-of-magnitude budget
 *  for a text field carried on every turn record, applied here to the model's own output rather
 *  than untrusted input context. */
export const runtimeModelTraceTextLimit = 4_000;

function truncateForTrace(text: string): string {
  if (text.length <= runtimeModelTraceTextLimit) return text;
  return `${text.slice(0, runtimeModelTraceTextLimit)}\n[truncated]`;
}

export function modelTraceFromCompletion(
  completion: RuntimeModelCompletionResult,
  outputKind: RuntimeModelTrace["outputKind"]
): RuntimeModelTrace {
  return {
    provider: completion.provider,
    status: completion.status,
    durationMs: completion.durationMs,
    outputKind,
    errorCode: completion.errorCode,
    ...(completion.outputText === null
      ? {}
      : { rawOutputText: truncateForTrace(completion.outputText) }),
    ...(typeof completion.metadata.providerModelId === "string"
      ? { providerModelId: completion.metadata.providerModelId }
      : {}),
    ...(typeof completion.metadata.inferenceRequestId === "string"
      ? { inferenceRequestId: completion.metadata.inferenceRequestId }
      : {}),
    ...(typeof completion.metadata.promptTokens === "number"
      ? { promptTokens: completion.metadata.promptTokens }
      : {}),
    ...(typeof completion.metadata.completionTokens === "number"
      ? { completionTokens: completion.metadata.completionTokens }
      : {})
  };
}

export function createRuntimePlan(input: {
  toolName: RuntimeToolName;
  input: Record<string, unknown>;
  validationErrors: string[];
  confirmationToken: string | null;
  status: RuntimePlannedAction["status"];
}): RuntimePlannedAction {
  const definition = runtimeToolRegistry[input.toolName];

  return {
    id: randomUUID(),
    toolName: input.toolName,
    risk: definition.risk,
    requiresConfirmation: definition.requiresConfirmation,
    status: input.status,
    input: input.input,
    validationErrors: input.validationErrors,
    confirmationToken: input.confirmationToken,
    executedAt: null
  };
}

export function createRuntimeVerification(input: {
  requiresConfirmation: boolean;
  confirmationSatisfied: boolean;
  roleAllowed: boolean;
  rateLimited: boolean;
  errors: string[];
}): RuntimeVerificationResult {
  return {
    ok:
      !input.rateLimited &&
      input.roleAllowed &&
      input.errors.length === 0 &&
      (!input.requiresConfirmation || input.confirmationSatisfied),
    requiresConfirmation: input.requiresConfirmation,
    confirmationSatisfied: input.confirmationSatisfied,
    roleAllowed: input.roleAllowed,
    rateLimited: input.rateLimited,
    errors: input.errors
  };
}

export function runtimeStatusFromPlan(
  plan: RuntimePlannedAction,
  verification: RuntimeVerificationResult
): RuntimeTurnStatus {
  if (verification.rateLimited) {
    return "rate_limited";
  }

  if (!verification.roleAllowed) {
    return "blocked";
  }

  if (plan.status === "clarification_required") {
    return "clarifying";
  }

  if (plan.status === "needs_confirmation") {
    return "needs_confirmation";
  }

  return verification.errors.length > 0 ? "blocked" : "completed";
}

/**
 * Turns a thrown execution-time Cp2Error into merchant-facing text instead of the raw HTTP error
 * the request would otherwise crash out with (InterCode/Reflexion's shared standard: surface the
 * specific failure reason, don't just fail silently or generically). Cp2Error.retryable is this
 * codebase's own existing classification of which errors are safe to retry - reused here rather
 * than guessing at a new one - so only a retryable failure invites a retry; the messages in this
 * codebase (e.g. "The customer was not found.") are already written as plain, merchant-safe text.
 */
export function runtimeExecutionFailureResponse(error: Cp2Error): string {
  return error.retryable === true ? `${error.message} You can try that again.` : error.message;
}

export function createRuntimeResponse(input: {
  plan: RuntimePlannedAction;
  proposalReason: string;
  toolResult: unknown | null;
  verification: RuntimeVerificationResult;
}): string {
  if (!input.verification.roleAllowed) {
    return "I cannot use that tool with your current business role.";
  }

  if (input.plan.status === "clarification_required") {
    return input.plan.validationErrors[0] ?? "I need more details before I can plan that.";
  }

  if (input.plan.status === "needs_confirmation") {
    return `I prepared ${input.plan.toolName}. Confirm before I run it.`;
  }

  if (input.plan.toolName === "products.list" && isCatalogueQueryResult(input.toolResult)) {
    if (input.toolResult.total === 0) {
      return `No catalogue products matched "${input.toolResult.query}" in this shop.`;
    }
    return `Found ${input.toolResult.total} verified catalogue ${input.toolResult.total === 1 ? "product" : "products"} for "${input.toolResult.query}".`;
  }

  if (input.plan.toolName === "workspace.deliver" && isWorkspaceDeliverResult(input.toolResult)) {
    return input.toolResult.attachments.length > 1
      ? `Here are ${input.toolResult.attachments.length} files.`
      : input.toolResult.attachment.caption?.trim()
        ? input.toolResult.attachment.caption
        : `Here is ${input.toolResult.attachment.name}.`;
  }

  if (input.toolResult !== null && typeof input.toolResult === "object") {
    const result = input.toolResult as Record<string, unknown>;
    if (input.plan.toolName === "purchase.record") {
      return [
        "PURCHASE RECORDED",
        String(result.productNameSnapshot ?? "Purchase"),
        `${String(result.quantity ?? "")} ${String(result.unit ?? "")}`.trim(),
        `${String(result.currency ?? "KES")} ${String(result.buyingPrice ?? "")} / ${String(result.unit ?? "unit")}`,
        `Supplier: ${String(result.supplierNameSnapshot ?? "—")}`,
        `Agent: ${String(result.contactNameSnapshot ?? "—")}`,
        `Delivered: ${String(result.deliveredAt ?? "—")}`
      ].join("\n");
    }
    if (input.plan.toolName === "purchase.price.change") {
      const current = result.current as Record<string, unknown> | undefined;
      const previous = result.previous as Record<string, unknown> | null | undefined;
      return [
        "BUYING PRICE UPDATED",
        `${String(current?.currency ?? "KES")} ${String(previous?.price ?? "—")} → ${String(current?.price ?? "—")}`,
        "Previous price preserved.",
        `Effective: ${String(current?.effectiveFrom ?? "—")}`
      ].join("\n");
    }
    if (input.plan.toolName === "sale.record") {
      return [
        "CUSTOMER SALE",
        `Customer: ${String(result.customerNameSnapshot ?? result.contactNameSnapshot ?? "Walk-in")}`,
        `Total: ${String(result.currency ?? "KES")} ${String(result.total ?? "")}`,
        `Time: ${String(result.soldAt ?? "—")}`
      ].join("\n");
    }
  }

  if (input.toolResult !== null) {
    return `${input.proposalReason} Done.`;
  }

  return input.proposalReason;
}

function isWorkspaceDeliverResult(value: unknown): value is {
  ok: true;
  attachment: { name: string; caption?: string };
  attachments: Array<{ name: string; caption?: string }>;
} {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.ok !== true || record.attachment === null || typeof record.attachment !== "object") {
    return false;
  }
  return (
    typeof (record.attachment as Record<string, unknown>).name === "string" &&
    Array.isArray(record.attachments) &&
    record.attachments.length > 0
  );
}

export function isCatalogueQueryResult(value: unknown): value is CatalogueQueryResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.query === "string" &&
    Number.isInteger(record.total) &&
    Array.isArray(record.products)
  );
}

/**
 * Extracts customer-facing reply text from a parsed model output for the public storefront path,
 * where no tool has an execution path at all. A "tool" proposal is deliberately never surfaced or
 * executed here — the customer gets a safe hand-off reply instead, matching how
 * createRuntimeResponse never lets a model claim an action happened without a verified result.
 */
export function publicAgentReplyText(
  parsed: ReturnType<typeof parseRuntimeModelOutput>
): string | null {
  if (!parsed.ok || parsed.output === null) return null;
  if (parsed.output.kind === "tool") {
    return "Let me check that with the shop and get back to you.";
  }
  if (parsed.output.kind === "clarification") {
    return parsed.output.proposal.validation.errors[0] ?? "Could you share a bit more detail?";
  }
  return parsed.output.proposal.reason;
}

export function runtimeEvaluationSampled(turnId: string, sampleRate: number): boolean {
  if (sampleRate <= 0) return false;
  if (sampleRate >= 1) return true;
  let hash = 0;
  for (const character of turnId) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash / 0xffffffff < sampleRate;
}

export function normalizeRuntimeLookup(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isChannelProvider(value: unknown): value is ChannelProvider {
  return (
    typeof value === "string" &&
    [
      "grogoni",
      "telegram",
      "whatsapp",
      "messenger",
      "instagram",
      "tiktok",
      "x",
      "sms",
      "native_sms",
      "email"
    ].includes(value)
  );
}

import {
  documentUploadContextScript,
  defaultBusinessAgentContextScripts
} from "./model-catalog.js";
export {
  defaultAiModelId,
  localFallbackAiModelId,
  downloadableAiModelIdPattern,
  documentUploadContextScript,
  defaultBusinessAgentContextScripts,
  aiModelRegistry,
  inferenceRouterSeedModels,
  computeModelAvailability,
  defaultContextCharacterBudget,
  contextWindowCharacterShare,
  estimatedCharactersPerToken,
  contextCharacterBudgetForModel,
  resolveDefaultDeviceModelId
} from "./model-catalog.js";

export function createDefaultBusinessAgentProfile(input: {
  business: BusinessSummary;
  modelId: string;
  updatedAt: string;
  updatedBy: string;
  // Resolved from the DB-hosted agent catalog (Cp2Store.agentCatalog) by the caller, falling back
  // to the hardcoded defaultAgentDefinition when the catalog row is missing - see
  // AgentRuntimeDomainDeps.resolveAgentCatalogEntry. Defaults to that same hardcoded constant so
  // every existing direct caller/test keeps working unchanged.
  agentDefinition?: AgentDefinition;
}): BusinessAgentProfileSummary {
  const definition = input.agentDefinition ?? defaultAgentDefinition;
  const generalInstruction = definition.instructions;
  const toolNames = Object.keys(runtimeToolRegistry) as RuntimeToolName[];
  return {
    businessId: input.business.id,
    tenantId: input.business.id,
    shopId: input.business.id,
    agentId: input.business.id,
    runtimeVersion: 1,
    createdAt: input.updatedAt,
    agentDefinitionId: definition.id,
    name: definition.displayName,
    description: definition.description,
    modelId: input.modelId,
    role: definition.role,
    language: input.business.language,
    personality: definition.personality,
    personalityConfig: defaultAgentPersonality(input.business.language, definition.personality),
    instructions: generalInstruction,
    instructionPolicy: defaultAgentInstructions(generalInstruction),
    knowledge: definition.knowledge,
    tools: [...definition.tools],
    skillBindings: defaultAgentSkillBindings(toolNames),
    integrations: ["Grogoni storefront"],
    contextScripts: [...defaultBusinessAgentContextScripts],
    memoryPolicy: defaultAgentMemoryPolicy(),
    evaluationPolicy: defaultAgentEvaluationPolicy(),
    supportedLanguages:
      input.business.language === "sw" ? ["sw", "en"] : [input.business.language, "sw"],
    businessCategory: "general",
    publicIntroduction: `Welcome to ${input.business.name.trim() || "our shop"}.`,
    status: "active",
    updatedAt: input.updatedAt,
    updatedBy: input.updatedBy
  };
}

export function normalizeBusinessAgentProfile(
  profile: BusinessAgentProfileInput
): NormalizedBusinessAgentProfile {
  if (!isSupportedLanguage(profile.language)) {
    throw new Cp2Error(400, "agent_language_invalid", "Agent language is not supported.");
  }
  if (profile.status !== "active" && profile.status !== "draft") {
    throw new Cp2Error(400, "agent_status_invalid", "Agent status is invalid.");
  }

  const personality = normalizeRequiredBoundedText(profile.personality, "agent personality", 500);
  const instructions = normalizeRequiredBoundedText(
    profile.instructions,
    "agent instructions",
    4000
  );
  return {
    agentDefinitionId:
      profile.agentDefinitionId === undefined
        ? defaultAgentDefinitionId
        : isAgentDefinitionId(profile.agentDefinitionId)
          ? profile.agentDefinitionId
          : (() => {
              throw new Cp2Error(
                400,
                "agent_definition_invalid",
                "Agent definition is not in the approved catalogue."
              );
            })(),
    name: normalizeRequiredBoundedText(profile.name, "agent name", 80),
    description: normalizeRequiredBoundedText(profile.description, "agent description", 500),
    modelId: normalizeRequiredBoundedText(profile.modelId, "model id", 160),
    role: normalizeRequiredBoundedText(profile.role, "agent role", 200),
    language: profile.language,
    personality,
    personalityConfig: normalizeAgentPersonality(
      profile.personalityConfig ?? defaultAgentPersonality(profile.language, personality)
    ),
    instructions,
    instructionPolicy: normalizeAgentInstructions(
      profile.instructionPolicy ?? defaultAgentInstructions(instructions)
    ),
    knowledge: normalizeRequiredBoundedText(profile.knowledge, "agent knowledge", 4000),
    tools: normalizeBoundedTextList(profile.tools, "agent tools", 24, 100),
    skillBindings: normalizeAgentSkillBindings(
      profile.skillBindings ??
        defaultAgentSkillBindings(Object.keys(runtimeToolRegistry) as RuntimeToolName[])
    ),
    integrations: normalizeBoundedTextList(profile.integrations, "agent integrations", 24, 100),
    contextScripts: normalizeBoundedTextList(
      profile.contextScripts,
      "agent context scripts",
      12,
      2400
    ),
    memoryPolicy: normalizeAgentMemoryPolicy(profile.memoryPolicy ?? defaultAgentMemoryPolicy()),
    evaluationPolicy: normalizeAgentEvaluationPolicy(
      profile.evaluationPolicy ?? defaultAgentEvaluationPolicy()
    ),
    supportedLanguages: normalizeSupportedLanguages(
      profile.supportedLanguages ?? [profile.language]
    ),
    businessCategory: normalizeRuntimeOptionalText(
      profile.businessCategory ?? "general",
      "business category",
      120
    ),
    publicIntroduction: normalizeRuntimeOptionalText(
      profile.publicIntroduction ?? profile.description,
      "public introduction",
      500
    ),
    status: profile.status
  };
}

export function hydrateBusinessAgentProfile(
  profile: BusinessAgentProfileSummary
): BusinessAgentProfileSummary {
  const legacy = profile as BusinessAgentProfileSummary &
    Partial<{
      tenantId: string;
      shopId: string;
      agentId: string;
      runtimeVersion: number;
      createdAt: string;
      personalityConfig: AgentPersonality;
      instructionPolicy: AgentInstructions;
      skillBindings: AgentSkillBinding[];
      memoryPolicy: AgentMemoryPolicy;
      evaluationPolicy: AgentEvaluationPolicy;
      supportedLanguages: SupportedLanguage[];
      businessCategory: string;
      publicIntroduction: string;
      agentDefinitionId: AgentDefinitionId;
    }>;
  return {
    ...profile,
    tenantId: legacy.tenantId ?? profile.businessId,
    shopId: legacy.shopId ?? profile.businessId,
    agentId: legacy.agentId ?? profile.businessId,
    runtimeVersion: legacy.runtimeVersion ?? 1,
    createdAt: legacy.createdAt ?? profile.updatedAt,
    agentDefinitionId: isAgentDefinitionId(legacy.agentDefinitionId)
      ? legacy.agentDefinitionId
      : defaultAgentDefinitionId,
    personalityConfig:
      legacy.personalityConfig ?? defaultAgentPersonality(profile.language, profile.personality),
    instructionPolicy: legacy.instructionPolicy ?? defaultAgentInstructions(profile.instructions),
    skillBindings:
      legacy.skillBindings ??
      defaultAgentSkillBindings(Object.keys(runtimeToolRegistry) as RuntimeToolName[]),
    memoryPolicy: legacy.memoryPolicy ?? defaultAgentMemoryPolicy(),
    evaluationPolicy: legacy.evaluationPolicy ?? defaultAgentEvaluationPolicy(),
    supportedLanguages: legacy.supportedLanguages ?? [profile.language],
    businessCategory: legacy.businessCategory ?? "general",
    publicIntroduction: legacy.publicIntroduction ?? profile.description
  };
}

export function normalizeAgentPersonality(value: AgentPersonality): AgentPersonality {
  const allowed = <T extends string>(candidate: T, values: readonly T[], label: string): T => {
    if (!values.includes(candidate)) {
      throw new Cp2Error(400, "agent_personality_invalid", `${label} is invalid.`);
    }
    return candidate;
  };
  if (
    typeof value.confidenceBoundary !== "number" ||
    !Number.isFinite(value.confidenceBoundary) ||
    value.confidenceBoundary < 0 ||
    value.confidenceBoundary > 1
  ) {
    throw new Cp2Error(
      400,
      "agent_confidence_boundary_invalid",
      "Agent confidence boundary must be between 0 and 1."
    );
  }
  return {
    tone: allowed(value.tone, ["warm", "neutral", "direct", "formal"], "Agent tone"),
    formality: allowed(value.formality, ["casual", "balanced", "formal"], "Agent formality"),
    responseLength: allowed(
      value.responseLength,
      ["brief", "balanced", "detailed"],
      "Response length"
    ),
    sellingStyle: allowed(
      value.sellingStyle,
      ["consultative", "informative", "proactive"],
      "Selling style"
    ),
    negotiationStyle: allowed(
      value.negotiationStyle,
      ["fixed", "guided", "flexible"],
      "Negotiation style"
    ),
    greetingStyle: allowed(
      value.greetingStyle,
      ["minimal", "friendly", "formal"],
      "Greeting style"
    ),
    useLocalVocabulary: value.useLocalVocabulary === true,
    preferredLanguageOrder: normalizeSupportedLanguages(value.preferredLanguageOrder),
    humourLevel: allowed(value.humourLevel, ["none", "light", "moderate"], "Humour level"),
    customerCareBehaviour: allowed(
      value.customerCareBehaviour,
      ["concise", "empathetic", "solution_focused"],
      "Customer care behaviour"
    ),
    escalationBehaviour: allowed(
      value.escalationBehaviour,
      ["when_required", "when_uncertain", "owner_first"],
      "Escalation behaviour"
    ),
    confidenceBoundary: value.confidenceBoundary,
    additionalGuidance: normalizeRuntimeOptionalText(
      value.additionalGuidance,
      "personality guidance",
      1000
    )
  };
}

export function normalizeAgentInstructions(value: AgentInstructions): AgentInstructions {
  const normalizeRules = (rules: string[], label: string) =>
    normalizeBoundedTextList(rules, label, 24, 500);
  const maximumDiscountPercent = normalizeBoundedNumber(
    value.maximumDiscountPercent,
    "maximum discount percent",
    0,
    100
  );
  const maximumCreditDays = normalizeBoundedNumber(
    value.maximumCreditDays,
    "maximum credit days",
    0,
    3650
  );
  return {
    generalOperatingRules: normalizeRules(value.generalOperatingRules, "general operating rules"),
    salesRules: normalizeRules(value.salesRules, "sales rules"),
    pricingRules: normalizeRules(value.pricingRules, "pricing rules"),
    maximumDiscountPercent,
    negotiationAllowed: value.negotiationAllowed === true,
    creditSalesAllowed: value.creditSalesAllowed === true,
    maximumCreditDays,
    deliveryRules: normalizeRules(value.deliveryRules, "delivery rules"),
    returnsAndRefundRules: normalizeRules(value.returnsAndRefundRules, "returns and refund rules"),
    inventoryRules: normalizeRules(value.inventoryRules, "inventory rules"),
    supplierRules: normalizeRules(value.supplierRules, "supplier rules"),
    customerPrivacyRules: normalizeRules(value.customerPrivacyRules, "customer privacy rules"),
    escalationRules: normalizeRules(value.escalationRules, "escalation rules"),
    restrictedActions: normalizeRuntimeToolNames(value.restrictedActions, "restricted actions"),
    substituteOutOfStockAllowed: value.substituteOutOfStockAllowed === true,
    ownerApprovalRequiredFor: normalizeRuntimeToolNames(
      value.ownerApprovalRequiredFor,
      "owner approval actions"
    ),
    customerDataRecommendationsAllowed: value.customerDataRecommendationsAllowed === true,
    catalogueModificationAllowed: value.catalogueModificationAllowed === true,
    externalMessagingAllowed: value.externalMessagingAllowed === true
  };
}

export function normalizeAgentSkillBindings(value: AgentSkillBinding[]): AgentSkillBinding[] {
  if (!Array.isArray(value) || value.length > Object.keys(runtimeToolRegistry).length) {
    throw new Cp2Error(400, "agent_skill_bindings_invalid", "Agent skill bindings are invalid.");
  }
  const seen = new Set<string>();
  return value.map((binding) => {
    if (!(binding.skillId in runtimeToolRegistry) || seen.has(binding.skillId)) {
      throw new Cp2Error(
        400,
        "agent_skill_binding_invalid",
        "Each executable skill must be supported and unique."
      );
    }
    seen.add(binding.skillId);
    if (!Number.isSafeInteger(binding.version) || binding.version < 1) {
      throw new Cp2Error(400, "agent_skill_version_invalid", "Agent skill version is invalid.");
    }
    if (
      binding.requiredConfirmationLevel !== "none" &&
      binding.requiredConfirmationLevel !== "owner" &&
      binding.requiredConfirmationLevel !== "explicit"
    ) {
      throw new Cp2Error(
        400,
        "agent_skill_confirmation_invalid",
        "Agent skill confirmation level is invalid."
      );
    }
    if (
      binding.executionEnvironment !== "server" &&
      binding.executionEnvironment !== "browser_worker" &&
      binding.executionEnvironment !== "native"
    ) {
      throw new Cp2Error(
        400,
        "agent_skill_environment_invalid",
        "Agent skill execution environment is invalid."
      );
    }
    return {
      ...binding,
      permissions: normalizeBoundedTextList(
        binding.permissions,
        "agent skill permissions",
        12,
        120
      ),
      allowedIntents: [...new Set(binding.allowedIntents)],
      quotaPerHour:
        binding.quotaPerHour === null
          ? null
          : normalizeBoundedNumber(binding.quotaPerHour, "agent skill quota", 1, 100_000),
      failureCount: normalizeBoundedNumber(
        binding.failureCount,
        "agent skill failure count",
        0,
        1_000_000
      )
    };
  });
}

export function normalizeAgentMemoryPolicy(value: AgentMemoryPolicy): AgentMemoryPolicy {
  return {
    sessionMemoryEnabled: value.sessionMemoryEnabled === true,
    customerConversationMemoryEnabled: value.customerConversationMemoryEnabled === true,
    shopSemanticMemoryEnabled: value.shopSemanticMemoryEnabled === true,
    ownerCorrectionsEnabled: value.ownerCorrectionsEnabled === true,
    reusableWorkflowMemoryEnabled: value.reusableWorkflowMemoryEnabled === true,
    customerMemoryRequiresConsent: value.customerMemoryRequiresConsent !== false,
    retentionDays: normalizeBoundedNumber(value.retentionDays, "memory retention days", 1, 3650),
    maximumItemsPerScope: normalizeBoundedNumber(
      value.maximumItemsPerScope,
      "memory item limit",
      1,
      10_000
    )
  };
}

export function normalizeAgentEvaluationPolicy(
  value: AgentEvaluationPolicy
): AgentEvaluationPolicy {
  return {
    enabled: value.enabled === true,
    sampleRate: normalizeBoundedNumber(value.sampleRate, "evaluation sample rate", 0, 1),
    recordLatency: value.recordLatency === true,
    recordToolOutcomes: value.recordToolOutcomes === true,
    recordPolicyBlocks: value.recordPolicyBlocks === true,
    customerSatisfactionEnabled: value.customerSatisfactionEnabled === true,
    retainDays: normalizeBoundedNumber(value.retainDays, "evaluation retention days", 1, 3650)
  };
}

export function normalizeSupportedLanguages(value: SupportedLanguage[]): SupportedLanguage[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) {
    throw new Cp2Error(
      400,
      "agent_languages_invalid",
      "Agent supported languages must contain one or two languages."
    );
  }
  const languages = [...new Set(value)];
  if (!languages.every(isSupportedLanguage)) {
    throw new Cp2Error(400, "agent_languages_invalid", "Agent language is not supported.");
  }
  return languages;
}

export function normalizeRuntimeToolNames(
  value: RuntimeToolName[],
  label: string
): RuntimeToolName[] {
  if (!Array.isArray(value)) {
    throw new Cp2Error(400, "agent_tool_policy_invalid", `${label} must be an array.`);
  }
  const names = [...new Set(value)];
  if (!names.every((name) => name in runtimeToolRegistry)) {
    throw new Cp2Error(400, "agent_tool_policy_invalid", `${label} contains an unknown tool.`);
  }
  return names;
}

export function normalizeBoundedNumber(
  value: number,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Cp2Error(
      400,
      `${label.replaceAll(" ", "_")}_invalid`,
      `${label} must be between ${minimum} and ${maximum}.`
    );
  }
  return value;
}

export function normalizeRuntimeOptionalText(
  value: string,
  label: string,
  maximumLength: number
): string {
  const normalized = value.trim();
  if (normalized.length > maximumLength) {
    throw new Cp2Error(
      400,
      `${label.replaceAll(" ", "_")}_too_long`,
      `${label} must be ${maximumLength} characters or fewer.`
    );
  }
  return normalized;
}

export function cloneAgentPersonality(value: AgentPersonality): AgentPersonality {
  return { ...value, preferredLanguageOrder: [...value.preferredLanguageOrder] };
}

export function cloneAgentInstructions(value: AgentInstructions): AgentInstructions {
  return {
    ...value,
    generalOperatingRules: [...value.generalOperatingRules],
    salesRules: [...value.salesRules],
    pricingRules: [...value.pricingRules],
    deliveryRules: [...value.deliveryRules],
    returnsAndRefundRules: [...value.returnsAndRefundRules],
    inventoryRules: [...value.inventoryRules],
    supplierRules: [...value.supplierRules],
    customerPrivacyRules: [...value.customerPrivacyRules],
    escalationRules: [...value.escalationRules],
    restrictedActions: [...value.restrictedActions],
    ownerApprovalRequiredFor: [...value.ownerApprovalRequiredFor]
  };
}

export function cloneAgentSkillBinding(value: AgentSkillBinding): AgentSkillBinding {
  return {
    ...value,
    permissions: [...value.permissions],
    allowedIntents: [...value.allowedIntents]
  };
}

export function contextSourceRecord(input: {
  id: string;
  businessId: string;
  type: AgentContextSource["type"];
  title: string;
  content: string | null;
  sensitivity: AgentContextSource["sensitivity"];
  customerVisible: boolean;
  sourceRecordId: string | null;
  now: Date;
  /** Explicit evidence confidence/provenance override - see EvidenceProvenance. Omitted for every
   *  canonical-record-backed source, which derives it automatically at retrieval time instead
   *  (services/api/src/cp2/agent-business-runtime.ts). Required for a synthesized non-canonical
   *  source (e.g. a "recall" entry) whose confidence should never look like a canonical record's. */
  confidence?: number | null;
  provenance?: EvidenceProvenance;
}): AgentContextSource {
  return {
    id: input.id,
    tenantId: input.businessId,
    shopId: input.businessId,
    type: input.type,
    title: input.title,
    status: "active",
    sensitivity: input.sensitivity,
    accessRules: {
      audiences: input.customerVisible ? ["owner", "staff", "customer"] : ["owner", "staff"],
      requiredPermission: input.customerVisible ? null : "business:read",
      customerVisible: input.customerVisible
    },
    freshnessTimestamp: input.now.toISOString(),
    version: 1,
    retrievalMetadata: {
      keywords: contextKeywords(`${input.title} ${input.content ?? ""}`),
      sourceRecordId: input.sourceRecordId,
      content: input.content,
      ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
      ...(input.provenance === undefined ? {} : { provenance: input.provenance })
    },
    createdAt: input.now.toISOString(),
    updatedAt: input.now.toISOString(),
    deletedAt: null
  };
}

/**
 * Independent corroborating turns required before a candidate RuntimeExperience is trusted enough
 * to be surfaced into a prompt (brief-adoption §15: "prefer repeated evidence before promoting
 * general lessons"). Deliberately small and fixed rather than configurable in this pass - see
 * docs/architecture/experience-memory.md for the rationale.
 */
export const runtimeExperienceValidationThreshold = 2;

export interface RuntimeExperienceTelemetryEvent {
  state: "recall.candidate_generated" | "recall.deduplicated" | "recall.persisted";
  metadata: Record<string, string | number | boolean | null>;
}

/**
 * Pure state transition for structured experience extraction (brief-adoption §8/§9/§15) - computes
 * the next `RuntimeExperience` row and the telemetry events it produces, without touching a Map, so
 * the corroboration/promotion decision is unit-testable independent of `Cp2Store`. `existing` is the
 * caller's current same-`lessonKey`, non-deprecated row for this business, if any (the caller does
 * the lookup, since only it knows the storage shape).
 */
export function nextRuntimeExperienceState(
  existing: RuntimeExperience | null,
  input: {
    id: string;
    businessId: string;
    agentId: string;
    turnId: string;
    intent: RuntimeParserIntent;
    recipeId: string | null;
    recipeVersion: number | null;
    evidenceRefs: string[];
    toolName: RuntimeToolName;
    fallbackReason: string;
    now: Date;
  }
): { experience: RuntimeExperience; telemetryEvents: RuntimeExperienceTelemetryEvent[] } {
  const lessonKey = `fallback:${input.intent}:${input.fallbackReason}`;
  const nowIso = input.now.toISOString();
  if (existing !== null) {
    const corroborationCount = existing.corroborationCount + 1;
    const wasValidated = existing.validationState === "validated";
    const validationState: RuntimeExperience["validationState"] =
      corroborationCount >= runtimeExperienceValidationThreshold
        ? "validated"
        : existing.validationState;
    const experience: RuntimeExperience = {
      ...existing,
      corroborationCount,
      validationState,
      sourceTurnId: input.turnId,
      updatedAt: nowIso
    };
    const telemetryEvents: RuntimeExperienceTelemetryEvent[] = [
      {
        state: "recall.deduplicated",
        metadata: { experienceId: experience.id, lessonKey, corroborationCount }
      }
    ];
    if (validationState === "validated" && !wasValidated) {
      telemetryEvents.push({
        state: "recall.persisted",
        metadata: { experienceId: experience.id, lessonKey, validationState }
      });
    }
    return { experience, telemetryEvents };
  }
  const experience: RuntimeExperience = {
    id: input.id,
    tenantId: input.businessId,
    shopId: input.businessId,
    agentId: input.agentId,
    taskType: input.intent,
    situation: `A "${input.intent}" request needed a fallback model after the primary model failed (${input.fallbackReason}).`,
    lessonKey,
    recipeId: input.recipeId,
    recipeVersion: input.recipeVersion,
    evidenceRefs: input.evidenceRefs,
    toolSequence: [input.toolName],
    resultType: input.toolName,
    verificationResult: "ok",
    outcome: "successful",
    lesson: `For "${input.intent}" requests, the primary model has failed with ${input.fallbackReason}; the configured fallback model completed the request successfully when this happened.`,
    validationState: "candidate",
    corroborationCount: 1,
    sourceTurnId: input.turnId,
    createdAt: nowIso,
    updatedAt: nowIso,
    deprecatedAt: null
  };
  return {
    experience,
    telemetryEvents: [
      { state: "recall.candidate_generated", metadata: { experienceId: experience.id, lessonKey } }
    ]
  };
}

export function contextKeywords(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu)
        ?.filter((term) => term.length > 2) ?? []
    )
  ].slice(0, 40);
}

export function stableUuid(seed: string): string {
  const value = createHash("sha256").update(seed).digest("hex");
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    `4${value.slice(13, 16)}`,
    `8${value.slice(17, 20)}`,
    value.slice(20, 32)
  ].join("-");
}

export function cloneAgentContextSource(source: AgentContextSource): AgentContextSource {
  return {
    ...source,
    accessRules: {
      ...source.accessRules,
      audiences: [...source.accessRules.audiences]
    },
    retrievalMetadata: {
      ...source.retrievalMetadata,
      keywords: [...source.retrievalMetadata.keywords]
    }
  };
}

export function cloneShopAgentRuntime(runtime: ShopAgentRuntime): ShopAgentRuntime {
  return {
    ...runtime,
    identity: {
      ...runtime.identity,
      supportedLanguages: [...runtime.identity.supportedLanguages]
    },
    personality: cloneAgentPersonality(runtime.personality),
    instructions: cloneAgentInstructions(runtime.instructions),
    context: {
      ...runtime.context,
      sources: runtime.context.sources.map(cloneAgentContextSource)
    },
    skills: runtime.skills.map(cloneAgentSkillBinding),
    memory: { ...runtime.memory },
    evaluations: { ...runtime.evaluations },
    model: { ...runtime.model }
  };
}

export function cloneAgentRuntimeVersion(version: AgentRuntimeVersion): AgentRuntimeVersion {
  return {
    ...version,
    runtime: cloneShopAgentRuntime(version.runtime)
  };
}

export function normalizeBoundedTextList(
  values: string[],
  label: string,
  maximumItems: number,
  maximumItemLength: number
): string[] {
  if (!Array.isArray(values) || values.length > maximumItems) {
    throw new Cp2Error(
      400,
      `${label.replaceAll(" ", "_")}_invalid`,
      `${label} must contain ${maximumItems} items or fewer.`
    );
  }

  return values.map((value, index) =>
    normalizeRequiredBoundedText(value, `${label} item ${index + 1}`, maximumItemLength)
  );
}

export function cloneBusinessAgentProfile(
  profile: BusinessAgentProfileSummary
): BusinessAgentProfileSummary {
  const hydrated = hydrateBusinessAgentProfile(profile);
  return {
    ...hydrated,
    personalityConfig: cloneAgentPersonality(hydrated.personalityConfig),
    instructionPolicy: cloneAgentInstructions(hydrated.instructionPolicy),
    skillBindings: hydrated.skillBindings.map(cloneAgentSkillBinding),
    memoryPolicy: { ...hydrated.memoryPolicy },
    evaluationPolicy: { ...hydrated.evaluationPolicy },
    supportedLanguages: [...hydrated.supportedLanguages],
    tools: [...hydrated.tools],
    integrations: [...hydrated.integrations],
    contextScripts: [...hydrated.contextScripts]
  };
}

export function normalizeModelCatalogSearch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function cloneInstalledAgentModel(
  model: InstalledAgentModelSummary
): InstalledAgentModelSummary {
  return { ...model };
}

export function validateAgentModelBindingConfiguration(
  input: {
    modelId: string;
    executionTarget: ModelExecutionTarget;
    executionMode: PreferredExecutionMode;
    permissions: AgentModelBindingPermissions;
  },
  model: AiModelSummary
): void {
  // A "hosted" model has no downloadable artifact (format: "remote") - it can only run through a
  // generic server-reachable target (Vercel today; a self-hosted backend adapter remains a valid
  // alternative), never a target that requires local weights/installation on the merchant's own
  // device. This does not run the other way: a downloadable model can also legitimately be served
  // through any server-reachable target.
  if (model.source === "hosted" && input.executionTarget === "remote-shop-device") {
    throw new Cp2Error(
      409,
      "MODEL_RUNTIME_INCOMPATIBLE",
      "The selected hosted model must use a server-reachable execution target."
    );
  }
  if (input.executionMode === "CLOUD_ONLY" && input.executionTarget === "remote-shop-device") {
    throw new Cp2Error(
      400,
      "MODEL_CONFIGURATION_INVALID",
      "Cloud-only execution requires a server-reachable execution target."
    );
  }
  if (input.executionTarget === "browser-local" || input.executionTarget === "installed-app") {
    // Device-local execution is an explicit property of the catalog model (its inference block),
    // never something a hosted model can be switched onto (ADR-explicit-device-local-models.md).
    if (model.inference?.executionTarget !== input.executionTarget) {
      throw new Cp2Error(
        409,
        "MODEL_RUNTIME_INCOMPATIBLE",
        "This model does not run on-device. Choose one of the on-device models instead."
      );
    }
    if (input.executionMode === "CLOUD_ONLY") {
      throw new Cp2Error(
        400,
        "MODEL_CONFIGURATION_INVALID",
        "Cloud-only execution cannot use an on-device model."
      );
    }
  }
  if (input.executionTarget === "remote-shop-device" && !input.permissions.allowRemoteShopDevice) {
    throw new Cp2Error(
      403,
      "POLICY_DENIED",
      "Remote shop-device inference is not permitted by this binding."
    );
  }
}

export function healthSummary(
  health: Awaited<ReturnType<ModelRuntimeAdapter["healthCheck"]>>,
  now: Date
): ModelRuntimeHealthSummary {
  return {
    ok: health.available,
    modelId: health.modelId,
    provider: health.provider,
    executionTarget: health.executionTarget,
    latencyMs: health.latencyMs,
    responsePreview: health.responsePreview,
    errorCode: health.errorCode,
    errorMessage: health.message,
    retryable: health.retryable,
    checkedAt: now.toISOString()
  };
}

export function modelHealthError(health: ModelRuntimeHealthSummary): Cp2Error {
  const code = health.errorCode ?? "MODEL_HEALTH_CHECK_FAILED";
  const statusCode =
    code === "INFERENCE_TIMEOUT"
      ? 504
      : code === "INFERENCE_CANCELLED"
        ? 408
        : isUnavailableRuntimeCode(code)
          ? 503
          : code === "MODEL_IDENTITY_MISMATCH"
            ? 422
            : 422;
  return new Cp2Error(
    statusCode,
    code,
    health.errorMessage ?? "The selected model did not pass its inference health check.",
    health.retryable,
    {
      modelId: health.modelId,
      executionTarget: health.executionTarget,
      latencyMs: health.latencyMs
    }
  );
}

export function isUnavailableRuntimeCode(code: string | null): boolean {
  return (
    code !== null &&
    [
      "RUNTIME_UNAVAILABLE",
      "RUNTIME_NOT_CONFIGURED",
      "INFERENCE_DISABLED",
      "INFERENCE_SERVICE_UNREACHABLE",
      "INFERENCE_ENGINE_UNREACHABLE",
      "INFERENCE_AUTHENTICATION_FAILED",
      "MODEL_NOT_INSTALLED",
      "MODEL_LOADING",
      "MODEL_NOT_LOADED",
      "MODEL_STORAGE_NOT_DURABLE"
    ].includes(code)
  );
}

export function normalizeInstalledAgentModel(
  input: Omit<InstalledAgentModelSummary, "accountId" | "userId">,
  accountId: string,
  userId: string
): InstalledAgentModelSummary {
  const installationStatuses = new Set<InstalledAgentModelSummary["installationStatus"]>([
    "DOWNLOADING",
    "INSTALLED",
    "CORRUPT",
    "REMOVED",
    "FAILED"
  ]);
  const compatibilityStatuses = new Set<InstalledAgentModelSummary["compatibilityStatus"]>([
    "UNKNOWN",
    "COMPATIBLE",
    "INCOMPATIBLE",
    "INSUFFICIENT_MEMORY",
    "UNSUPPORTED_ARCHITECTURE",
    "UNSUPPORTED_QUANTIZATION"
  ]);
  const runtimeBackends = new Set<AgentModelRuntimeBackend>([
    "LLAMA_CPP_ANDROID",
    "LLAMA_CPP_BROWSER",
    "OLLAMA",
    "CLOUD"
  ]);
  if (!installationStatuses.has(input.installationStatus)) {
    throw new Cp2Error(400, "model_installation_status_invalid", "Installation status is invalid.");
  }
  if (!compatibilityStatuses.has(input.compatibilityStatus)) {
    throw new Cp2Error(
      400,
      "model_compatibility_status_invalid",
      "Compatibility status is invalid."
    );
  }
  if (!runtimeBackends.has(input.runtimeBackend)) {
    throw new Cp2Error(400, "model_runtime_backend_invalid", "Runtime backend is invalid.");
  }
  if (
    input.provider !== "huggingface" &&
    input.provider !== "github" &&
    input.provider !== "custom"
  ) {
    throw new Cp2Error(400, "model_provider_invalid", "Model provider is invalid.");
  }
  if (input.format !== "GGUF") {
    throw new Cp2Error(400, "model_format_invalid", "Only GGUF installations are supported.");
  }
  if (!Number.isSafeInteger(input.fileSizeBytes) || input.fileSizeBytes < 4) {
    throw new Cp2Error(400, "model_file_size_invalid", "Model file size is invalid.");
  }
  const normalizeNullable = (
    value: string | null,
    label: string,
    maximum: number
  ): string | null => (value === null ? null : normalizeRequiredBoundedText(value, label, maximum));
  const normalizeNullableCount = (value: number | null, label: string): number | null => {
    if (value === null) return null;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Cp2Error(400, `${label.replaceAll(" ", "_")}_invalid`, `${label} is invalid.`);
    }
    return value;
  };
  const rawChecksum = normalizeNullable(input.checksum, "model checksum", 160);
  const checksum =
    rawChecksum === null
      ? null
      : rawChecksum
          .trim()
          .toLowerCase()
          .replace(/^sha256:/, "");
  if (checksum !== null && !/^[a-f0-9]{64}$/u.test(checksum)) {
    throw new Cp2Error(400, "model_checksum_invalid", "Model checksum must be a SHA-256 digest.");
  }
  const packageManifestVersion = normalizeNullable(
    input.packageManifestVersion ?? null,
    "model package manifest version",
    40
  );
  const packageSignature = normalizeNullable(
    input.packageSignature ?? null,
    "model package signature",
    240
  );
  const packageSigningKeyId = normalizeNullable(
    input.packageSigningKeyId ?? null,
    "model package signing key id",
    160
  );
  const packageFieldCount = [packageManifestVersion, packageSignature, packageSigningKeyId].filter(
    (value) => value !== null
  ).length;
  if (packageFieldCount !== 0 && packageFieldCount !== 3) {
    throw new Cp2Error(
      400,
      "model_package_incomplete",
      "Signed model packages require a manifest version, signature, and signing key ID."
    );
  }
  if (packageFieldCount === 3 && packageManifestVersion !== "1.0") {
    throw new Cp2Error(
      409,
      "model_package_version_unsupported",
      "The model package manifest version is unsupported."
    );
  }
  if (packageFieldCount === 3 && checksum === null) {
    throw new Cp2Error(
      400,
      "model_package_checksum_required",
      "Signed model packages require a pinned SHA-256 checksum."
    );
  }
  return {
    id: normalizeRequiredBoundedText(input.id, "model installation id", 160),
    accountId,
    userId,
    deviceId: normalizeRequiredBoundedText(input.deviceId, "device id", 160),
    modelId: normalizeRequiredBoundedText(input.modelId, "model id", 200),
    displayName: normalizeRequiredBoundedText(input.displayName, "model display name", 160),
    provider: input.provider,
    repositoryId: normalizeNullable(input.repositoryId, "model repository id", 240),
    filename: normalizeRequiredBoundedText(input.filename, "model filename", 240),
    format: "GGUF",
    quantization: normalizeNullable(input.quantization, "model quantization", 80),
    architecture: normalizeNullable(input.architecture, "model architecture", 80),
    parameterCount: normalizeNullableCount(input.parameterCount, "model parameter count"),
    contextLength: normalizeNullableCount(input.contextLength, "model context length"),
    fileSizeBytes: input.fileSizeBytes,
    checksum,
    packageManifestVersion,
    packageSignature,
    packageSigningKeyId,
    license: normalizeRequiredBoundedText(input.license, "model license", 160),
    commercialUseAllowed: input.commercialUseAllowed === true,
    storageKey: normalizeRequiredBoundedText(input.storageKey, "private storage key", 240),
    runtimeBackend: input.runtimeBackend,
    installationStatus: input.installationStatus,
    compatibilityStatus: input.compatibilityStatus,
    installedAt: normalizeRequiredBoundedText(input.installedAt, "model installed at", 80),
    lastVerifiedAt:
      input.lastVerifiedAt === null
        ? null
        : normalizeRequiredBoundedText(input.lastVerifiedAt, "model verified at", 80),
    validationError: normalizeNullable(input.validationError, "model validation error", 120)
  };
}

export function normalizeExecutionMode(mode: PreferredExecutionMode): PreferredExecutionMode {
  if (mode === "LOCAL_ONLY" || mode === "LOCAL_FIRST") return mode;
  if (mode === "CLOUD_ONLY") return "LOCAL_FIRST";
  throw new Cp2Error(400, "execution_mode_invalid", "Execution mode is invalid.");
}

export function ensureRequiredAgentContextScripts(scripts: string[]): string[] {
  if (scripts.some((script) => script.includes("script: document_upload_guardrails"))) {
    return [...scripts];
  }

  return [...scripts.slice(0, 11), documentUploadContextScript];
}

export function runtimeAgentProfileFromStored(
  profile: BusinessAgentProfileSummary,
  activeModelId: string
): RuntimeAgentProfile {
  return {
    behavior: profile.personality,
    contextScripts: ensureRequiredAgentContextScripts(profile.contextScripts),
    integrations: [...profile.integrations],
    knowledge: profile.knowledge,
    model: activeModelId,
    role: profile.role,
    instructions: profile.instructions,
    tools: [...profile.tools]
  };
}
