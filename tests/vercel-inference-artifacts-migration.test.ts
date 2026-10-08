import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Regression coverage for the production incident where migration 079 tried to redefine
// cp2_model_artifacts (migration 066's legacy account-scoped GGUF upload table, columns
// artifact_id/account_id/user_id/...) under the same name as a completely different runtime
// object-storage metadata table (columns id/storage_provider/object_key/...). Postgres's
// `create table if not exists` silently no-oped against the pre-existing legacy table, so the
// migration's own `insert into cp2_model_artifacts (id, ...)` then failed in production with
// `column "id" of relation "cp2_model_artifacts" does not exist` (42703). The fix renames the
// runtime table to cp2_runtime_model_artifacts; these tests pin both schemas apart for good.

async function migrationSql(filename: string): Promise<string> {
  return readFile(new URL(`../infra/db/migrations/${filename}`, import.meta.url), "utf8");
}

async function rollbackSql(filename: string): Promise<string> {
  return readFile(new URL(`../infra/db/rollbacks/${filename}`, import.meta.url), "utf8");
}

describe("cp2_model_artifacts / cp2_runtime_model_artifacts migration ownership (Test A)", () => {
  it("066 owns the legacy account-scoped artifact tables with their real columns", async () => {
    const migration = await migrationSql("066_account_ai_assets.sql");
    expect(migration).toContain("create table if not exists cp2_model_artifacts (");
    expect(migration).toContain("artifact_id text primary key");
    expect(migration).toContain("account_id text not null references cp2_accounts(entity_id)");
    expect(migration).toContain("create table if not exists cp2_model_artifact_chunks (");
  });

  it("079 defines cp2_runtime_model_artifacts and never redefines the legacy table", async () => {
    const migration = await migrationSql("079_vercel_inference_artifacts.sql");
    expect(migration).toContain("create table if not exists cp2_runtime_model_artifacts (");
    expect(migration).toContain("id text primary key");
    expect(migration).toContain("storage_provider text not null");
    expect(migration).toContain("object_key text not null");
    expect(migration).toContain(
      "insert into cp2_runtime_model_artifacts (\n  id, model_id, storage_provider"
    );

    // The historical bug: 079 must not create, alter, or insert into the legacy table by name.
    expect(migration).not.toMatch(/create table[^;]*\bcp2_model_artifacts\b/u);
    expect(migration).not.toMatch(/insert into cp2_model_artifacts\b/u);
    expect(migration).not.toMatch(/alter table cp2_model_artifacts\b/u);
  });

  it("preserves the verified SmolLM2 artifact location and checksum in the seed row", async () => {
    const migration = await migrationSql("079_vercel_inference_artifacts.sql");
    expect(migration).toContain("'builtin:smollm2-360m:q4_0:gguf'");
    expect(migration).toContain("'grogoni-model-artifacts'");
    expect(migration).toContain("'models/smollm2-360m/SmolLM2-360M-Instruct-Q4_0.gguf'");
    expect(migration).toContain(
      "'c3608933eb6e5763b87f769bda40c204dc158333668c7af214644fe39da58627'"
    );
  });
});

describe("migration 080 corrects the runtime artifact table (Test C)", () => {
  it("080 and its rollback update cp2_runtime_model_artifacts, not the legacy table", async () => {
    const migration = await migrationSql("080_correct_smollm2_artifact_size.sql");
    const rollback = await rollbackSql("080_correct_smollm2_artifact_size.down.sql");

    expect(migration).toContain("update cp2_runtime_model_artifacts");
    expect(migration).toContain("size_bytes = 229733280");
    expect(migration).not.toMatch(/update cp2_model_artifacts\b/u);

    expect(rollback).toContain("update cp2_runtime_model_artifacts");
    expect(rollback).toContain("size_bytes = 230000000");
    expect(rollback).not.toMatch(/update cp2_model_artifacts\b/u);
  });
});

