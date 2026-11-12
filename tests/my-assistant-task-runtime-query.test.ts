import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Pool as PgPool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import type { AiModelSummary } from "@grogoni/shared-types";
import { createCp2Store } from "../services/api/src/cp2/store";
import { createPostgresCp2Store } from "../services/api/src/cp2/postgres-store";
import { createOpenRouterRuntime } from "../services/api/src/inference/openrouter-runtime";
import {
  conversationRuntimeLookupMs,
  daemonConversationRuntime,
  loadConversationTaskRuntime
} from "../services/api/src/daemon/conversation-runtime";
import type { ModelRuntimeAdapter } from "../services/api/src/inference/model-runtime";

const url = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const migration = readFileSync("infra/db/migrations/132_my_assistant_rename.sql", "utf8");
const roleGrants = readFileSync("infra/db/roles/grogoni_daemon_role.sql", "utf8");
const requireApi = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Pool } = requireApi("pg") as { Pool: typeof PgPool };

function fixtureOptions() {
  const prototype = createCp2Store()
    .listAiModels()
    .find((m) => m.id === "gpt-6-luna")!;
  const models: AiModelSummary[] = ["query-model-a", "query-model-b"].map((id) => ({
    ...prototype,
    id,
    label: id,
    canonicalModelId: id
  }));
  const resolver = ({ modelId }: { modelId: string }): ModelRuntimeAdapter | undefined =>
    models.some((m) => m.id === modelId)
      ? {
          provider: "fixture",
          executionTarget: "backend",
          canRun: async () => ({ available: true, errorCode: null, message: null }),
          healthCheck: async () => ({
            available: true,
            errorCode: null,
            message: null,
            modelId,
            provider: "fixture",
            executionTarget: "backend",
            latencyMs: 1,
            responsePreview: null,
            retryable: false
          }),
          generate: async () => {
            throw new Error("unused");
          }
        }
      : undefined;
  return { models, options: { configuredModels: models, modelRuntimeAdapterResolver: resolver } };
}

