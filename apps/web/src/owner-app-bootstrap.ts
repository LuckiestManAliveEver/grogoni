import type {
  AgentEvaluationPolicy,
  AgentInstructions,
  AgentMemoryPolicy,
  AgentPersonality,
  AgentSkillBinding,
  ProductFieldDefinition,
  ProductFieldInputType
} from "@grogoni/shared-types";
import {
  defaultAgentDefinition,
  defaultAgentDefinitionId,
  isAgentDefinitionId
} from "@grogoni/shared-types";
import { type GrogoniMode } from "./app-shell";

import {
  type ActiveBusiness,
  type AgentModel,
  type AgentSettings,
  type BusinessAgentProfileSummary,
  type OwnerAuthRecord,
  type PendingOAuthLogin,
  type ProductFieldDraft,
  type SetupDraft,
  type SupportedLanguage,
  activeAgentStorageKey,
  activeBusinessStorageKey,
  activeModeStorageKey,
  defaultAgentContextScripts,
  documentUploadContextScript,
  legacyActiveBusinessStorageKey,
  ownerAuthStorageKey,
  pendingOAuthStorageKey,
  setupDraftStorageKey
} from "./grogoni-application-shared";

import { isGrogoniId, normalizeGrogoniId, createStorefrontUrl } from "./grogoniid-and-storefront";
import { inferCountryCode, isCountryDialCode, isSocialSignupProvider } from "./country-dial-codes";

export function readStoredBusiness(): ActiveBusiness | null {
  const stored =
    localStorage.getItem(activeBusinessStorageKey) ??
    localStorage.getItem(legacyActiveBusinessStorageKey);

  if (stored === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(stored) as ActiveBusiness;

    if (
      typeof parsed.id === "string" &&
      typeof parsed.name === "string" &&
      (parsed.language === "en" || parsed.language === "sw") &&
      typeof parsed.role === "string" &&
      isGrogoniId(parsed.grogoniId)
    ) {
      return {
        ...parsed,
        grogoniId: normalizeGrogoniId(parsed.grogoniId)
      };
    }
  } catch {
    // Invalid persisted data is removed below as well.
  }

  localStorage.removeItem(activeBusinessStorageKey);
  localStorage.removeItem(legacyActiveBusinessStorageKey);
  return null;
}

export function readStoredGrogoniMode(): GrogoniMode {
  return localStorage.getItem(activeModeStorageKey) === "seller" ? "seller" : "marketplace";
}

export function readStoredAgent(): AgentSettings | null {
  const stored = localStorage.getItem(activeAgentStorageKey);

  if (stored === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(stored) as AgentSettings;

    if (
      typeof parsed.id === "string" &&
      typeof parsed.name === "string" &&
      typeof parsed.description === "string" &&
      isAgentModel(parsed.model) &&
      typeof parsed.role === "string" &&
      typeof parsed.globalAgentId === "string" &&
      typeof parsed.storefrontUrl === "string" &&
      (parsed.language === "en" || parsed.language === "sw") &&
      typeof parsed.personality === "string" &&
      typeof parsed.instructions === "string" &&
      typeof parsed.knowledge === "string" &&
      Array.isArray(parsed.tools) &&
      Array.isArray(parsed.integrations)
    ) {
      const fallbackPersonality = defaultWebAgentPersonality(parsed.language, parsed.personality);
      const fallbackInstructions = defaultWebAgentInstructions(parsed.instructions);
      const storedAgentDefinitionId = (parsed as Partial<AgentSettings>).agentDefinitionId;
      return {
        ...parsed,
        agentDefinitionId: isAgentDefinitionId(storedAgentDefinitionId)
          ? storedAgentDefinitionId
          : defaultAgentDefinitionId,
        personalityConfig: parsed.personalityConfig ?? fallbackPersonality,
        instructionPolicy: parsed.instructionPolicy ?? fallbackInstructions,
        skillBindings: Array.isArray(parsed.skillBindings)
          ? parsed.skillBindings
          : defaultWebAgentSkills(),
        memoryPolicy: parsed.memoryPolicy ?? defaultWebAgentMemoryPolicy(),
        evaluationPolicy: parsed.evaluationPolicy ?? defaultWebAgentEvaluationPolicy(),
        supportedLanguages: Array.isArray(parsed.supportedLanguages)
          ? parsed.supportedLanguages
          : [parsed.language],
        businessCategory:
          typeof parsed.businessCategory === "string" ? parsed.businessCategory : "general",
        publicIntroduction:
          typeof parsed.publicIntroduction === "string"
            ? parsed.publicIntroduction
            : parsed.description,
        runtimeVersion:
          typeof parsed.runtimeVersion === "number" && parsed.runtimeVersion > 0
            ? parsed.runtimeVersion
            : 1,
        contextScripts: Array.isArray(parsed.contextScripts)
          ? ensureRequiredAgentContextScripts(sanitizeContextScripts(parsed.contextScripts))
          : defaultAgentContextScripts
      };
    }
  } catch {
    localStorage.removeItem(activeAgentStorageKey);
  }

  return null;
}

