import { parseCredentialKeyring } from "./credentials.js";
import type { InferenceProviderConfig } from "./provider-config.js";

/**
 * Environment-sourced inference configuration. Environment variables describe Grogoni-managed
 * (Grogoni-funded) credentials and deployment endpoints only; BYOK credentials always come from
 * encrypted persistence (inference_provider_credentials). Nothing here hardcodes a model id, and no
 * provider is required for the API to boot.
 */
export interface InferenceEnvironment {
  providers: InferenceProviderConfig[];
  /** Managed secrets by env var name, read once at boot. Values never leave the credential resolver. */
  managedSecrets: ReadonlyMap<string, string>;
  /** INFERENCE_CREDENTIAL_KEYS: versioned keys for BYOK credential encryption (see credentials.ts). */
  credentialKeys: ReadonlyMap<number, string>;
  defaultProviderId: string | null;
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

const managedSecretNames = [] as const;

/** Local-only provider registry. Neon remains remote data storage; inference never leaves the machine. */
export function builtinProviderConfigs(): InferenceProviderConfig[] {
  return [
    {
      id: "local",
      displayName: "Local AI (this device)",
      type: "local",
      baseUrl: null,
      executionTarget: "browser-local",
      enabled: true,
      capabilities: {},
      credentialRef: null,
      byokAllowed: false,
      allowCredentialEndpoint: false,
      allowPrivateNetwork: false,
      allowHttp: false,
      billingProduct: null,
      verification: "none",
      options: {},
      source: "builtin"
    }
  ];
}

export function readInferenceEnvironment(env: Env = process.env): InferenceEnvironment {
  const managedSecrets = new Map<string, string>();
  for (const name of managedSecretNames) {
    const value = env[name]?.trim() ?? "";
    if (value !== "") managedSecrets.set(name, value);
  }

  const providers: InferenceProviderConfig[] = builtinProviderConfigs();

  return {
    providers,
    managedSecrets,
    credentialKeys: parseCredentialKeyring(env.INFERENCE_CREDENTIAL_KEYS),
    defaultProviderId: optionalId(env.INFERENCE_DEFAULT_PROVIDER),
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
    throw new Error("Inference default provider/model must be a portable lowercase identifier.");
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

/** "openai=500,anthropic=300" -> Map. */
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
