import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { RuntimeRegistryImport } from "@grogoni/shared-types";

/**
 * Persists RuntimeRegistryImport rows. Two implementations, same interface: an in-memory one (used
 * by default/in tests, mirroring account-ai-asset-store.ts's createMemoryAccountAiAssetStore), and a
 * Postgres-backed one against cp2_runtime_registry_imports (infra/db/migrations/074_runtime_registry_imports.sql),
 * which follows the exact entity_id/business_id/account_id/user_id/parent_id/record/updated_at
 * convention documented in that migration and in infra/db/migrations/071_platform_catalog.sql.
 */
export interface RuntimeRegistryImportStore {
  create(
    input: Omit<RuntimeRegistryImport, "id" | "createdAt" | "updatedAt">,
    now: string
  ): Promise<RuntimeRegistryImport>;
  get(id: string, accountId: string): Promise<RuntimeRegistryImport | null>;
  update(
    id: string,
    accountId: string,
    patch: Partial<
      Pick<RuntimeRegistryImport, "state" | "stateReason" | "provenance" | "registeredAssetId">
    >,
    now: string
  ): Promise<RuntimeRegistryImport>;
  list(accountId: string): Promise<RuntimeRegistryImport[]>;
}

export class RuntimeRegistryImportNotFoundError extends Error {
  constructor(id: string) {
    super(`Runtime registry import ${id} was not found.`);
    this.name = "RuntimeRegistryImportNotFoundError";
  }
}

export function createMemoryRuntimeRegistryImportStore(): RuntimeRegistryImportStore {
  const imports = new Map<string, RuntimeRegistryImport>();

  return {
    async create(input, now) {
      const record: RuntimeRegistryImport = {
        ...structuredClone(input),
        id: randomUUID(),
        createdAt: now,
        updatedAt: now
      };
      imports.set(record.id, record);
      return structuredClone(record);
    },
    async get(id, accountId) {
      const record = imports.get(id);
      if (record === undefined || record.accountId !== accountId) return null;
      return structuredClone(record);
    },
    async update(id, accountId, patch, now) {
      const record = imports.get(id);
      if (record === undefined || record.accountId !== accountId) {
        throw new RuntimeRegistryImportNotFoundError(id);
      }
      const updated: RuntimeRegistryImport = { ...record, ...patch, updatedAt: now };
      imports.set(id, updated);
      return structuredClone(updated);
    },
    async list(accountId) {
      return [...imports.values()]
        .filter((record) => record.accountId === accountId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map((record) => structuredClone(record));
    }
  };
}

// Only entity_id/business_id/account_id/user_id/parent_id/record/updated_at exist as real columns
// (see infra/db/migrations/074_runtime_registry_imports.sql and 071_platform_catalog.sql's comment
// on this being the fixed contract every generic cp2_* table must have) - there is no separate
// created_at column, so `createdAt` lives inside `record` like every other cp2_* JSONB field that
// isn't one of the seven fixed columns.
interface ImportRow {
  entity_id: string;
  account_id: string;
  record: RuntimeRegistryImport;
  updated_at: Date | string;
}

export function createPostgresRuntimeRegistryImportStore(pool: Pool): RuntimeRegistryImportStore {
  return {
    async create(input, now) {
      const id = randomUUID();
      const record: RuntimeRegistryImport = {
        ...structuredClone(input),
        id,
        createdAt: now,
        updatedAt: now
      };
      await pool.query(
        `insert into cp2_runtime_registry_imports
           (entity_id, business_id, account_id, user_id, parent_id, record, updated_at)
         values ($1, null, $2, null, null, $3::jsonb, $4)`,
        [id, input.accountId, JSON.stringify(record), now]
      );
      return record;
    },
    async get(id, accountId) {
      const result = await pool.query<ImportRow>(
        `select entity_id, account_id, record, updated_at
         from cp2_runtime_registry_imports
         where entity_id = $1 and account_id = $2`,
        [id, accountId]
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToImport(row);
    },
    async update(id, accountId, patch, now) {
      const existing = await pool.query<ImportRow>(
        `select entity_id, account_id, record, updated_at
         from cp2_runtime_registry_imports
         where entity_id = $1 and account_id = $2`,
        [id, accountId]
      );
      const row = existing.rows[0];
      if (row === undefined) throw new RuntimeRegistryImportNotFoundError(id);
      const merged: RuntimeRegistryImport = {
        ...row.record,
        ...patch,
        id,
        accountId,
        updatedAt: now
      };
      await pool.query(
        `update cp2_runtime_registry_imports
         set record = $3::jsonb, updated_at = $4
         where entity_id = $1 and account_id = $2`,
        [id, accountId, JSON.stringify(merged), now]
      );
      return merged;
    },
    async list(accountId) {
      const result = await pool.query<ImportRow>(
        `select entity_id, account_id, record, updated_at
         from cp2_runtime_registry_imports
         where account_id = $1
         order by updated_at desc`,
        [accountId]
      );
      return result.rows.map(rowToImport);
    }
  };
}

function rowToImport(row: ImportRow): RuntimeRegistryImport {
  return { ...row.record, id: row.entity_id, accountId: row.account_id };
}
