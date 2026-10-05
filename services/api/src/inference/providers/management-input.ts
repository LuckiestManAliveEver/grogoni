import type { InferencePolicySummary } from "@grogoni/shared-types";

import type { ModelDefinition } from "./contract.js";
import { isInferenceProviderType, type InferenceProviderConfig } from "./provider-config.js";
import type { InferencePolicyRecord } from "./repositories.js";

/**
 * Validation for the policy and provider-management APIs. Everything that arrives here is
 * untrusted request data; nothing is stored until it passes.
 */

/** A rejected policy or provider-management body. The store maps it to an HTTP error. */
export class InferenceManagementInputError extends Error {
  readonly statusCode = 400;
  readonly code = "inference_management_input_invalid";

  constructor(message: string) {
    super(message);
    this.name = "InferenceManagementInputError";
  }
}

function invalid(message: string): InferenceManagementInputError {
  return new InferenceManagementInputError(message);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalAmount(value: unknown, name: string, max: number): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
    throw invalid(`${name} must be a number between 0 and ${max}.`);
  }
  return value;
}

function optionalInteger(value: unknown, name: string, max: number): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw invalid(`${name} must be a whole number between 1 and ${max}.`);
  }
  return value;
}

function idList(value: unknown, name: string, max: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max)
    throw invalid(`${name} must be a list of at most ${max} ids.`);
  const ids = value.map((entry) => {
    if (typeof entry !== "string" || !/^[a-z0-9][a-z0-9:._-]{0,199}$/u.test(entry)) {
      throw invalid(`${name} contains an invalid id.`);
    }
    return entry;
  });
  return [...new Set(ids)];
}

/**
 * Builds a policy row from an API body. `scope` decides what may be set: provider monthly ceilings
 * cap Grogoni-funded spend, so only the platform (global) scope may set them.
 */
export function parsePolicyInput(
  body: unknown,
  owner: { scope: InferencePolicyRecord["scope"]; tenantId: string | null; userId: string | null },
  lookups: {
    providerExists: (providerId: string) => boolean;
    routedModel: (modelId: string) => ModelDefinition | null;
    now: Date;
  }
): InferencePolicyRecord {
  const input = record(body, "body");
  const fallbackPolicy = input.fallbackPolicy ?? "NONE";
  if (
    fallbackPolicy !== "NONE" &&
    fallbackPolicy !== "SAME_PROVIDER" &&
    fallbackPolicy !== "APPROVED_PROVIDERS"
  ) {
    throw invalid("fallbackPolicy must be NONE, SAME_PROVIDER or APPROVED_PROVIDERS.");
  }
  const approvedProviderIds = idList(input.approvedProviderIds, "approvedProviderIds", 10);
  for (const providerId of approvedProviderIds) {
    if (!lookups.providerExists(providerId)) throw invalid(`Unknown provider "${providerId}".`);
  }
  const fallbackModelIds = idList(input.fallbackModelIds, "fallbackModelIds", 5);
  for (const modelId of fallbackModelIds) {
    if (lookups.routedModel(modelId) === null)
      throw invalid(`"${modelId}" is not a provider-routed model.`);
  }
  if (
    fallbackPolicy === "NONE" &&
    (approvedProviderIds.length > 0 || fallbackModelIds.length > 0)
  ) {
    throw invalid("Fallback models and providers require a fallback policy other than NONE.");
  }
  const ceilings: Record<string, number> = {};
  if (input.providerMonthlyCeilings !== undefined && input.providerMonthlyCeilings !== null) {
    const raw = record(input.providerMonthlyCeilings, "providerMonthlyCeilings");
    if (owner.scope !== "global" && Object.keys(raw).length > 0) {
      throw invalid("Provider monthly ceilings can only be set by the platform.");
    }
    for (const [providerId, amount] of Object.entries(raw)) {
      if (!lookups.providerExists(providerId)) throw invalid(`Unknown provider "${providerId}".`);
      ceilings[providerId] =
        optionalAmount(amount, `providerMonthlyCeilings.${providerId}`, 1e9) ?? 0;
    }
  }
  const currency = input.currency ?? "USD";
  if (typeof currency !== "string" || !/^[A-Za-z]{3}$/u.test(currency)) {
    throw invalid("currency must be a three-letter code.");
  }
  return {
    scope: owner.scope,
    tenantId: owner.tenantId,
    userId: owner.userId,
    currency: currency.toUpperCase(),
    dailyBudget: optionalAmount(input.dailyBudget, "dailyBudget", 1e9),
    providerMonthlyCeilings: ceilings,
    maxRequestsPerMinute: optionalInteger(
      input.maxRequestsPerMinute,
      "maxRequestsPerMinute",
      10_000
    ),
    maxTokensPerRequest: optionalInteger(
      input.maxTokensPerRequest,
      "maxTokensPerRequest",
      1_000_000
    ),
    fallbackPolicy,
    approvedProviderIds,
    fallbackModelIds,
    updatedAt: lookups.now.toISOString()
  };
}

