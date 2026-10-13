import type {
  ActiveNativeAgentBinding,
  AgentAudience,
  AgentContextSource,
  AgentOwnerCorrection,
  RuntimeExperience,
  ShopAgentRuntime
} from "@grogoni/shared-types";

import type { AgentRuntimeDomainDeps } from "./domain-deps.js";
import {
  cloneAgentContextSource,
  cloneAgentInstructions,
  cloneAgentPersonality,
  cloneAgentSkillBinding,
  contextSourceRecord,
  downloadableAiModelIdPattern,
  stableUuid,
  type BusinessAgentProfileSummary
} from "./shared.js";

interface ShopRuntimeState {
  deps: AgentRuntimeDomainDeps;
  activeBinding: ActiveNativeAgentBinding | null;
  contextSources: AgentContextSource[];
}

interface RuntimeContextSourcesState {
  deps: AgentRuntimeDomainDeps;
  agentContextSources: Map<string, AgentContextSource>;
  ownerCorrections: AgentOwnerCorrection[];
  runtimeExperiences: RuntimeExperience[];
}

export function buildShopAgentRuntime(
  state: ShopRuntimeState,
  profile: BusinessAgentProfileSummary,
  now: Date,
  audience: AgentAudience,
  modelId = profile.modelId
): ShopAgentRuntime {
  const business = state.deps.requireBusiness(profile.businessId);
  const activeBinding = state.activeBinding;
  const model = state.deps.resolveCatalogModel(modelId);
  const sources = state.contextSources.filter((source) =>
    source.accessRules.audiences.includes(audience)
  );
  return {
    agentId: profile.agentId,
    shopId: profile.shopId,
    tenantId: profile.tenantId,
    identity: {
      agentName: profile.name,
      shopName: business.name,
      shopIdentifier: business.grogoniId,
      role: profile.role,
      supportedLanguages: [...profile.supportedLanguages],
      shopDescription: profile.description,
      businessCategory: profile.businessCategory,
      publicIntroduction: profile.publicIntroduction
    },
    personality: cloneAgentPersonality(profile.personalityConfig),
    instructions: cloneAgentInstructions(profile.instructionPolicy),
    context: {
      tenantId: profile.tenantId,
      shopId: profile.shopId,
      generatedAt: now.toISOString(),
      sources: sources.map(cloneAgentContextSource)
    },
    skills: profile.skillBindings.map(cloneAgentSkillBinding),
    memory: { ...profile.memoryPolicy },
    evaluations: { ...profile.evaluationPolicy },
    model: {
      modelId: activeBinding?.model.id ?? modelId,
      provider:
        activeBinding?.executionTarget ??
        model?.provider ??
        (downloadableAiModelIdPattern.test(modelId) ? "device" : "deterministic"),
      executionMode: "CLOUD_ONLY",
      deviceAssignmentId: null
    },
    version: profile.runtimeVersion,
    status: profile.status,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
  };
}