export function readStoredOwnerAuth(): OwnerAuthRecord | null {
  const stored = localStorage.getItem(ownerAuthStorageKey);

  if (stored === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(stored) as OwnerAuthRecord;

    if (typeof parsed.contact === "string" && isCountryDialCode(parsed.countryCode)) {
      return {
        contact: parsed.contact,
        countryCode: parsed.countryCode,
        ...(isSocialSignupProvider(parsed.provider) ? { provider: parsed.provider } : {})
      };
    }
  } catch {
    localStorage.removeItem(ownerAuthStorageKey);
  }

  return null;
}

export function readPendingOAuthLogin(): PendingOAuthLogin | null {
  const stored = sessionStorage.getItem(pendingOAuthStorageKey);

  if (stored === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(stored) as PendingOAuthLogin;

    if (
      isSocialSignupProvider(parsed.provider) &&
      typeof parsed.state === "string" &&
      parsed.state.length > 0 &&
      typeof parsed.csrfToken === "string" &&
      parsed.csrfToken.length > 0
    ) {
      return parsed;
    }
  } catch {
    sessionStorage.removeItem(pendingOAuthStorageKey);
  }

  return null;
}

export function readSetupDraft(): SetupDraft | null {
  const stored = localStorage.getItem(setupDraftStorageKey);

  if (stored === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(stored) as Partial<SetupDraft> & { destination?: unknown };

    if (
      typeof parsed.businessName === "string" &&
      (parsed.language === "en" || parsed.language === "sw")
    ) {
      return {
        countryCode: isCountryDialCode(parsed.countryCode)
          ? parsed.countryCode
          : typeof parsed.destination === "string"
            ? (inferCountryCode(parsed.destination) ?? "+254")
            : "+254",
        businessName: parsed.businessName,
        language: parsed.language,
        completedStep: parsed.completedStep === 2 ? 2 : 1
      };
    }
  } catch {
    localStorage.removeItem(setupDraftStorageKey);
  }

  return null;
}

export function createDefaultAgent(business: ActiveBusiness | null): AgentSettings {
  const businessName = business?.name.trim() || "Grogoni";
  const globalAgentId = business === null ? "local-grogoni" : normalizeGrogoniId(business.grogoniId);

  const generalInstruction = defaultAgentDefinition.instructions;
  const personality = defaultAgentDefinition.personality;
  return {
    agentDefinitionId: defaultAgentDefinitionId,
    id: `agent-${globalAgentId}`,
    name: defaultAgentDefinition.displayName,
    description: defaultAgentDefinition.description,
    model: "qwen2.5-0.5b-android",
    role: defaultAgentDefinition.role,
    globalAgentId,
    storefrontUrl: createStorefrontUrl(globalAgentId),
    language: business?.language ?? "en",
    personality,
    personalityConfig: defaultWebAgentPersonality(business?.language ?? "en", personality),
    instructions: generalInstruction,
    instructionPolicy: defaultWebAgentInstructions(generalInstruction),
    knowledge: defaultAgentDefinition.knowledge,
    tools: [...defaultAgentDefinition.tools],
    skillBindings: defaultWebAgentSkills(),
    integrations: ["Grogoni storefront"],
    contextScripts: defaultAgentContextScripts,
    memoryPolicy: defaultWebAgentMemoryPolicy(),
    evaluationPolicy: defaultWebAgentEvaluationPolicy(),
    supportedLanguages:
      business?.language === "sw" ? ["sw", "en"] : [business?.language ?? "en", "sw"],
    businessCategory: "general",
    publicIntroduction: `Welcome to ${businessName}.`,
    runtimeVersion: 1,
    status: "active"
  };
}

