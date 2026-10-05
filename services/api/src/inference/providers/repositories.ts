import type { CredentialScope, InferenceExecutionTarget } from "./contract.js";
import type { InferenceProviderConfig } from "./provider-config.js";

/**
 * Persistence ports for the inference platform. Postgres-authoritative in production
 * (postgres-repositories.ts, following the fulfillment module's own-pool precedent) and in-memory
 * for tests and CP2_STORE=memory. None of these records ever holds a plaintext secret.
 */

/**
 * Encrypted keys stored by the retired BYOK connections (inference_provider_credentials). Nothing
 * reads or writes them any more; account and shop deletion still erase an owner's rows.
 */
export interface ProviderCredentialRepository {
  /** Hard delete on account/business deletion. Returns the number of rows removed. */
  deleteForOwner(input: { tenantId?: string; userId?: string }): Promise<number>;
}

export type InferenceRunStatus = "succeeded" | "failed" | "rejected";

/** Usage telemetry for one inference attempt. Deliberately has no prompt or output text. */
export interface InferenceRunRecord {
  id: string;
  requestId: string;
  conversationId: string | null;
  agentId: string | null;
  tenantId: string | null;
  userId: string | null;
  modelId: string;
  providerId: string;
  credentialScope: CredentialScope | null;
  executionTarget: InferenceExecutionTarget;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  estimatedCost: number | null;
  currency: string | null;
  latencyMs: number | null;
  firstTokenMs: number | null;
  status: InferenceRunStatus;
  errorCode: string | null;
  fallbackFromProviderId: string | null;
  createdAt: string;
}

export interface InferenceRunRepository {
  insert(run: InferenceRunRecord): Promise<void>;
  /** Sum of estimated cost since `since`, filtered by any combination of owner/provider. */
  sumCost(input: {
    since: string;
    tenantId?: string;
    userId?: string;
    providerId?: string;
    /** Only runs paid for from this credential source. */
    credentialScope?: CredentialScope;
    currency: string;
  }): Promise<number>;
  deleteForOwner(input: { tenantId?: string; userId?: string }): Promise<number>;
}

export type InferenceFallbackPolicy = "NONE" | "SAME_PROVIDER" | "APPROVED_PROVIDERS";

export interface InferencePolicyRecord {
  scope: "global" | "tenant" | "user";
  tenantId: string | null;
  userId: string | null;
  currency: string;
  dailyBudget: number | null;
  providerMonthlyCeilings: Record<string, number>;
  maxRequestsPerMinute: number | null;
  maxTokensPerRequest: number | null;
  fallbackPolicy: InferenceFallbackPolicy;
  /** For APPROVED_PROVIDERS: provider ids a request may move to. */
  approvedProviderIds: string[];
  /** Ordered catalog model ids to try after the selected model fails. */
  fallbackModelIds: string[];
  updatedAt: string;
}

export interface InferencePolicyRepository {
  get(input: {
    scope: InferencePolicyRecord["scope"];
    tenantId?: string;
    userId?: string;
  }): Promise<InferencePolicyRecord | undefined>;
  upsert(record: InferencePolicyRecord): Promise<void>;
}

export interface ProviderConfigRepository {
  list(): Promise<InferenceProviderConfig[]>;
  /** Operator-only (platform-operator routes). */
  upsert(config: InferenceProviderConfig): Promise<void>;
  remove(providerId: string): Promise<boolean>;
}

export interface InferenceRepositories {
  providers: ProviderConfigRepository;
  credentials: ProviderCredentialRepository;
  runs: InferenceRunRepository;
  policies: InferencePolicyRepository;
}

export function createMemoryInferenceRepositories(
  seed: { providers?: InferenceProviderConfig[]; policies?: InferencePolicyRecord[] } = {}
): InferenceRepositories & { runsSnapshot(): InferenceRunRecord[] } {
  const providers = new Map<string, InferenceProviderConfig>(
    (seed.providers ?? []).map((provider) => [provider.id, structuredClone(provider)])
  );
  const runs: InferenceRunRecord[] = [];
  const policies = new Map<string, InferencePolicyRecord>();
  const policyKey = (scope: string, tenantId?: string | null, userId?: string | null) =>
    `${scope}:${tenantId ?? ""}:${userId ?? ""}`;
  for (const policy of seed.policies ?? []) {
    policies.set(policyKey(policy.scope, policy.tenantId, policy.userId), policy);
  }
  const ownerMatches = (
    record: { tenantId: string | null; userId: string | null },
    input: { tenantId?: string; userId?: string }
  ) =>
    (input.tenantId !== undefined && record.tenantId === input.tenantId) ||
    (input.userId !== undefined && record.userId === input.userId);

  return {
    providers: {
      async list() {
        return [...providers.values()].map((provider) => structuredClone(provider));
      },
      async upsert(config) {
        providers.set(config.id, structuredClone({ ...config, source: "database" }));
      },
      async remove(providerId) {
        return providers.delete(providerId);
      }
    },
    credentials: {
      async deleteForOwner() {
        return 0;
      }
    },
    runs: {
      async insert(run) {
        runs.push({ ...run });
      },
      async sumCost(input) {
        return runs
          .filter(
            (run) =>
              run.createdAt >= input.since &&
              run.currency === input.currency &&
              (input.tenantId === undefined || run.tenantId === input.tenantId) &&
              (input.userId === undefined || run.userId === input.userId) &&
              (input.providerId === undefined || run.providerId === input.providerId) &&
              (input.credentialScope === undefined || run.credentialScope === input.credentialScope)
          )
          .reduce((total, run) => total + (run.estimatedCost ?? 0), 0);
      },
      async deleteForOwner(input) {
        let removed = 0;
        for (let index = runs.length - 1; index >= 0; index -= 1) {
          const run = runs[index] as InferenceRunRecord;
          if (ownerMatches(run, input)) {
            runs.splice(index, 1);
            removed += 1;
          }
        }
        return removed;
      }
    },
    policies: {
      async get(input) {
        const record = policies.get(policyKey(input.scope, input.tenantId, input.userId));
        return record === undefined ? undefined : structuredClone(record);
      },
      async upsert(record) {
        policies.set(
          policyKey(record.scope, record.tenantId, record.userId),
          structuredClone(record)
        );
      }
    },
    runsSnapshot() {
      return runs.map((run) => ({ ...run }));
    }
  };
}
