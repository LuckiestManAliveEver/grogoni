/**
 * Inference provider repositories against real PostgreSQL. Skipped unless
 * CP2_POSTGRES_TEST_DATABASE_URL points at a database migrated with `pnpm db:migrate` (through
 * 101_multi_provider_inference.sql). Every test uses fresh owner ids and removes what it wrote.
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { Pool as PgPool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertInferenceSchema,
  createPostgresInferenceRepositories
} from "../services/api/src/inference/providers/postgres-repositories";
import type {
  InferenceRepositories,
  InferenceRunRecord
} from "../services/api/src/inference/providers/repositories";

const { Pool } = createRequire(resolve(process.cwd(), "services/api/package.json"))("pg") as {
  Pool: new (options: { connectionString: string }) => PgPool;
};

const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

/**
 * Writes a key row the way the retired BYOK connections did. Nothing in the API writes these any
 * more; they exist only in databases that predate the local-first runtime.
 */
async function insertLegacyCredential(
  pool: PgPool,
  owner: { tenantId?: string; userId?: string },
  providerId = "openai"
): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await pool.query(
    `insert into inference_provider_credentials (
       id, scope, tenant_id, user_id, provider_id, encrypted_secret, key_version, secret_suffix,
       status, created_by, created_at, updated_at
     ) values ($1, $2, $3, $4, $6, 'v1:aaaa:bbbb:cccc', 1, '0000', 'ACTIVE', 'test', $5, $5)`,
    [
      id,
      owner.tenantId === undefined ? "user" : "tenant",
      owner.tenantId ?? null,
      owner.userId ?? null,
      now,
      providerId
    ]
  );
  return id;
}