export function agentSettingsFromBusinessProfile(
  profile: BusinessAgentProfileSummary,
  business: ActiveBusiness
): AgentSettings {
  const globalAgentId = normalizeGrogoniId(business.grogoniId);
  return {
    agentDefinitionId: profile.agentDefinitionId ?? defaultAgentDefinitionId,
    id: `agent-${globalAgentId}`,
    name: profile.name,
    description: profile.description,
    model: profile.modelId,
    role: profile.role,
    globalAgentId,
    storefrontUrl: createStorefrontUrl(globalAgentId),
    language: profile.language,
    personality: profile.personality,
    personalityConfig:
      profile.personalityConfig ??
      defaultWebAgentPersonality(profile.language, profile.personality),
    instructions: profile.instructions,
    instructionPolicy:
      profile.instructionPolicy ?? defaultWebAgentInstructions(profile.instructions),
    knowledge: profile.knowledge,
    tools: [...profile.tools],
    skillBindings:
      profile.skillBindings?.map((binding) => ({
        ...binding,
        permissions: [...binding.permissions],
        allowedIntents: [...binding.allowedIntents]
      })) ?? defaultWebAgentSkills(),
    integrations: [...profile.integrations],
    contextScripts: ensureRequiredAgentContextScripts(
      sanitizeContextScripts(profile.contextScripts)
    ),
    memoryPolicy: profile.memoryPolicy ?? defaultWebAgentMemoryPolicy(),
    evaluationPolicy: profile.evaluationPolicy ?? defaultWebAgentEvaluationPolicy(),
    supportedLanguages: profile.supportedLanguages ?? [profile.language],
    businessCategory: profile.businessCategory ?? "general",
    publicIntroduction: profile.publicIntroduction ?? profile.description,
    runtimeVersion: profile.runtimeVersion ?? 1,
    status: profile.status
  };
}

export function defaultWebAgentPersonality(
  language: SupportedLanguage,
  additionalGuidance: string
): AgentPersonality {
  return {
    tone: "warm",
    formality: "balanced",
    responseLength: "brief",
    sellingStyle: "consultative",
    negotiationStyle: "guided",
    greetingStyle: "friendly",
    useLocalVocabulary: true,
    preferredLanguageOrder: language === "sw" ? ["sw", "en"] : ["en", "sw"],
    humourLevel: "light",
    customerCareBehaviour: "solution_focused",
    escalationBehaviour: "when_required",
    confidenceBoundary: 0.7,
    additionalGuidance
  };
}

export function defaultWebAgentInstructions(generalRule: string): AgentInstructions {
  return {
    generalOperatingRules: [generalRule],
    salesRules: ["Use authoritative catalogue and inventory records."],
    pricingRules: ["Never invent or silently change prices."],
    maximumDiscountPercent: 0,
    negotiationAllowed: false,
    creditSalesAllowed: false,
    maximumCreditDays: 0,
    deliveryRules: ["Confirm availability before promising delivery."],
    returnsAndRefundRules: ["Escalate returns and refunds to the owner."],
    inventoryRules: ["Never claim unavailable stock."],
    supplierRules: ["Keep supplier and receipt records owner-only."],
    customerPrivacyRules: ["Use the minimum customer data required."],
    escalationRules: ["Escalate when facts, permission, or approval are missing."],
    restrictedActions: [],
    substituteOutOfStockAllowed: false,
    ownerApprovalRequiredFor: executableAgentSkillIds.filter(
      (skill) =>
        !["products.list", "invoices.list", "receipt.lookup", "receipt.list"].includes(skill)
    ),
    customerDataRecommendationsAllowed: false,
    catalogueModificationAllowed: true,
    externalMessagingAllowed: false
  };
}

export function defaultWebAgentSkills(): AgentSkillBinding[] {
  return executableAgentSkillIds.map((skillId) => ({
    skillId,
    version: 1,
    enabled: true,
    permissions: [],
    allowedIntents: [],
    requiredConfirmationLevel: [
      "products.list",
      "invoices.list",
      "receipt.lookup",
      "receipt.list"
    ].includes(skillId)
      ? "none"
      : "explicit",
    executionEnvironment: "server",
    quotaPerHour: null,
    lastSuccessfulExecution: null,
    failureCount: 0
  }));
}