// Runs on the real migrated schema (CP2_POSTGRES_TEST_DATABASE_URL, as the other Postgres suites)
// through the real Postgres store, so it checks the persisted shapes, that a switch reaches the
// database when it is made, and that the claim-time query uses indexes.
describe.skipIf(!url)("My Assistant runtime in Postgres", () => {
  const pool = new Pool({ connectionString: url ?? "", max: 2 });
  afterAll(async () => {
    await pool.end();
  });

  it(
    "shows a new account the platform default it runs on, with production model configuration",
    { timeout: 60_000 },
    async () => {
      // The production catalogue and adapters (no network: only the catalogue and resolver are
      // used). Migration 111 makes the global default Grogoni engine + GPT-6 Luna.
      const runtime = createOpenRouterRuntime({ OPENROUTER_API_KEY: "test-key" });
      const store = await createPostgresCp2Store({
        databaseUrl: url!,
        configuredModels: runtime.catalog(),
        modelRuntimeAdapterResolver: runtime.resolve
      });
      try {
        const owner = store.continueWithChannelPin({
          channel: "phone",
          destination: `+2547${String(randomInt(0, 100_000_000)).padStart(8, "0")}`,
          pin: "3927"
        });
        const id = store.getGrogoniSessionContext({ sessionId: owner.session.id }).conversationId;
        expect(store.getConversationModelSelection(owner.session.id, id)).toMatchObject({
          selectedAgentId: "grogoni",
          selectedModelId: "gpt-6-luna",
          available: true,
          errorCode: null
        });
      } finally {
        await store.close();
      }
    }
  );

  it(
    "persists a switch immediately and the task query reads it, owner-only and by index",
    { timeout: 60_000 },
    async () => {
      const { models, options } = fixtureOptions();
      const store = await createPostgresCp2Store({ databaseUrl: url!, ...options });
      const phone = () => `+2547${String(randomInt(0, 100_000_000)).padStart(8, "0")}`;
      try {
        const owner = store.continueWithChannelPin({
          channel: "phone",
          destination: phone(),
          pin: "3927"
        });
        const stranger = store.continueWithChannelPin({
          channel: "phone",
          destination: phone(),
          pin: "3927"
        });
        const id = store.getGrogoniSessionContext({ sessionId: owner.session.id }).conversationId;
        await store.flush();
        expect(await loadConversationTaskRuntime({ pool }, owner.user.id, id)).toBeNull();

        await store.selectConversationModel(owner.session.id, id, {
          modelId: models[1]!.id,
          agentId: "pi"
        });
        // No other write follows: the switch itself must reach Postgres.
        await store.flush();
        const fromDatabase = await loadConversationTaskRuntime({ pool }, owner.user.id, id);
        expect(fromDatabase).toEqual({ modelId: models[1]!.id, agentAdapterId: "pi" });
        expect(fromDatabase).toEqual(daemonConversationRuntime(store, id));

        // A fresh API instance (restart, second replica) loads the same choice.
        const reloaded = await createPostgresCp2Store({ databaseUrl: url!, ...options });
        try {
          expect(reloaded.getConversationModelSelection(owner.session.id, id)).toMatchObject({
            selectedAgentId: "pi",
            selectedModelId: models[1]!.id
          });
        } finally {
          await reloaded.close();
        }

        await store.selectConversationModel(owner.session.id, id, { agentId: "grogoni" });
        await store.flush();
        expect(await loadConversationTaskRuntime({ pool }, owner.user.id, id)).toEqual({
          modelId: models[1]!.id,
          agentAdapterId: "grogoni"
        });
        expect(await loadConversationTaskRuntime({ pool }, stranger.user.id, id)).toBeNull();
        expect(await loadConversationTaskRuntime({ pool }, "not-a-uuid", id)).toBeNull();

        // A blocked lookup is cancelled by the database at the deadline (statement_timeout), so
        // it cannot keep holding a connection of the shared pool.
        const blocker = await pool.connect();
        try {
          await blocker.query("begin");
          await blocker.query("lock table users in access exclusive mode");
          const startedAt = Date.now();
          await expect(
            loadConversationTaskRuntime({ pool }, owner.user.id, id)
          ).rejects.toMatchObject({
            code: "57014"
          });
          expect(Date.now() - startedAt).toBeLessThan(conversationRuntimeLookupMs + 3_000);
        } finally {
          await blocker.query("rollback");
          blocker.release();
        }
        expect(await loadConversationTaskRuntime({ pool }, owner.user.id, id)).toEqual({
          modelId: models[1]!.id,
          agentAdapterId: "grogoni"
        });

        // Every claim and server run executes this: users must be reached by its primary key.
        // The native daemon's least-privilege role: the real grant file applied to a throwaway
        // role, used through the production pool path on a one-connection pool.
        const role = `grogoni_daemon_test_${randomInt(0, 1_000_000_000)}`;
        await pool.query(`create role ${role} nologin`);
        const rolePool = new Pool({ connectionString: url!, max: 1 });
        try {
          // Only the grantee changes; table and function names stay.
          await pool.query(roleGrants.replace(/\bto grogoni_daemon\b/gu, `to ${role}`));
          const asDaemon = {
            connect: async () => {
              const connection = await rolePool.connect();
              await connection.query(`set role ${role}`);
              return connection;
            }
          };
          expect(await loadConversationTaskRuntime({ pool: asDaemon }, owner.user.id, id)).toEqual({
            modelId: models[1]!.id,
            agentAdapterId: "grogoni"
          });
          await expect(rolePool.query("select 1 from users limit 1")).rejects.toMatchObject({
            code: "42501"
          });
          // A caller's temporary table named users must not stand in for the real one: the
          // function's search_path puts pg_temp last. Without that, this impostor row (in the
          // same session as the lookup) would hand the role another account's runtime.
          const impostor = "5f0c4c34-8c55-4e43-9d0d-6c3b7b9a1e21";
          await rolePool.query("create temp table users (id uuid, account_id uuid)");
          await rolePool.query("insert into users values ($1, $2)", [impostor, owner.account.id]);
          expect(await loadConversationTaskRuntime({ pool: asDaemon }, impostor, id)).toBeNull();
        } finally {
          await rolePool.end();
          await pool.query(`drop owned by ${role}`);
          await pool.query(`drop role ${role}`);
        }

        const client = await pool.connect();
        try {
          await client.query("begin");
          await client.query("set local enable_seqscan = off");
          const plan = (
            await client.query<{ "QUERY PLAN": string }>(
              `explain select 1 from users u where u.id = $1::uuid`,
              [owner.user.id]
            )
          ).rows
            .map((row) => row["QUERY PLAN"])
            .join("\n");
          expect(plan).not.toMatch(/Seq Scan on users/u);
          // The function body from migration 132, planned with the same parameters.
          const body = /as \$fn\$([\s\S]*?)\$fn\$;/u
            .exec(migration)![1]!
            .replace("where u.id = $1", "where u.id = $1::uuid");
          const full = (
            await client.query<{ "QUERY PLAN": string }>(`explain ${body}`, [owner.user.id, id])
          ).rows
            .map((row) => row["QUERY PLAN"])
            .join("\n");
          expect(full).not.toMatch(/Seq Scan on users/u);
          // The function's path is pinned (no "$user", pg_temp last), and neither PUBLIC nor
          // PostgREST's roles (where they exist, on Supabase) can call it.
          const config = (
            await client.query<{ proconfig: string[] }>(
              "select proconfig from pg_proc where proname = 'grogoni_conversation_task_runtime'"
            )
          ).rows[0]!.proconfig;
          expect(config).toHaveLength(1);
          expect(config[0]).toMatch(/^search_path=[a-z_][a-z0-9_]*, pg_temp$/u);
          const exposed = (
            await client.query<{ rolname: string }>(
              `select rolname from pg_roles where rolname in ('anon', 'authenticated')
                 and has_function_privilege(rolname, 'grogoni_conversation_task_runtime(uuid, text)', 'execute')`
            )
          ).rows;
          expect(exposed).toEqual([]);
          const publicGrant = (
            await client.query<{ granted: boolean }>(
              `select exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
                 where p.proname = 'grogoni_conversation_task_runtime' and acl.grantee = 0) as granted`
            )
          ).rows[0]!.granted;
          expect(publicGrant).toBe(false);
        } finally {
          await client.query("rollback");
          client.release();
        }

        // Only My Assistant is answered: the same selection on a chat that is not the account's
        // permanent conversation (possible only through the old API) is not followed.
        await pool.query(
          `update cp2_conversations set record = jsonb_set(record, '{isPermanentDaemon}', 'false'::jsonb) where entity_id = $1`,
          [id]
        );
        try {
          expect(await loadConversationTaskRuntime({ pool }, owner.user.id, id)).toBeNull();
        } finally {
          await pool.query(
            `update cp2_conversations set record = jsonb_set(record, '{isPermanentDaemon}', 'true'::jsonb) where entity_id = $1`,
            [id]
          );
        }

        // Deleting the conversation removes its runtime.
        await pool.query(
          `update cp2_conversations set record = jsonb_set(record, '{deletedAt}', to_jsonb(now()::text)) where entity_id = $1`,
          [id]
        );
        try {
          expect(await loadConversationTaskRuntime({ pool }, owner.user.id, id)).toBeNull();
        } finally {
          await pool.query(
            `update cp2_conversations set record = jsonb_set(record, '{deletedAt}', 'null'::jsonb) where entity_id = $1`,
            [id]
          );
        }
      } finally {
        await store.close();
      }
    }
  );
});