export function policySummary(
  policy: InferencePolicyRecord | undefined,
  owner: { scope: InferencePolicyRecord["scope"]; tenantId: string | null }
): InferencePolicySummary {
  return {
    scope: owner.scope,
    businessId: owner.tenantId,
    currency: policy?.currency ?? "USD",
    dailyBudget: policy?.dailyBudget ?? null,
    providerMonthlyCeilings: { ...(policy?.providerMonthlyCeilings ?? {}) },
    maxRequestsPerMinute: policy?.maxRequestsPerMinute ?? null,
    maxTokensPerRequest: policy?.maxTokensPerRequest ?? null,
    fallbackPolicy: policy?.fallbackPolicy ?? "NONE",
    approvedProviderIds: [...(policy?.approvedProviderIds ?? [])],
    fallbackModelIds: [...(policy?.fallbackModelIds ?? [])],
    updatedAt: policy?.updatedAt ?? null
  };
}

/**
 * Operator provider configuration. The only provider type is "local" (generation on members' own
 * devices), so a row can rename, disable, or retarget it between browser-local and installed-app.
 * This route is platform-operator-only; no merchant route reaches it.
 */
export function parseProviderInput(body: unknown, id: string): InferenceProviderConfig {
  if (!/^[a-z0-9][a-z0-9:._-]{0,99}$/u.test(id)) throw invalid("Provider id is invalid.");
  const input = record(body, "body");
  const type = input.type;
  if (!isInferenceProviderType(type)) {
    throw invalid('type must be "local"; hosted inference providers were removed.');
  }
  const executionTarget = input.executionTarget ?? "browser-local";
  if (executionTarget !== "browser-local" && executionTarget !== "installed-app") {
    throw invalid('executionTarget must be "browser-local" or "installed-app".');
  }
  const displayName = input.displayName;
  if (typeof displayName !== "string" || displayName.trim() === "" || displayName.length > 120) {
    throw invalid("displayName is required (at most 120 characters).");
  }
  const enabled = input.enabled ?? true;
  if (typeof enabled !== "boolean") throw invalid("enabled must be true or false.");
  const capabilities: InferenceProviderConfig["capabilities"] = {};
  if (input.capabilities !== undefined) {
    for (const [key, value] of Object.entries(record(input.capabilities, "capabilities"))) {
      if (
        !["text", "vision", "tools", "structuredOutput", "reasoning", "streaming"].includes(key)
      ) {
        throw invalid(`Unknown capability "${key}".`);
      }
      if (typeof value !== "boolean") throw invalid(`capabilities.${key} must be true or false.`);
      capabilities[key as keyof typeof capabilities] = value;
    }
  }
  return {
    id,
    displayName: displayName.trim(),
    type,
    executionTarget,
    enabled,
    capabilities,
    source: "database"
  };
}
