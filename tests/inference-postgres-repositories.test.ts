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

import { secretBoxCipher } from "../services/api/src/inference/providers/credentials";
import {
  assertInferenceSchema,
  createPostgresInferenceRepositories
} from "../services/api/src/inference/providers/postgres-repositories";
import type {
  InferenceRepositories,
  InferenceRunRecord,
  ProviderCredentialRecord
} from "../services/api/src/inference/providers/repositories";

const { Pool } = createRequire(resolve(process.cwd(), "services/api/package.json"))("pg") as {
  Pool: new (options: { connectionString: string }) => PgPool;
};

const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

function credential(overrides: Partial<ProviderCredentialRecord>): ProviderCredentialRecord {
  const now = new Date().toISOString();
  const { ciphertext, keyVersion } = secretBoxCipher.encrypt("sk-postgres-test-key-000000000000");
  return {
    id: randomUUID(),
    scope: "tenant",
    tenantId: `tenant-${randomUUID()}`,
    userId: null,
    providerId: "openai",
    credentialType: "api_key",
    encryptedSecret: ciphertext,
    keyVersion,
    secretSuffix: "0000",
    baseUrl: null,
    status: "ACTIVE",
    createdBy: "test",
    createdAt: now,
    updatedAt: now,
    revokedAt: null,
    lastVerifiedAt: null,
    lastVerificationStatus: null,
    ...overrides
  };
}