function run(overrides: Partial<InferenceRunRecord>): InferenceRunRecord {
  return {
    id: randomUUID(),
    requestId: randomUUID(),
    conversationId: null,
    agentId: "agent",
    tenantId: null,
    userId: null,
    modelId: "phi-test",
    providerId: "local",
    credentialScope: null,
    executionTarget: "browser-local",
    inputTokens: 10,
    outputTokens: 5,
    cachedInputTokens: null,
    estimatedCost: 0.25,
    currency: "USD",
    latencyMs: 40,
    firstTokenMs: null,
    status: "succeeded",
    errorCode: null,
    fallbackFromProviderId: null,
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

describePostgres("inference repositories on PostgreSQL", () => {
  let pool: PgPool;
  let repositories: InferenceRepositories;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl as string });
    await assertInferenceSchema(pool as never);
    repositories = createPostgresInferenceRepositories(pool as never);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("erases an owner's legacy BYOK key rows on account or shop deletion, and only theirs", async () => {
    const tenantId = `tenant-${randomUUID()}`;
    const userId = `user-${randomUUID()}`;
    const otherTenantId = `tenant-${randomUUID()}`;
    // One active key per owner and provider (inference_provider_credentials_active_owner_idx).
    await insertLegacyCredential(pool, { tenantId }, "openai");
    await insertLegacyCredential(pool, { tenantId }, "anthropic");
    await insertLegacyCredential(pool, { userId });
    const survivor = await insertLegacyCredential(pool, { tenantId: otherTenantId });
    try {
      expect(await repositories.credentials.deleteForOwner({ tenantId })).toBe(2);
      expect(await repositories.credentials.deleteForOwner({ userId })).toBe(1);
      expect(await repositories.credentials.deleteForOwner({ tenantId })).toBe(0);
      const remaining = await pool.query(
        "select id from inference_provider_credentials where id = $1",
        [survivor]
      );
      expect(remaining.rowCount).toBe(1);
    } finally {
      await pool.query("delete from inference_provider_credentials where tenant_id = any($1)", [
        [tenantId, otherTenantId]
      ]);
      await pool.query("delete from inference_provider_credentials where user_id = $1", [userId]);
    }
  });

  it("sums cost by owner, provider, currency and period, and purges by owner", async () => {
    const tenantId = `tenant-${randomUUID()}`;
    const userId = `user-${randomUUID()}`;
    const earlier = new Date(Date.now() - 86_400_000 * 40).toISOString();
    await repositories.runs.insert(run({ tenantId, userId }));
    await repositories.runs.insert(run({ tenantId, providerId: "device-b", estimatedCost: 1 }));
    await repositories.runs.insert(run({ tenantId, currency: "EUR", estimatedCost: 9 }));
    await repositories.runs.insert(run({ tenantId, createdAt: earlier, estimatedCost: 100 }));
    const since = new Date(Date.now() - 86_400_000).toISOString();
    expect(await repositories.runs.sumCost({ since, tenantId, currency: "USD" })).toBeCloseTo(1.25);
    expect(
      await repositories.runs.sumCost({ since, tenantId, providerId: "local", currency: "USD" })
    ).toBeCloseTo(0.25);
    expect(await repositories.runs.sumCost({ since, userId, currency: "USD" })).toBeCloseTo(0.25);
    expect(await repositories.runs.deleteForOwner({ tenantId })).toBe(4);
    expect(await repositories.runs.sumCost({ since: earlier, tenantId, currency: "USD" })).toBe(0);
  });

  it("upserts policies per scope and reads provider overrides", async () => {
    const tenantId = `tenant-${randomUUID()}`;
    const record = {
      scope: "tenant" as const,
      tenantId,
      userId: null,
      currency: "USD",
      dailyBudget: 12.5,
      providerMonthlyCeilings: { local: 100 },
      maxRequestsPerMinute: 30,
      maxTokensPerRequest: 2_000,
      fallbackPolicy: "APPROVED_PROVIDERS" as const,
      approvedProviderIds: ["device-b"],
      fallbackModelIds: ["qwen2.5-0.5b-device"],
      updatedAt: new Date().toISOString()
    };
    try {
      await repositories.policies.upsert(record);
      await repositories.policies.upsert({ ...record, dailyBudget: 20 });
      expect(await repositories.policies.get({ scope: "tenant", tenantId })).toEqual({
        ...record,
        dailyBudget: 20
      });
      expect(
        await repositories.policies.get({ scope: "tenant", tenantId: "missing" })
      ).toBeUndefined();

      // A row of a retired hosted type, written before the local-first runtime, never loads.
      await pool.query(
        `insert into inference_providers (id, display_name, provider_type, base_url, execution_target, credential_ref)
         values ('test-gateway', 'Test Gateway', 'openai-compatible', 'https://gateway.example.com/v1', 'remote-inference', 'env:TEST_GATEWAY_KEY')`
      );
      const providers = await repositories.providers.list();
      expect(providers.find((provider) => provider.id === "test-gateway")).toBeUndefined();
    } finally {
      await pool.query("delete from inference_policies where owner_key = $1", [tenantId]);
      await pool.query("delete from inference_providers where id = 'test-gateway'");
    }
  });

  it("manages operator device-local provider rows", async () => {
    try {
      await repositories.providers.upsert({
        id: "pg-devices",
        displayName: "PG devices",
        type: "local",
        executionTarget: "installed-app",
        enabled: true,
        capabilities: { tools: false },
        source: "database"
      });
      await repositories.providers.upsert({
        ...(await repositories.providers.list()).find((provider) => provider.id === "pg-devices")!,
        enabled: false
      });
      expect(
        (await repositories.providers.list()).find((provider) => provider.id === "pg-devices")
      ).toEqual({
        id: "pg-devices",
        displayName: "PG devices",
        type: "local",
        executionTarget: "installed-app",
        enabled: false,
        capabilities: { tools: false },
        source: "database"
      });
      const stored = await pool.query<{ byok_allowed: boolean; credential_ref: string | null }>(
        "select byok_allowed, credential_ref from inference_providers where id = 'pg-devices'"
      );
      expect(stored.rows[0]).toEqual({ byok_allowed: false, credential_ref: null });
      expect(await repositories.providers.remove("pg-devices")).toBe(true);
      expect(await repositories.providers.remove("pg-devices")).toBe(false);
    } finally {
      await pool.query("delete from inference_providers where id = 'pg-devices'");
    }
  });

  it("seeds the on-device catalog models (migration 102)", async () => {
    const result = await pool.query<{ entity_id: string; target: string | null }>(
      `select entity_id, record -> 'inference' ->> 'executionTarget' as target
         from cp2_model_catalog
        where entity_id in ('smollm2-360m-device', 'qwen2.5-0.5b-device', 'qwen3-1.7b-device', 'qwen3-4b-grogoni-cloud')
        order by entity_id`
    );
    expect(result.rows).toEqual([
      { entity_id: "qwen2.5-0.5b-device", target: "browser-local" },
      { entity_id: "qwen3-1.7b-device", target: "browser-local" },
      { entity_id: "qwen3-4b-grogoni-cloud", target: "remote-inference" },
      { entity_id: "smollm2-360m-device", target: "browser-local" }
    ]);
  });
});
