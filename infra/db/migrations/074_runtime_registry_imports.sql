-- Persists RuntimeRegistryImport rows (packages/shared-types/src/runtime-registry.ts) for the
-- unified GitHub/Hugging Face/Grogoni runtime-asset search and import pipeline
-- (services/api/src/cp2/runtime-registry/). Follows the exact generic
-- entity_id/business_id/account_id/user_id/parent_id/record/updated_at contract documented in
-- infra/db/migrations/071_platform_catalog.sql: these seven columns are the fixed shape the
-- persistence layer expects for every cp2_* table, regardless of whether a given table needs every
-- scoping column. An import is account-scoped, not shop-scoped, so business_id/user_id/parent_id
-- stay null; account_id is the acting account's id and is how every query in
-- services/api/src/cp2/runtime-registry/import-store.ts filters. `record` carries the full
-- RuntimeRegistryImport JSON, including its own `id`/`accountId`/`createdAt`/`updatedAt` fields --
-- there is no separate created_at column, matching every other generic cp2_* table.
create table cp2_runtime_registry_imports (
  entity_id text primary key,
  business_id text,
  account_id text not null,
  user_id text,
  parent_id text,
  record jsonb not null,
  updated_at timestamp with time zone not null default now(),
  constraint cp2_runtime_registry_imports_record_check check (
    jsonb_typeof(record) = 'object'
    and record ?& array['id', 'accountId', 'kind', 'provider', 'state', 'ref', 'createdAt', 'updatedAt']
    and record ->> 'id' = entity_id
    and record ->> 'accountId' = account_id
    and record ->> 'kind' in ('agent', 'harness', 'model')
    and record ->> 'provider' in ('grogoni', 'github', 'huggingface')
    and record ->> 'state' in (
      'DISCOVERED', 'INSPECTING', 'VALIDATED', 'IMPORTING', 'REGISTERED', 'PROVISIONING',
      'READY', 'ACTIVE', 'INSPECTION_FAILED', 'VALIDATION_FAILED', 'IMPORT_FAILED',
      'PROVISIONING_FAILED', 'INCOMPATIBLE', 'ACCESS_REQUIRED', 'LICENSE_CONFIRMATION_REQUIRED'
    )
    and jsonb_typeof(record -> 'ref') = 'object'
  )
);

-- An account looks up its own imports (list) and polls a single import's state (get) far more often
-- than anything else touches this table; account_id is already covered by the primary lookup path
-- via entity_id+account_id, but a dedicated index keeps `list` (order by updated_at desc) and
-- multi-row lookups off a full table scan as import history grows.
create index cp2_runtime_registry_imports_account_id_updated_at_idx
  on cp2_runtime_registry_imports (account_id, updated_at desc);