function run(overrides: Partial<InferenceRunRecord>): InferenceRunRecord {
  return {
    id: randomUUID(),
    requestId: randomUUID(),
    conversationId: null,
    agentId: "agent",
    tenantId: null,
    userId: null,
    modelId: "gpt-test",
    providerId: "openai",
    credentialScope: "platform",
    executionTarget: "remote-inference",
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

  it("round-trips credentials with exact-owner lookup and one active key per owner", async () => {
    const tenantA = credential({});
    const tenantId = tenantA.tenantId as string;
    await repositories.credentials.insert(tenantA);
    try {
      expect(await repositories.credentials.get(tenantA.id)).toEqual(tenantA);
      expect(
        (
          await repositories.credentials.findActive({
            providerId: "openai",
            scope: "tenant",
            tenantId
          })
        )?.id
      ).toBe(tenantA.id);
      expect(
        await repositories.credentials.findActive({
          providerId: "openai",
          scope: "tenant",
          tenantId: "someone-else"
        })
      ).toBeUndefined();
      expect(
        await repositories.credentials.findActive({
          providerId: "anthropic",
          scope: "tenant",
          tenantId
        })
      ).toBeUndefined();

      // The partial unique index enforces "revoke before replace".
      await expect(repositories.credentials.insert(credential({ tenantId }))).rejects.toThrow();

      const revokedAt = new Date().toISOString();
      await repositories.credentials.update({
        ...tenantA,
        status: "REVOKED",
        encryptedSecret: null,
        revokedAt,
        updatedAt: revokedAt
      });
      expect(
        await repositories.credentials.findActive({
          providerId: "openai",
          scope: "tenant",
          tenantId
        })
      ).toBeUndefined();
      const replacement = credential({ tenantId });
      await repositories.credentials.insert(replacement);
      expect(
        (await repositories.credentials.listForOwner({ tenantId }))
          .map((record) => record.status)
          .sort()
      ).toEqual(["ACTIVE", "REVOKED"]);
    } finally {
      expect(await repositories.credentials.deleteForOwner({ tenantId })).toBe(2);
    }
  });

  it("refuses plaintext secrets, revoked rows that keep a secret, and mismatched owners", async () => {
    await expect(
      repositories.credentials.insert(credential({ encryptedSecret: "sk-plaintext-key" }))
    ).rejects.toThrow();
    await expect(
      repositories.credentials.insert(credential({ status: "REVOKED" }))
    ).rejects.toThrow();
    await expect(
      repositories.credentials.insert(credential({ scope: "user", userId: null }))
    ).rejects.toThrow();
    await expect(
      repositories.credentials.insert(credential({ baseUrl: "http://insecure.example.com/v1" }))
    ).rejects.toThrow();
  });

  it("sums cost by owner, provider, currency and period, and purges by owner", async () => {
    const tenantId = `tenant-${randomUUID()}`;
    const userId = `user-${randomUUID()}`;
    const earlier = new Date(Date.now() - 86_400_000 * 40).toISOString();
    await repositories.runs.insert(run({ tenantId, userId }));
    await repositories.runs.insert(run({ tenantId, providerId: "anthropic", estimatedCost: 1 }));
    await repositories.runs.insert(run({ tenantId, currency: "EUR", estimatedCost: 9 }));
    await repositories.runs.insert(run({ tenantId, createdAt: earlier, estimatedCost: 100 }));
    const since = new Date(Date.now() - 86_400_000).toISOString();
    expect(await repositories.runs.sumCost({ since, tenantId, currency: "USD" })).toBeCloseTo(1.25);
    expect(
      await repositories.runs.sumCost({ since, tenantId, providerId: "openai", currency: "USD" })
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
      providerMonthlyCeilings: { openai: 100 },
      maxRequestsPerMinute: 30,
      maxTokensPerRequest: 2_000,
      fallbackPolicy: "APPROVED_PROVIDERS" as const,
      approvedProviderIds: ["anthropic"],
      fallbackModelIds: ["claude-test"],
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

      await pool.query(
        `insert into inference_providers (id, display_name, provider_type, base_url, execution_target, credential_ref)
         values ('test-gateway', 'Test Gateway', 'openai-compatible', 'https://gateway.example.com/v1', 'remote-inference', 'env:TEST_GATEWAY_KEY')`
      );
      const providers = await repositories.providers.list();
      expect(providers.find((provider) => provider.id === "test-gateway")).toMatchObject({
        type: "openai-compatible",
        baseUrl: "https://gateway.example.com/v1",
        credentialRef: "env:TEST_GATEWAY_KEY",
        allowPrivateNetwork: false,
        source: "database"
      });
      await expect(
        pool.query(
          `insert into inference_providers (id, display_name, provider_type, execution_target, credential_ref)
           values ('bad-ref', 'Bad', 'openai', 'remote-inference', 'sk-a-raw-secret')`
        )
      ).rejects.toThrow();
    } finally {
      await pool.query("delete from inference_policies where owner_key = $1", [tenantId]);
      await pool.query("delete from inference_providers where id in ('test-gateway', 'bad-ref')");
    }
  });

  it("manages operator provider rows, lists rows needing key rotation, and filters spend by payer", async () => {
    try {
      await repositories.providers.upsert({
        id: "pg-gateway",
        displayName: "PG gateway",
        type: "openai-compatible",
        baseUrl: "https://gateway.example.com/v1",
        executionTarget: "remote-inference",
        enabled: true,
        capabilities: { tools: false },
        credentialRef: "env:PG_GATEWAY_KEY",
        byokAllowed: false,
        allowCredentialEndpoint: false,
        allowPrivateNetwork: false,
        allowHttp: false,
        billingProduct: "gateway",
        verification: "models-endpoint",
        options: { maxTokensParameter: "max_tokens" },
        source: "database"
      });
      await repositories.providers.upsert({
        ...(await repositories.providers.list()).find((provider) => provider.id === "pg-gateway")!,
        enabled: false
      });
      expect(
        (await repositories.providers.list()).find((provider) => provider.id === "pg-gateway")
      ).toMatchObject({
        enabled: false,
        capabilities: { tools: false },
        options: { maxTokensParameter: "max_tokens" }
      });
      expect(await repositories.providers.remove("pg-gateway")).toBe(true);
      expect(await repositories.providers.remove("pg-gateway")).toBe(false);
    } finally {
      await pool.query("delete from inference_providers where id = 'pg-gateway'");
    }

    const tenantId = `tenant-${randomUUID()}`;
    const old = credential({ tenantId, keyVersion: 1 });
    await repositories.credentials.insert(old);
    try {
      const needing = await repositories.credentials.listNeedingRotation(2);
      expect(needing.map((record) => record.id)).toContain(old.id);
      expect(
        (await repositories.credentials.listNeedingRotation(1)).map((record) => record.id)
      ).not.toContain(old.id);
    } finally {
      await repositories.credentials.deleteForOwner({ tenantId });
    }

    await repositories.runs.insert(
      run({ tenantId, credentialScope: "platform", estimatedCost: 1 })
    );
    await repositories.runs.insert(run({ tenantId, credentialScope: "tenant", estimatedCost: 2 }));
    const since = new Date(Date.now() - 60_000).toISOString();
    expect(await repositories.runs.sumCost({ since, tenantId, currency: "USD" })).toBeCloseTo(3);
    expect(
      await repositories.runs.sumCost({
        since,
        tenantId,
        currency: "USD",
        credentialScope: "platform"
      })
    ).toBeCloseTo(1);
    await repositories.runs.deleteForOwner({ tenantId });
  });

  it("seeds the on-device and Grogoni Cloud catalog models (migration 102)", async () => {
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