describe("migration 079 rollback ownership", () => {
  it("drops only what 079 created, never the legacy artifact tables", async () => {
    const rollback = await rollbackSql("079_vercel_inference_artifacts.down.sql");
    expect(rollback).toContain("drop table if exists cp2_runtime_model_artifacts");
    expect(rollback).not.toMatch(/drop table[^;]*\bcp2_model_artifacts\b/u);
    expect(rollback).not.toMatch(/drop table[^;]*\bcp2_model_artifact_chunks\b/u);
    expect(rollback).not.toMatch(/delete from cp2_model_artifacts\b/u);
    expect(rollback).not.toMatch(/delete from cp2_model_artifact_chunks\b/u);
  });
});

describe("legacy chunk foreign key still targets the legacy table (Test E)", () => {
  it("cp2_model_artifact_chunks.artifact_id references cp2_model_artifacts, not the runtime table", async () => {
    const migration = await migrationSql("066_account_ai_assets.sql");
    expect(migration).toContain(
      "artifact_id text not null references cp2_model_artifacts(artifact_id) on delete cascade"
    );
    expect(migration).not.toMatch(/references cp2_runtime_model_artifacts/u);
  });
});

const requireApiDependency = createRequire(resolve(process.cwd(), "services/api/package.json"));
const { Pool } = requireApiDependency("pg") as {
  Pool: new (options: { connectionString: string }) => {
    query: <T>(text: string, values?: unknown[]) => Promise<{ rows: T[] }>;
    end: () => Promise<void>;
  };
};

// Same opt-in convention as tests/cp2-postgres-store.test.ts: set CP2_POSTGRES_TEST_DATABASE_URL
// to a Postgres instance with the repository's migrations applied (`pnpm db:migrate`) to run this
// against a real database. This is Test D: proving both schemas coexist after 066 -> 079 -> 080.
const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

describePostgres("post-migration schema (Test D, live Postgres)", () => {
  it("cp2_model_artifacts keeps its legacy account-scoped columns", async () => {
    const pool = new Pool({ connectionString: databaseUrl ?? "" });
    try {
      const result = await pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_name = 'cp2_model_artifacts' order by ordinal_position`
      );
      const columns = result.rows.map((row) => row.column_name);
      expect(columns).toEqual(
        expect.arrayContaining([
          "artifact_id",
          "account_id",
          "user_id",
          "model_id",
          "metadata",
          "file_size_bytes",
          "chunk_size_bytes",
          "chunk_count",
          "status",
          "created_at",
          "completed_at",
          "updated_at"
        ])
      );
      expect(columns).not.toContain("id");
      expect(columns).not.toContain("storage_provider");
    } finally {
      await pool.end();
    }
  });

  it("cp2_runtime_model_artifacts has the runtime object-storage schema", async () => {
    const pool = new Pool({ connectionString: databaseUrl ?? "" });
    try {
      const result = await pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_name = 'cp2_runtime_model_artifacts' order by ordinal_position`
      );
      const columns = result.rows.map((row) => row.column_name);
      expect(columns).toEqual([
        "id",
        "model_id",
        "storage_provider",
        "bucket",
        "object_key",
        "format",
        "quantization",
        "size_bytes",
        "sha256",
        "content_type",
        "status",
        "created_at",
        "updated_at"
      ]);
    } finally {
      await pool.end();
    }
  });

  it("seeds the SmolLM2 runtime artifact with the corrected, verified size", async () => {
    const pool = new Pool({ connectionString: databaseUrl ?? "" });
    try {
      const result = await pool.query<{
        id: string;
        model_id: string;
        storage_provider: string;
        bucket: string;
        object_key: string;
        size_bytes: string;
        status: string;
      }>(
        `select id, model_id, storage_provider, bucket, object_key, size_bytes, status
         from cp2_runtime_model_artifacts
         where id = 'builtin:smollm2-360m:q4_0:gguf'`
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        model_id: "smollm2-360m",
        storage_provider: "neon-object-storage",
        bucket: "grogoni-model-artifacts",
        object_key: "models/smollm2-360m/SmolLM2-360M-Instruct-Q4_0.gguf",
        status: "available"
      });
      // Migration 080 corrects the rounded placeholder (230000000) to the real verified byte
      // count - if 080 ever regresses back to updating the wrong table, this catches it.
      expect(result.rows[0]?.size_bytes).toBe("229733280");
    } finally {
      await pool.end();
    }
  });
});