export function contextSourcesForRuntime(
  state: RuntimeContextSourcesState,
  profile: BusinessAgentProfileSummary
): AgentContextSource[] {
  const businessId = profile.businessId;
  const recallRetentionBoundary =
    Date.now() - profile.memoryPolicy.retentionDays * 24 * 60 * 60 * 1000;
  const sources = [...state.agentContextSources.values()]
    .filter(
      (source) =>
        source.shopId === businessId &&
        source.deletedAt === null &&
        (source.type !== "recall" ||
          (profile.memoryPolicy.reusableWorkflowMemoryEnabled &&
            Date.parse(source.updatedAt) >= recallRetentionBoundary))
    )
    .map(cloneAgentContextSource);
  if (!sources.some((source) => source.type === "context_script")) {
    sources.push(
      ...profile.contextScripts.map((content, index) =>
        contextSourceRecord({
          id: stableUuid(`${businessId}:context-script:${index}`),
          businessId,
          type: "context_script",
          title: `Context script ${index + 1}`,
          content,
          sensitivity: "internal",
          customerVisible: false,
          sourceRecordId: null,
          now: new Date(profile.updatedAt)
        })
      )
    );
  }
  sources.push(
    contextSourceRecord({
      id: stableUuid(`${businessId}:policy`),
      businessId,
      type: "policy",
      title: "Structured business policy",
      content: [
        ...profile.instructionPolicy.generalOperatingRules,
        ...profile.instructionPolicy.salesRules,
        ...profile.instructionPolicy.pricingRules
      ].join("\n"),
      sensitivity: "internal",
      customerVisible: false,
      sourceRecordId: profile.agentId,
      now: new Date(profile.updatedAt)
    })
  );
  for (const product of [...state.deps.products.values()].filter(
    (product) => product.businessId === businessId
  )) {
    sources.push(
      contextSourceRecord({
        id: stableUuid(`${businessId}:catalogue:${product.id}`),
        businessId,
        type: "catalogue",
        title: product.name,
        content: `${product.name}; unit=${product.unit}; price=${product.sellingPrice ?? "not set"}`,
        sensitivity: "public",
        customerVisible: true,
        sourceRecordId: product.id,
        now: new Date(product.updatedAt)
      }),
      contextSourceRecord({
        id: stableUuid(`${businessId}:inventory:${product.id}`),
        businessId,
        type: "inventory",
        title: `${product.name} inventory`,
        content: `${product.name}; quantity=${product.quantity}`,
        sensitivity: "internal",
        customerVisible: false,
        sourceRecordId: product.id,
        now: new Date(product.updatedAt)
      })
    );
  }
  const references: Array<{
    type: AgentContextSource["type"];
    title: string;
    id: string;
    updatedAt: string;
    sensitivity: AgentContextSource["sensitivity"];
  }> = [
    ...[...state.deps.customers.values()]
      .filter((customer) => customer.businessId === businessId)
      .map((item) => ({
        type: "customer" as const,
        title: item.name,
        id: item.id,
        updatedAt: item.updatedAt,
        sensitivity: "confidential" as const
      })),
    ...state.deps.suppliersForBusiness(businessId).map((item) => ({
      type: "supplier" as const,
      title: item.name,
      id: item.id,
      updatedAt: item.updatedAt,
      sensitivity: "confidential" as const
    })),
    ...[...state.deps.purchaseReceipts.values()]
      .filter((item) => item.businessId === businessId)
      .map((item) => ({
        type: "receipt" as const,
        title: `Receipt ${item.id}`,
        id: item.id,
        updatedAt: item.createdAt,
        sensitivity: "restricted" as const
      })),
    ...[...state.deps.invoices.values()]
      .filter((invoice) => invoice.businessId === businessId)
      .map((item) => ({
        type: "order" as const,
        title: item.invoiceNumber,
        id: item.id,
        updatedAt: item.updatedAt,
        sensitivity: "confidential" as const
      }))
  ];
  for (const reference of references) {
    sources.push(
      contextSourceRecord({
        id: stableUuid(`${businessId}:${reference.type}:${reference.id}`),
        businessId,
        type: reference.type,
        title: reference.title,
        content: null,
        sensitivity: reference.sensitivity,
        customerVisible: false,
        sourceRecordId: reference.id,
        now: new Date(reference.updatedAt)
      })
    );
  }
  for (const correction of state.ownerCorrections.filter((item) => item.status === "active")) {
    sources.push(
      contextSourceRecord({
        id: correction.id,
        businessId,
        type: "owner_note",
        title: `Owner correction: ${correction.category}`,
        content: correction.correction,
        sensitivity: "internal",
        customerVisible: false,
        sourceRecordId: correction.id,
        now: new Date(correction.createdAt)
      })
    );
  }
  // Structured experience memory (docs/architecture/experience-memory.md), following the format
  // context/agent/recall.md already specified: Trigger / Learned behavior / Failure avoided. Only
  // ever built from `state.runtimeExperiences`, which the caller has already filtered to
  // validationState === "validated" (contextSourcesForRuntime -> validatedRuntimeExperiencesForBusiness,
  // store.ts) - a "candidate" experience is never synthesized into a source here.
  for (const experience of profile.memoryPolicy.reusableWorkflowMemoryEnabled
    ? state.runtimeExperiences
    : []) {
    // Task-scoped advice requires exact environment and constraint matching, not generic recall.
    if (experience.environmentScope !== undefined || experience.agentId !== profile.agentId)
      continue;
    sources.push(
      contextSourceRecord({
        id: experience.id,
        businessId,
        type: "recall",
        title: `Recall: ${experience.taskType}`,
        content: [
          `Trigger: ${experience.situation}`,
          `Learned behavior: ${experience.lesson}`,
          "Failure avoided: an unanswered or failed request."
        ].join("\n"),
        sensitivity: "internal",
        customerVisible: false,
        sourceRecordId: experience.id,
        now: new Date(experience.updatedAt),
        confidence: Math.min(1, experience.corroborationCount / 2),
        provenance: { resolver: "model_recall", sourceType: "recall", sourceId: experience.id }
      })
    );
  }
  return sources
    .filter(
      (source, index, all) => all.findIndex((candidate) => candidate.id === source.id) === index
    )
    .sort(
      (left, right) => left.type.localeCompare(right.type) || left.title.localeCompare(right.title)
    );
}