export function defaultWebAgentMemoryPolicy(): AgentMemoryPolicy {
  return {
    sessionMemoryEnabled: true,
    customerConversationMemoryEnabled: false,
    shopSemanticMemoryEnabled: true,
    ownerCorrectionsEnabled: true,
    reusableWorkflowMemoryEnabled: false,
    customerMemoryRequiresConsent: true,
    retentionDays: 90,
    maximumItemsPerScope: 100
  };
}

export function defaultWebAgentEvaluationPolicy(): AgentEvaluationPolicy {
  return {
    enabled: true,
    sampleRate: 1,
    recordLatency: true,
    recordToolOutcomes: true,
    recordPolicyBlocks: true,
    customerSatisfactionEnabled: false,
    retainDays: 180
  };
}

export function createDefaultProductFieldDefinitions(): ProductFieldDefinition[] {
  return productFieldDefinitionsFromDrafts(createDefaultProductFieldDrafts());
}

export function productFieldDefinitionsFromDrafts(
  fields: ProductFieldDraft[]
): ProductFieldDefinition[] {
  return fields.map((field) => ({
    id: field.id,
    inputType: field.inputType,
    label: field.label,
    required: field.required
  }));
}

export function createDefaultProductFieldDrafts(): ProductFieldDraft[] {
  return [
    { ...createProductFieldDraft("Name", "text", true), id: "name" },
    { ...createProductFieldDraft("SKU", "text", true), id: "sku" },
    { ...createProductFieldDraft("Unit", "select", true), id: "unit" },
    { ...createProductFieldDraft("Quantity", "number", true), id: "quantity" },
    { ...createProductFieldDraft("Selling Price", "number", true), id: "selling-price" }
  ];
}

export function sanitizeContextScripts(scripts: unknown[]): string[] {
  return scripts
    .map((script) => (typeof script === "string" ? sanitizeContextScript(script) : ""))
    .filter((script) => script.length > 0)
    .slice(0, 12);
}

export function ensureRequiredAgentContextScripts(scripts: string[]): string[] {
  if (scripts.some((script) => script.includes("script: document_upload_guardrails"))) {
    return scripts;
  }

  return [...scripts.slice(0, 11), documentUploadContextScript];
}

export function sanitizeContextScript(script: string): string {
  const sanitized = script
    .replace(/<\s*\/?\s*script[^>]*>/gi, "")
    .replace(/\b(eval|Function|import|require|fetch|XMLHttpRequest)\s*(?=\()/gi, "[blocked]")
    .replace(/\b(localStorage|document|window)\s*(?=\.|\[)/gi, "[blocked]")
    .replace(/[;&|`$<>]/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 40)
    .join("\n")
    .slice(0, 2400);

  if (sanitized.length === 0 || /^#{1,6}\s+/m.test(sanitized)) {
    return sanitized;
  }

  return `# Agent context\n\n${sanitized}`.slice(0, 2400);
}

export function isAgentModel(value: unknown): value is AgentModel {
  return (
    value === "qwen2.5-0.5b-android" ||
    value === "qwen2.5-1.5b-android" ||
    value === "smollm2-360m-android" ||
    value === "tinyllama-1.1b-chat-q3-k-m-android" ||
    value === "tinyllama-1.1b-chat-q4-k-m-android" ||
    value === "grogoniclaw-local" ||
    value === "llama-cpp-configured" ||
    value === "openai-fast" ||
    value === "openai-reasoning" ||
    (typeof value === "string" &&
      (/^custom:[a-z0-9][a-z0-9._-]{0,79}$/.test(value) ||
        /^github:[a-z0-9][a-z0-9._-]{0,149}$/.test(value) ||
        /^huggingface:[a-z0-9][a-z0-9._-]{0,167}$/.test(value)))
  );
}

export const executableAgentSkillIds: AgentSkillBinding["skillId"][] = [
  "products.list",
  "invoices.list",
  "product.create",
  "product.update",
  "product.delete",
  "product.stock_adjust",
  "product.field.add",
  "product.field.remove",
  "customer.create",
  "invoice.draft",
  "payment.record",
  "receipt.scan",
  "receipt.review",
  "receipt.confirm",
  "receipt.correct",
  "receipt.cancel",
  "receipt.lookup",
  "receipt.list",
  "document_import.confirm",
  "unknown.clarify"
];

export function createProductFieldDraft(
  label: string,
  inputType: ProductFieldInputType = "text",
  required = false
): ProductFieldDraft {
  return {
    id: `product-field-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    inputType,
    label,
    required,
    value: ""
  };
}
