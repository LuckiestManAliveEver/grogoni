import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("native runtime binding migration", () => {
  it("contains the authoritative FKs, uniqueness guards, conversation binding, and rollback", async () => {
    const migration = await readFile(
      new URL("../infra/db/migrations/063_native_runtime_bindings.sql", import.meta.url),
      "utf8"
    );
    const rollback = await readFile(
      new URL("../infra/db/rollbacks/063_native_runtime_bindings.down.sql", import.meta.url),
      "utf8"
    );
    expect(migration).toContain("cp2_native_runtime_bindings_one_global_default_idx");
    expect(migration).toContain("cp2_native_runtime_binding_models_one_primary_idx");
    expect(migration).toContain("cp2_native_runtime_binding_models_fallback_priority_idx");
    expect(migration).toContain("foreign key (model_id)");
    expect(migration).toContain("references cp2_native_execution_hosts(entity_id)");
    expect(migration).toContain(
      "active runtime binding % must have exactly one enabled primary model"
    );
    expect(migration).toContain("add column if not exists runtime_binding_id");
    expect(migration).toContain("builtin:grogoni-default-runtime:v1");
    expect(rollback).toContain("drop table if exists cp2_native_runtime_binding_models");
  });

  it("archives retired rows, drops their tables, and installs an unverified generative default", async () => {
    const migration = await readFile(
      new URL("../infra/db/migrations/065_retire_execution_fabric.sql", import.meta.url),
      "utf8"
    );
    const verifier = await readFile(
      new URL("../services/api/scripts/verify-db-schema.mjs", import.meta.url),
      "utf8"
    );
    expect(migration).toContain("'status', 'unavailable'");
    expect(migration).toContain("'status', 'draft'");
    expect(migration).toContain("drop table cp2_model_preferences");
    expect(migration).toContain("drop table cp2_runtime_hosts");
    expect(migration).toContain("drop table cp2_runtime_model_installations");
    expect(migration).toContain("'openai-fast'");
    expect(migration).toContain("'activationRequired', true");
    expect(verifier).toContain('process.env.REQUIRE_NEON_DATABASE === "true"');
    expect(verifier).toContain("Retired runtime tables remain");
  });

  it("migrates provider-specific targets forward without changing model provider identity", async () => {
    const migration = await readFile(
      new URL("../infra/db/migrations/069_provider_neutral_execution_targets.sql", import.meta.url),
      "utf8"
    );
    const rollback = await readFile(
      new URL(
        "../infra/db/rollbacks/069_provider_neutral_execution_targets.down.sql",
        import.meta.url
      ),
      "utf8"
    );
    expect(migration).toContain("record #>> '{configuration,executionTarget}' = 'openai'");
    expect(migration).toContain("create table migration_069_execution_target_backup");
    expect(migration).toContain("select 'cp2_native_runtime_models'");
    expect(migration).toContain("select 'cp2_native_execution_hosts'");
    expect(migration).toContain("select 'cp2_agent_model_bindings'");
    expect(migration).toContain("'{configuration,executionTarget}'");
    expect(migration).toContain("'\"backend\"'::jsonb");
    expect(migration).toContain("drop constraint if exists cp2_agent_model_bindings_target_check");
    expect(migration).not.toContain("set record = jsonb_set(record, '{provider}'");
    expect(rollback).toContain("set record = backup.record");
    expect(rollback).toContain("'remote-shop-device',\n      'openai'");
    expect(rollback).toContain("drop table migration_069_execution_target_backup");
  });

  it("adds a concurrency-safe tenant default and explicit host health states", async () => {
    const migration = await readFile(
      new URL("../infra/db/migrations/070_zero_setup_runtime_defaults.sql", import.meta.url),
      "utf8"
    );
    const rollback = await readFile(
      new URL("../infra/db/rollbacks/070_zero_setup_runtime_defaults.down.sql", import.meta.url),
      "utf8"
    );
    expect(migration).toContain("cp2_native_runtime_bindings_one_tenant_default_idx");
    expect(migration).toContain("business_id is not null");
    expect(migration).toContain("'healthy'");
    expect(migration).toContain("'temporarily-unavailable'");
    expect(migration).toContain("'disabled'");
    expect(migration).toContain("'incompatible'");
    expect(rollback).toContain(
      "drop index if exists cp2_native_runtime_bindings_one_tenant_default_idx"
    );
  });

  it("adds the DB-hosted platform catalog tables, seeded from the current bootstrap catalog", async () => {
    const migration = await readFile(
      new URL("../infra/db/migrations/071_platform_catalog.sql", import.meta.url),
      "utf8"
    );
    const rollback = await readFile(
      new URL("../infra/db/rollbacks/071_platform_catalog.down.sql", import.meta.url),
      "utf8"
    );
    expect(migration).toContain("create table cp2_model_catalog");
    expect(migration).toContain("create table cp2_agent_catalog");
    expect(migration).toContain("create table cp2_platform_operators");
    expect(migration).toContain("entity_id = account_id");
    expect(migration).toContain("insert into cp2_model_catalog");
    expect(migration).toContain("'qwen2.5-0.5b-android'");
    expect(migration).toContain("'openai-fast'");
    expect(migration).toContain("insert into cp2_agent_catalog");
    expect(migration).toContain("'builtin:shopkeeper'");
    expect(migration).toContain("on conflict (entity_id) do nothing");
    expect(rollback).toContain("drop table if exists cp2_platform_operators");
    expect(rollback).toContain("drop table if exists cp2_agent_catalog");
    expect(rollback).toContain("drop table if exists cp2_model_catalog");
  });

  it("materializes Pi and SmolLM without rewriting tenant bindings", async () => {
    const migration = await readFile(
      new URL("../infra/db/migrations/072_pi_smollm_default_runtime.sql", import.meta.url),
      "utf8"
    );
    const rollback = await readFile(
      new URL("../infra/db/rollbacks/072_pi_smollm_default_runtime.down.sql", import.meta.url),
      "utf8"
    );
    expect(migration).toContain("'builtin:pi:v1'");
    expect(migration).toContain("'smollm2-360m'");
    expect(migration).toContain("smollm2:360m-instruct-q4_0");
    expect(migration).toContain('"runtimeAdapterId":"pi"');
    expect(migration).toContain("where entity_id = 'builtin:grogoni-default-runtime:v1'");
    expect(migration).not.toContain("where business_id is not null");
    expect(rollback).toContain("parent_id = 'builtin:grogoni-agent:v1'");
  });

  it("binds the platform default to a real backend host and SmolLM installation in place", async () => {
    const migration = await readFile(
      new URL(
        "../infra/db/migrations/077_materialize_platform_default_runtime.sql",
        import.meta.url
      ),
      "utf8"
    );
    const rollback = await readFile(
      new URL(
        "../infra/db/rollbacks/077_materialize_platform_default_runtime.down.sql",
        import.meta.url
      ),
      "utf8"
    );
    expect(migration).toContain("insert into cp2_native_execution_hosts");
    expect(migration).toContain('"type":"backend"');
    expect(migration).toContain('"status":"available"');
    expect(migration).toContain("insert into cp2_native_model_installations");
    expect(migration).toContain('"modelId":"smollm2-360m"');
    expect(migration).toContain("delete from cp2_native_runtime_binding_models");
    expect(migration).toContain("'status', 'active'");
    expect(migration).toContain("set parent_id = 'builtin:pi:v1'");
    expect(migration).toContain("where entity_id = 'builtin:grogoni-default-runtime:v1'");
    expect(rollback).toContain("'status', 'draft'");
  });
});
