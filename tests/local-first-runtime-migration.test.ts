/**
 * Migration 108 (local-first runtime cleanup) against real PostgreSQL. Skipped unless
 * CP2_POSTGRES_TEST_DATABASE_URL points at a database migrated with `pnpm db:migrate`.
 *
 * The test rebuilds the state production databases are in before 108 - the GPT-6 Luna global
 * default from migrations 103/104, a shop bound to GPT-6 Luna on a backend host, a shop agent on
 * the ZeroClaw engine and a stored BYOK key - re-runs 108 (it is idempotent), then boots a fresh
 * Postgres-backed store whose only adapter is local Ollama and checks that the shop chats again.
 */
import { randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { PlatformDefaultRuntimePolicy } from "@grogoni/shared-types";

import { buildApi } from "../services/api/src/app";
import { createPostgresCp2Store } from "../services/api/src/cp2/postgres-store";
import type { ModelRuntimeAdapter } from "../services/api/src/inference/model-runtime";

interface TestPool {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

const { Pool } = createRequire(resolve(process.cwd(), "services/api/package.json"))("pg") as {
  Pool: new (options: { connectionString: string }) => TestPool;
};

const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const globalBindingId = "builtin:grogoni-default-runtime:v1";

async function migration(name: string): Promise<string> {
  const sql = await readFile(resolve(process.cwd(), "infra/db/migrations", name), "utf8");
  // 108 is opt-in (its guard raises otherwise); a multi-statement query runs on one connection.
  return name.startsWith("108_") ? `set grogoni.allow_108 = 'yes';\n${sql}` : sql;
}

function rollback(name: string): Promise<string> {
  return readFile(resolve(process.cwd(), "infra/db/rollbacks", name), "utf8");
}

function localOllamaAdapter(modelId: string): ModelRuntimeAdapter {
  return {
    provider: "ollama",
    executionTarget: "local",
    canRun: async () => ({ available: true, errorCode: null, message: null }),
    healthCheck: async () => ({
      available: true,
      modelId,
      provider: "ollama",
      executionTarget: "local",
      latencyMs: 1,
      responsePreview: "GROGONI_MODEL_OK",
      errorCode: null,
      message: null,
      retryable: false
    }),
    generate: async () => ({
      text: JSON.stringify({ type: "response", message: "Local Ollama is answering." }),
      modelId,
      provider: "ollama",
      executionTarget: "local",
      latencyMs: 1
    })
  };
}

const localRuntimePolicy: PlatformDefaultRuntimePolicy = {
  agentId: "builtin:shopkeeper:v1",
  agentName: "Shopkeeper",
  agentRuntimeAdapterId: "grogoni",
  modelId: "smollm2-360m",
  executionTarget: "local"
};

// Historical local-only deployment under test, independent of today's hosted default.
const onlyLocalOllama = ({
  modelId,
  executionTarget
}: {
  modelId: string;
  executionTarget: string;
}) =>
  modelId === "smollm2-360m" && executionTarget === "local"
    ? localOllamaAdapter(modelId)
    : undefined;

async function signUpOwner(app: ReturnType<typeof buildApi>) {
  const contact = `+2547${String(randomInt(0, 100_000_000)).padStart(8, "0")}`;
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ method: "phone", contact, pin: "1234" })
  });
  expect(signup.statusCode, signup.body).toBe(200);
  const setCookie = signup.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0] as string;
  const business = await app.inject({
    method: "POST",
    url: "/businesses",
    headers: { "content-type": "application/json", cookie },
    payload: JSON.stringify({ name: "Legacy Luna Shop", language: "en" })
  });
  expect(business.statusCode, business.body).toBe(200);
  return {
    cookie,
    accountId: signup.json<{ account: { id: string } }>().account.id,
    businessId: business.json<{ business: { id: string } }>().business.id
  };
}

function runtimeTurn(
  app: ReturnType<typeof buildApi>,
  owner: { cookie: string; businessId: string }
) {
  return app.inject({
    method: "POST",
    url: `/businesses/${owner.businessId}/runtime/turns`,
    headers: { "content-type": "application/json", cookie: owner.cookie },
    payload: JSON.stringify({ message: "Hello" })
  });
}

