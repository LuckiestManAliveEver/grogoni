import type { Pool } from "pg";

import { isInferenceExecutionTarget } from "./contract.js";
import { isInferenceProviderType, type InferenceProviderConfig } from "./provider-config.js";
import type {
  InferencePolicyRecord,
  InferenceRepositories,
  InferenceRunRecord
} from "./repositories.js";

/**
 * Postgres implementations of the inference repositories (tables from
 * infra/db/migrations/101_multi_provider_inference.sql). Each write is a single statement on the
 * module's own pool - the same Postgres-authoritative, own-pool shape corridor fulfillment uses -
 * so telemetry never sits only in the CP2 in-memory snapshot.
 */
export function createPostgresInferenceRepositories(pool: Pool): InferenceRepositories {
  return {
    providers: {
      async list() {
        // Rows of retired hosted types (openai, anthropic, zai, openai-compatible) are skipped by
        // providerFromRow; they stay in the table untouched so nothing is destroyed.
        const result = await pool.query<ProviderRow>(
          `select id, display_name, provider_type, execution_target, enabled, capabilities
             from inference_providers
            order by id`
        );
        return result.rows.flatMap((row) => {
          const config = providerFromRow(row);
          return config === null ? [] : [config];
        });
      },
      async upsert(config) {
        await pool.query(
          `insert into inference_providers (
             id, display_name, provider_type, base_url, execution_target, enabled, capabilities,
             credential_ref, byok_allowed, verification, updated_at
           ) values ($1,$2,$3,null,$4,$5,$6::jsonb,null,false,'none', now())
           on conflict (id) do update set
             display_name = excluded.display_name, provider_type = excluded.provider_type,
             base_url = null, execution_target = excluded.execution_target,
             enabled = excluded.enabled, capabilities = excluded.capabilities,
             credential_ref = null, byok_allowed = false, verification = 'none',
             updated_at = now()`,
          [
            config.id,
            config.displayName,
            config.type,
            config.executionTarget,
            config.enabled,
            JSON.stringify(config.capabilities)
          ]
        );
      },
      async remove(providerId) {
        const result = await pool.query("delete from inference_providers where id = $1", [
          providerId
        ]);
        return (result.rowCount ?? 0) > 0;
      }
    },
    credentials: {
      async deleteForOwner(input) {
        const result = await pool.query(
          `delete from inference_provider_credentials
            where ($1::text is not null and tenant_id = $1) or ($2::text is not null and user_id = $2)`,
          [input.tenantId ?? null, input.userId ?? null]
        );
        return result.rowCount ?? 0;
      }
    },
    runs: {
      async insert(run) {
        await pool.query(
          `insert into inference_runs (
             id, request_id, conversation_id, agent_id, tenant_id, user_id, model_id, provider_id,
             credential_scope, execution_target, input_tokens, output_tokens, cached_input_tokens,
             estimated_cost, currency, latency_ms, first_token_ms, status, error_code,
             fallback_from_provider_id, created_at
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
          runParams(run)
        );
      },
      async sumCost(input) {
        const result = await pool.query<{ total: string | null }>(
          `select coalesce(sum(estimated_cost), 0) as total
             from inference_runs
            where created_at >= $1 and currency = $2
              and ($3::text is null or tenant_id = $3)
              and ($4::text is null or user_id = $4)
              and ($5::text is null or provider_id = $5)
              and ($6::text is null or credential_scope = $6)`,
          [
            input.since,
            input.currency,
            input.tenantId ?? null,
            input.userId ?? null,
            input.providerId ?? null,
            input.credentialScope ?? null
          ]
        );
        return Number(result.rows[0]?.total ?? 0);
      },
      async deleteForOwner(input) {
        const result = await pool.query(
          `delete from inference_runs
            where ($1::text is not null and tenant_id = $1) or ($2::text is not null and user_id = $2)`,
          [input.tenantId ?? null, input.userId ?? null]
        );
        return result.rowCount ?? 0;
      }
    },
    policies: {
      async get(input) {
        const result = await pool.query<PolicyRow>(
          `select scope, tenant_id, user_id, currency, daily_budget, provider_monthly_ceilings,
                  max_requests_per_minute, max_tokens_per_request, fallback_policy,
                  approved_provider_ids, fallback_model_ids, updated_at
             from inference_policies
            where scope = $1 and owner_key = $2`,
          [input.scope, ownerKey(input.scope, input.tenantId ?? null, input.userId ?? null)]
        );
        const row = result.rows[0];
        return row === undefined ? undefined : policyFromRow(row);
      },
      async upsert(record) {
        await pool.query(
          `insert into inference_policies (
             scope, owner_key, tenant_id, user_id, currency, daily_budget, provider_monthly_ceilings,
             max_requests_per_minute, max_tokens_per_request, fallback_policy,
             approved_provider_ids, fallback_model_ids, updated_at
           ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::text[],$12::text[],$13)
           on conflict (scope, owner_key) do update set
             currency = excluded.currency,
             daily_budget = excluded.daily_budget,
             provider_monthly_ceilings = excluded.provider_monthly_ceilings,
             max_requests_per_minute = excluded.max_requests_per_minute,
             max_tokens_per_request = excluded.max_tokens_per_request,
             fallback_policy = excluded.fallback_policy,
             approved_provider_ids = excluded.approved_provider_ids,
             fallback_model_ids = excluded.fallback_model_ids,
             updated_at = excluded.updated_at`,
          [
            record.scope,
            ownerKey(record.scope, record.tenantId, record.userId),
            record.tenantId,
            record.userId,
            record.currency,
            record.dailyBudget,
            JSON.stringify(record.providerMonthlyCeilings),
            record.maxRequestsPerMinute,
            record.maxTokensPerRequest,
            record.fallbackPolicy,
            record.approvedProviderIds,
            record.fallbackModelIds,
            record.updatedAt
          ]
        );
      }
    }
  };
}

/** Tables this module requires; checked at boot like assertFulfillmentSchema. */
export async function assertInferenceSchema(pool: Pool): Promise<void> {
  const result = await pool.query<{ table_name: string }>(
    `select table_name from information_schema.tables
      where table_schema = 'public'
        and table_name in ('inference_providers', 'inference_provider_credentials',
                           'inference_runs', 'inference_policies')`
  );
  if (result.rows.length !== 4) {
    throw new Error(
      "Inference provider tables are missing. Run `pnpm db:migrate` (101_multi_provider_inference.sql)."
    );
  }
}

interface ProviderRow {
  id: string;
  display_name: string;
  provider_type: string;
  execution_target: string;
  enabled: boolean;
  capabilities: Record<string, unknown>;
}

function providerFromRow(row: ProviderRow): InferenceProviderConfig | null {
  if (
    !isInferenceProviderType(row.provider_type) ||
    !isInferenceExecutionTarget(row.execution_target)
  ) {
    return null;
  }
  return {
    id: row.id,
    displayName: row.display_name,
    type: row.provider_type,
    executionTarget: row.execution_target,
    enabled: row.enabled,
    capabilities: Object.fromEntries(
      Object.entries(row.capabilities ?? {}).filter(([, value]) => typeof value === "boolean")
    ),
    source: "database"
  };
}

function runParams(run: InferenceRunRecord): unknown[] {
  return [
    run.id,
    run.requestId,
    run.conversationId,
    run.agentId,
    run.tenantId,
    run.userId,
    run.modelId,
    run.providerId,
    run.credentialScope,
    run.executionTarget,
    run.inputTokens,
    run.outputTokens,
    run.cachedInputTokens,
    run.estimatedCost,
    run.currency,
    run.latencyMs,
    run.firstTokenMs,
    run.status,
    run.errorCode,
    run.fallbackFromProviderId,
    run.createdAt
  ];
}

interface PolicyRow {
  scope: InferencePolicyRecord["scope"];
  tenant_id: string | null;
  user_id: string | null;
  currency: string;
  daily_budget: string | null;
  provider_monthly_ceilings: Record<string, unknown>;
  max_requests_per_minute: number | null;
  max_tokens_per_request: number | null;
  fallback_policy: InferencePolicyRecord["fallbackPolicy"];
  approved_provider_ids: string[];
  fallback_model_ids: string[];
  updated_at: Date;
}

function policyFromRow(row: PolicyRow): InferencePolicyRecord {
  return {
    scope: row.scope,
    tenantId: row.tenant_id,
    userId: row.user_id,
    currency: row.currency,
    dailyBudget: row.daily_budget === null ? null : Number(row.daily_budget),
    providerMonthlyCeilings: Object.fromEntries(
      Object.entries(row.provider_monthly_ceilings ?? {}).flatMap(([key, value]) =>
        typeof value === "number" || typeof value === "string" ? [[key, Number(value)]] : []
      )
    ),
    maxRequestsPerMinute: row.max_requests_per_minute,
    maxTokensPerRequest: row.max_tokens_per_request,
    fallbackPolicy: row.fallback_policy,
    approvedProviderIds: row.approved_provider_ids,
    fallbackModelIds: row.fallback_model_ids,
    updatedAt: row.updated_at.toISOString()
  };
}

function ownerKey(
  scope: InferencePolicyRecord["scope"],
  tenantId: string | null,
  userId: string | null
): string {
  return scope === "tenant" ? (tenantId ?? "") : scope === "user" ? (userId ?? "") : "";
}
