import type { InferenceProviderConfig } from "./provider-config.js";

/**
 * Environment-sourced inference configuration: budgets, limits, and defaults for the device-local
 * router. Hosted provider keys and BYOK credential encryption keys were removed with the local-first
 * runtime (docs/local-first-cloud-audit.md); services/api/src/config.ts rejects their variables.
 */
export interface InferenceEnvironment {
  providers: InferenceProviderConfig[];
  defaultModelId: string | null;
  requestTimeoutMs: number;
  maxOutputTokens: number;
  budgets: {
    currency: string;
    tenantDailyBudget: number | null;
    userDailyBudget: number | null;
    providerMonthlyCeilings: ReadonlyMap<string, number>;
    maxRequestsPerMinute: number | null;
    maxTokensPerRequest: number | null;
  };
}

type Env = Readonly<Record<string, string | undefined>>;

/** The only built-in provider: generation on the requesting member's own device. */
export function builtinProviderConfigs(): InferenceProviderConfig[] {
  return [
    {
      id: "local",
      displayName: "Local AI (this device)",
      type: "local",
      executionTarget: "browser-local",
      enabled: true,
      capabilities: {},
      source: "builtin"
    }
  ];
}

export function readInferenceEnvironment(env: Env = process.env): InferenceEnvironment {
  return {
    providers: builtinProviderConfigs(),
    defaultModelId: optionalId(env.INFERENCE_DEFAULT_MODEL),
    requestTimeoutMs: positiveInteger(env, "INFERENCE_REQUEST_TIMEOUT_MS", 60_000),
    maxOutputTokens: positiveInteger(env, "INFERENCE_MAX_OUTPUT_TOKENS", 1_024),
    budgets: {
      currency: (env.INFERENCE_BUDGET_CURRENCY?.trim() || "USD").toUpperCase(),
      tenantDailyBudget: optionalAmount(env, "INFERENCE_TENANT_DAILY_BUDGET"),
      userDailyBudget: optionalAmount(env, "INFERENCE_USER_DAILY_BUDGET"),
      providerMonthlyCeilings: amountMap(env, "INFERENCE_PROVIDER_MONTHLY_CEILINGS"),
      maxRequestsPerMinute: optionalPositiveInteger(env, "INFERENCE_MAX_REQUESTS_PER_MINUTE"),
      maxTokensPerRequest: optionalPositiveInteger(env, "INFERENCE_MAX_TOKENS_PER_REQUEST")
    }
  };
}

function optionalId(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return null;
  if (!/^[a-z0-9][a-z0-9:._-]{0,199}$/u.test(trimmed)) {
    throw new Error("INFERENCE_DEFAULT_MODEL must be a portable lowercase identifier.");
  }
  return trimmed;
}

function positiveInteger(env: Env, name: string, fallback: number): number {
  return optionalPositiveInteger(env, name) ?? fallback;
}

function optionalPositiveInteger(env: Env, name: string): number | null {
  const raw = env[name]?.trim() ?? "";
  if (raw === "") return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function optionalAmount(env: Env, name: string): number | null {
  const raw = env[name]?.trim() ?? "";
  if (raw === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`${name} must be a non-negative number.`);
  return parsed;
}

/** "local=500" -> Map. */
function amountMap(env: Env, name: string): ReadonlyMap<string, number> {
  const raw = env[name]?.trim() ?? "";
  const map = new Map<string, number>();
  if (raw === "") return map;
  for (const entry of raw.split(",")) {
    const [key, value] = entry.split("=").map((part) => part.trim());
    const amount = Number(value);
    if (key === undefined || key === "" || !Number.isFinite(amount) || amount < 0) {
      throw new Error(`${name} must look like "provider=amount,provider=amount".`);
    }
    map.set(key, amount);
  }
  return map;
}