describePostgres("migration 108: local-first runtime cleanup", () => {
  it("refuses to run unless the operator opts in", async () => {
    const pool = new Pool({ connectionString: databaseUrl as string });
    try {
      const raw = await readFile(
        resolve(process.cwd(), "infra/db/migrations/108_local_first_runtime_cleanup.sql"),
        "utf8"
      );
      // Explicitly not opted in (RESET would fall back to a PGOPTIONS startup value), the way an
      // auto-deploy would run it.
      await expect(pool.query(`set grogoni.allow_108 = 'no';\n${raw}`)).rejects.toThrow(
        "Migration 108 is opt-in"
      );
    } finally {
      await pool.end();
    }
  });

  it("moves legacy GPT-6 Luna, ZeroClaw and BYOK state onto local Ollama", async () => {
    const connectionString = databaseUrl as string;
    const pool = new Pool({ connectionString });
    let store = await createPostgresCp2Store({
      databaseUrl: connectionString,
      platformDefaultRuntime: localRuntimePolicy,
      modelRuntimeAdapterResolver: onlyLocalOllama
    });
    let app = buildApi({ cp2: { store } });
    try {
      // Two shops with their own bindings (an explicit activation; conversation-free turns
      // otherwise run on the global slot), rewritten below into the two legacy shapes.
      const healed = await signUpOwner(app);
      const stranded = await signUpOwner(app);
      for (const owner of [healed, stranded]) {
        const activation = await app.inject({
          method: "POST",
          url: `/api/agents/${owner.businessId}/models/smollm2-360m/activate`,
          headers: { "content-type": "application/json", cookie: owner.cookie },
          payload: JSON.stringify({
            shopId: owner.businessId,
            executionTarget: "local",
            executionMode: "LOCAL_FIRST",
            permissions: { allowRemoteShopDevice: false }
          })
        });
        expect(activation.statusCode, activation.body).toBe(200);
        expect((await runtimeTurn(app, owner)).statusCode).toBe(200);
      }
      await store.flush();
      await app.close();
      await store.close();

      // Rebuild the pre-108 state (the migration runner already applied 108 to this database, so
      // its backup goes too): 103/104 put GPT-6 Luna back as the global primary...
      await pool.query("drop table if exists migration_108_backup");
      // Migration 103 preserves existing catalog rows. Recreate its legacy model shape so
      // newer catalog defaults cannot change the historical state this test exercises.
      await pool.query("delete from cp2_model_catalog where entity_id = 'gpt-6-luna'");
      await pool.query(await migration("103_shopkeeper_zeroclaw_default.sql"));
      await pool.query(await migration("104_openai_primary_vercel_fallback.sql"));
      // ...and both shops were provisioned on GPT-6 Luna through a backend host. "healed" also got
      // the local SmolLM2 fallback a local-mode API attaches at turn time; "stranded" did not.
      const legacyPrimaryOn = async (owner: { businessId: string; accountId: string }) => {
        const hostId = `legacy-backend-host-${randomUUID()}`;
        await pool.query(
          `insert into cp2_native_execution_hosts (entity_id, record, updated_at)
           values ($1, jsonb_build_object('id', $1::text, 'businessId', $2::text, 'accountId', $3::text,
             'type', 'backend', 'name', 'Legacy backend', 'endpoint', null, 'status', 'healthy',
             'capabilities', '["backend"]'::jsonb, 'configuration', '{"executionTarget":"backend"}'::jsonb,
             'credentialReference', null, 'lastKnownHealthyAt', '2026-09-27T00:00:00.000Z',
             'createdAt', '2026-09-27T00:00:00.000Z', 'updatedAt', '2026-09-27T00:00:00.000Z'), now())`,
          [hostId, owner.businessId, owner.accountId]
        );
        const primary = await pool.query<{ entity_id: string; parent_id: string; host: string }>(
          `select role_row.entity_id, role_row.parent_id, role_row.execution_host_id as host
             from cp2_native_runtime_binding_models role_row
             join cp2_native_runtime_bindings binding on binding.entity_id = role_row.parent_id
            where binding.record ->> 'businessId' = $1 and binding.record ->> 'status' = 'active'
              and role_row.role = 'primary' and role_row.enabled`,
          [owner.businessId]
        );
        expect(primary.rows).toHaveLength(1);
        const row = primary.rows[0]!;
        await pool.query(
          `update cp2_native_runtime_binding_models
              set record = record || jsonb_build_object('modelId', 'gpt-6-luna', 'executionHostId', $2::text)
            where entity_id = $1`,
          [row.entity_id, hostId]
        );
        return { bindingId: row.parent_id, localHostId: row.host };
      };
      const healedBinding = await legacyPrimaryOn(healed);
      const strandedBinding = await legacyPrimaryOn(stranded);
      const healedFallbackId = randomUUID();
      await pool.query(
        `insert into cp2_native_runtime_binding_models (entity_id, parent_id, record, updated_at)
         values ($1, $2, jsonb_build_object('id', $1::text, 'runtimeBindingId', $2::text,
           'modelId', 'smollm2-360m', 'role', 'fallback', 'priority', 0, 'executionHostId', $3::text,
           'configuration', '{}'::jsonb, 'enabled', true,
           'createdAt', '2026-10-02T00:00:00.000Z', 'updatedAt', '2026-10-02T00:00:00.000Z'), now())`,
        [healedFallbackId, healedBinding.bindingId, healedBinding.localHostId]
      );
      // The shop agents were saved while ZeroClaw was deployed, and an owner stored an OpenAI key.
      await pool.query(
        `update cp2_native_runtime_agents
            set record = jsonb_set(record, '{configuration,runtimeAdapterId}', '"zeroclaw"')
          where record ->> 'businessId' = any($1::text[])`,
        [[healed.businessId, stranded.businessId]]
      );
      await pool.query(
        `insert into inference_provider_credentials (
           id, scope, tenant_id, user_id, provider_id, encrypted_secret, key_version, secret_suffix,
           status, created_by, created_at, updated_at
         ) values ($1, 'tenant', $2, null, 'openai', 'v1:aaaa:bbbb:cccc', 1, '0000', 'ACTIVE', 'test', now(), now())`,
        [randomUUID(), healed.businessId]
      );

      const legacyPrimary = await pool.query<{ model_id: string }>(
        `select model_id from cp2_native_runtime_binding_models
          where parent_id = $1 and role = 'primary' and enabled`,
        [globalBindingId]
      );
      expect(legacyPrimary.rows.map((row) => row.model_id)).toEqual(["gpt-6-luna"]);

      // Apply 108 (twice: it must be idempotent).
      const cleanup = await migration("108_local_first_runtime_cleanup.sql");
      await pool.query(cleanup);
      await pool.query(cleanup);

      const globalRoles = await pool.query<{ model_id: string; role: string }>(
        `select model_id, role from cp2_native_runtime_binding_models
          where parent_id = $1 and enabled order by role`,
        [globalBindingId]
      );
      expect(globalRoles.rows).toEqual([{ model_id: "smollm2-360m", role: "primary" }]);
      const keys = await pool.query<{ count: string }>(
        "select count(*)::text as count from inference_provider_credentials"
      );
      expect(keys.rows[0]?.count).toBe("0");
      const luna = await pool.query<{ available: string; enabled: string }>(
        `select record ->> 'available' as available, record -> 'inference' ->> 'enabled' as enabled
           from cp2_model_catalog where entity_id = 'gpt-6-luna'`
      );
      expect(luna.rows[0]).toEqual({ available: "false", enabled: "false" });
      const bindingState = async (bindingId: string) =>
        (
          await pool.query<{
            status: string;
            primary_id: string | null;
            primary_model: string | null;
          }>(
            `select binding.record ->> 'status' as status, role_row.entity_id as primary_id,
                    role_row.model_id as primary_model
               from cp2_native_runtime_bindings binding
               left join cp2_native_runtime_binding_models role_row
                 on role_row.parent_id = binding.entity_id and role_row.role = 'primary' and role_row.enabled
              where binding.entity_id = $1`,
            [bindingId]
          )
        ).rows[0];
      // The self-healed fallback is promoted; the stranded binding is retired for re-provisioning.
      expect(await bindingState(healedBinding.bindingId)).toEqual({
        status: "active",
        primary_id: healedFallbackId,
        primary_model: "smollm2-360m"
      });
      expect(await bindingState(strandedBinding.bindingId)).toMatchObject({
        status: "inactive",
        primary_id: null
      });
      const zeroclawAgents = await pool.query(
        `select 1 from cp2_native_runtime_agents
          where record -> 'configuration' ->> 'runtimeAdapterId' = 'zeroclaw'`
      );
      expect(zeroclawAgents.rows).toHaveLength(0);

      // A fresh API process (only local Ollama) loads the migrated graph and serves both shops.
      store = await createPostgresCp2Store({
        databaseUrl: connectionString,
        platformDefaultRuntime: localRuntimePolicy,
        modelRuntimeAdapterResolver: onlyLocalOllama
      });
      app = buildApi({ cp2: { store } });
      for (const owner of [healed, stranded]) {
        const turn = await runtimeTurn(app, owner);
        expect(turn.statusCode, turn.body).toBe(200);
        expect(turn.json()).toMatchObject({
          turn: {
            response: "Local Ollama is answering.",
            model: { modelId: "smollm2-360m", executionTarget: "local", agentAdapterId: "grogoni" }
          }
        });
      }

      // And a shop created after the migration starts on the same local default.
      const newcomer = await signUpOwner(app);
      const effective = await app.inject({
        method: "GET",
        url: `/businesses/${newcomer.businessId}/runtime/effective`,
        headers: { cookie: newcomer.cookie }
      });
      expect(effective.json()).toMatchObject({
        agent: { runtimeAdapterId: "grogoni" },
        model: { id: "smollm2-360m" },
        execution: { type: "local", ready: true }
      });
      // Every write above must persist (collections are saved whole, so one bad row would fail
      // them all).
      await store.flush();
      await app.close();
      await store.close();

      // 108 kept a backup of what it changed, and never of the deleted keys.
      const backedUpTables = await pool.query<{ table_name: string }>(
        "select distinct table_name from migration_108_backup order by table_name"
      );
      expect(backedUpTables.rows.map((row) => row.table_name)).not.toContain(
        "inference_provider_credentials"
      );
      expect(backedUpTables.rows.map((row) => row.table_name)).toContain(
        "cp2_native_runtime_binding_models"
      );

      // The rollback restores the pre-108 runtime graph from that backup...
      await pool.query(await rollback("108_local_first_runtime_cleanup.down.sql"));
      const restoredGlobal = await pool.query<{ model_id: string; host: string }>(
        `select model_id, execution_host_id as host from cp2_native_runtime_binding_models
          where parent_id = $1 and role = 'primary' and enabled`,
        [globalBindingId]
      );
      expect(restoredGlobal.rows).toEqual([
        { model_id: "gpt-6-luna", host: "builtin:provider-router:v1" }
      ]);
      expect(await bindingState(healedBinding.bindingId)).toMatchObject({
        status: "active",
        primary_model: "gpt-6-luna"
      });
      expect(await bindingState(strandedBinding.bindingId)).toMatchObject({
        status: "active",
        primary_model: "gpt-6-luna"
      });

      // ...and the current code still persists on top of it. Regression: with the global slot
      // unusable, zero-setup provisioning marked the shop binding isDefault, which Postgres
      // rejects, and every later save in the process failed.
      store = await createPostgresCp2Store({
        databaseUrl: connectionString,
        platformDefaultRuntime: localRuntimePolicy,
        modelRuntimeAdapterResolver: onlyLocalOllama
      });
      app = buildApi({ cp2: { store } });
      const lateComer = await signUpOwner(app);
      const lateTurn = await runtimeTurn(app, lateComer);
      expect(lateTurn.statusCode, lateTurn.body).toBe(200);
      await store.flush();
      await app.close();
      await store.close();

      // Re-applying 108 converges on the same local default.
      await pool.query(cleanup);
      const reapplied = await pool.query<{ model_id: string }>(
        `select model_id from cp2_native_runtime_binding_models
          where parent_id = $1 and role = 'primary' and enabled`,
        [globalBindingId]
      );
      expect(reapplied.rows).toEqual([{ model_id: "smollm2-360m" }]);
      store = await createPostgresCp2Store({
        databaseUrl: connectionString,
        platformDefaultRuntime: localRuntimePolicy,
        modelRuntimeAdapterResolver: onlyLocalOllama
      });
      app = buildApi({ cp2: { store } });
      expect((await runtimeTurn(app, healed)).statusCode).toBe(200);
      await store.flush();
    } finally {
      await app.close().catch(() => undefined);
      await store.close().catch(() => undefined);
      await pool.end();
    }
  }, 120_000);
});
