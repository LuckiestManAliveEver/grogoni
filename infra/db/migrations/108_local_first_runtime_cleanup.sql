-- Local-first runtime cleanup (docs/local-first-cloud-audit.md).
--
-- The API no longer serves hosted providers, BYOK keys, the ZeroClaw engine, or the Vercel
-- inference host. Migrations 102-104 left rows that still point at them:
--   * encrypted BYOK keys in inference_provider_credentials that nothing reads or can revoke,
--   * the global default slot with GPT-6 Luna on builtin:provider-router:v1 as primary and SmolLM2
--     on builtin:vercel-inference:v1 as fallback,
--   * shop bindings provisioned on those hosts, and agents/catalog entries naming "zeroclaw".
--
-- This migration is idempotent: every statement converges on the same end state when re-run.
-- The global default rows below use the same ids and shapes NativeRuntimeBindingStore.
-- activateGlobalDefaultModel writes for smollm2-360m on the "local" target (stableUuid in
-- services/api/src/cp2/domains/agent-runtime/shared.ts); it also resets the binding's name and
-- configuration and the rows' timestamps. It assumes PLATFORM_DEFAULT_MODEL_ID is smollm2-360m,
-- the model services/api/src/index.ts registers the Ollama adapter for.
--
-- Run it by hand with every API process stopped, after the snapshot in
-- docs/local-first-cloud-audit.md ("Migration 108" runbook) - never from an auto-deploy whose old
-- instance is still serving: a running API re-saves its in-memory snapshot and writes the old rows
-- back. Every runtime/catalog row it changes is first copied to migration_108_backup, which the
-- rollback restores from; the deleted keys are deliberately not copied.

-- Opt-in guard: 108 deletes stored keys and rewrites runtime rows, so it never runs by accident
-- (an auto-deploy, a stray `pnpm db:migrate`). The operator sets the flag after following the
-- runbook; test and CI databases set it in their environment. Raising here aborts the migration
-- runner before anything changes.
do $guard$
begin
  if coalesce(current_setting('grogoni.allow_108', true), '') <> 'yes' then
    raise exception using
      message = 'Migration 108 is opt-in: it deletes stored provider keys and rewrites runtime rows.',
      hint = 'Follow the "Migration 108" runbook in docs/local-first-cloud-audit.md (stop the API, '
        || 'snapshot), then run: PGOPTIONS=''-c grogoni.allow_108=yes'' pnpm db:migrate';
  end if;
end
$guard$;

-- 0. Backup of every row this migration may change. Captured only on the first run (the table is
-- empty): a re-run must not record 108's own output as "before" state.
create table if not exists migration_108_backup (
  table_name text not null,
  entity_id text not null,
  record jsonb not null,
  captured_at timestamp with time zone not null default now(),
  primary key (table_name, entity_id)
);

insert into migration_108_backup (table_name, entity_id, record)
select captured.table_name, captured.entity_id, captured.record
from (
select 'cp2_native_runtime_binding_models', entity_id, record from cp2_native_runtime_binding_models
union all
select 'cp2_native_runtime_bindings', entity_id, record from cp2_native_runtime_bindings
union all
select 'cp2_native_execution_hosts', entity_id, record from cp2_native_execution_hosts
union all
select 'cp2_native_model_installations', entity_id, record from cp2_native_model_installations
union all
select 'cp2_native_runtime_models', entity_id, record from cp2_native_runtime_models
union all
select 'cp2_native_runtime_agents', entity_id, record from cp2_native_runtime_agents
union all
select 'cp2_agent_catalog', entity_id, record from cp2_agent_catalog
union all
select 'cp2_model_catalog', entity_id, record
from cp2_model_catalog
where entity_id in ('gpt-6-luna', 'openai-fast', 'openai-reasoning', 'qwen3-4b', 'qwen3-4b-grogoni-cloud')
) as captured (table_name, entity_id, record)
where not exists (select 1 from migration_108_backup);

-- 1. Retired BYOK keys. Irreversible by design: no code path can use or revoke them any more.
delete from inference_provider_credentials;

-- The retired "bill inference to my own Hugging Face account" flag; nothing reads it any more.
update cp2_external_registry_connections
set inference_authorized = false
where inference_authorized;

-- 2. Agents and catalog entries that name the retired ZeroClaw engine run on Grogoni's own.
update cp2_native_runtime_agents
set record = record
    || jsonb_build_object(
      'provider', 'grogoni-business-agent',
      'packageRef', null,
      'configuration', (record -> 'configuration') || jsonb_build_object('runtimeAdapterId', 'grogoni')
    ),
  updated_at = now()
where record -> 'configuration' ->> 'runtimeAdapterId' = 'zeroclaw';

update cp2_agent_catalog
set record = record || jsonb_build_object('runtimeAdapterId', 'grogoni'),
  updated_at = now()
where record ->> 'runtimeAdapterId' = 'zeroclaw';

-- Only the built-in Shopkeeper's description named ZeroClaw (migration 103).
update cp2_agent_catalog
set record = record || jsonb_build_object(
    'description', 'Grogoni''s default shop assistant, running on Grogoni''s built-in agent engine. Also the safe fallback while the open-source agent catalogue is unavailable.'
  ),
  updated_at = now()
where entity_id = 'builtin:shopkeeper'
  and record ->> 'description' like '%ZeroClaw%';

-- 3. The global default slot: Shopkeeper with SmolLM2 360M served by local Ollama.
insert into cp2_native_runtime_models (entity_id, record, updated_at) values (
  'smollm2-360m',
  '{"id":"smollm2-360m","name":"SmolLM2 360M Instruct Q4_0","provider":"ollama","providerModelId":"smollm2:360m-instruct-q4_0","runtimeContractVersion":"1","capabilities":["chat","english","instruction-following"],"configuration":{"executionTarget":"local","source":"hosted","format":"remote","contextWindow":8192},"status":"active","createdAt":"2026-10-05T00:00:00.000Z","updatedAt":"2026-10-05T00:00:00.000Z"}'::jsonb,
  now()
) on conflict (entity_id) do update
set record = excluded.record, updated_at = excluded.updated_at;

insert into cp2_native_execution_hosts (entity_id, record, updated_at) values (
  '1e113c34-998f-43f2-8f53-a35f0d3d4ed6',
  '{"id":"1e113c34-998f-43f2-8f53-a35f0d3d4ed6","businessId":null,"accountId":null,"type":"local","name":"Grogoni backend inference runtime","endpoint":null,"status":"healthy","capabilities":["local"],"configuration":{"executionTarget":"local"},"credentialReference":null,"lastKnownHealthyAt":"2026-10-05T00:00:00.000Z","createdAt":"2026-10-05T00:00:00.000Z","updatedAt":"2026-10-05T00:00:00.000Z"}'::jsonb,
  now()
) on conflict (entity_id) do update
set record = excluded.record, updated_at = excluded.updated_at;

insert into cp2_native_model_installations (entity_id, parent_id, record, updated_at) values (
  '6afacf23-7914-436e-8b08-408f3e30d217',
  '1e113c34-998f-43f2-8f53-a35f0d3d4ed6',
  '{"id":"6afacf23-7914-436e-8b08-408f3e30d217","modelId":"smollm2-360m","executionHostId":"1e113c34-998f-43f2-8f53-a35f0d3d4ed6","status":"available","configuration":{},"lastKnownHealthyAt":"2026-10-05T00:00:00.000Z","createdAt":"2026-10-05T00:00:00.000Z","updatedAt":"2026-10-05T00:00:00.000Z"}'::jsonb,
  now()
) on conflict (entity_id) do update
set parent_id = excluded.parent_id, record = excluded.record, updated_at = excluded.updated_at;

-- The slot has exactly one primary: drop the old one(s) before writing the new one.
delete from cp2_native_runtime_binding_models
where parent_id = 'builtin:grogoni-default-runtime:v1'
  and role = 'primary'
  and entity_id <> '29447109-91cf-489d-ad6c-375ae8ca5a99';

insert into cp2_native_runtime_binding_models (entity_id, parent_id, record, updated_at) values (
  '29447109-91cf-489d-ad6c-375ae8ca5a99',
  'builtin:grogoni-default-runtime:v1',
  '{"id":"29447109-91cf-489d-ad6c-375ae8ca5a99","runtimeBindingId":"builtin:grogoni-default-runtime:v1","modelId":"smollm2-360m","role":"primary","priority":0,"executionHostId":"1e113c34-998f-43f2-8f53-a35f0d3d4ed6","configuration":{},"enabled":true,"createdAt":"2026-10-05T00:00:00.000Z","updatedAt":"2026-10-05T00:00:00.000Z"}'::jsonb,
  now()
) on conflict (entity_id) do update
set parent_id = excluded.parent_id, record = excluded.record, updated_at = excluded.updated_at;

update cp2_native_runtime_bindings
set record = record || jsonb_build_object(
    'name', 'Shopkeeper default runtime',
    'status', 'active',
    'isDefault', true,
    'configuration', jsonb_build_object('source', 'repository-default'),
    'updatedAt', '2026-10-05T00:00:00.000Z',
    'updatedBy', 'system'
  ),
  updated_at = now()
where entity_id = 'builtin:grogoni-default-runtime:v1';

-- 4. Nothing serves the retired hosts or models any more.
update cp2_native_execution_hosts
set record = record || jsonb_build_object('status', 'disabled'),
  updated_at = now()
where record ->> 'type' in ('backend', 'vercel')
  and record ->> 'status' <> 'disabled';

update cp2_native_runtime_models
set record = record || jsonb_build_object('status', 'inactive'),
  updated_at = now()
where entity_id in ('gpt-6-luna', 'openai-fast', 'openai-reasoning', 'qwen3-4b', 'qwen3-4b-grogoni-cloud')
  and record ->> 'status' <> 'inactive';

update cp2_native_runtime_binding_models role_row
set record = role_row.record || jsonb_build_object('enabled', false),
  updated_at = now()
where role_row.enabled
  and (
    role_row.model_id in ('gpt-6-luna', 'openai-fast', 'openai-reasoning', 'qwen3-4b', 'qwen3-4b-grogoni-cloud')
    or exists (
      select 1
      from cp2_native_execution_hosts host
      where host.entity_id = role_row.execution_host_id
        and host.record ->> 'type' in ('backend', 'vercel')
    )
  );

-- 5a. A binding whose primary was disabled keeps working on its first remaining fallback (local
-- API processes attached a local SmolLM2 fallback to GPT-6 Luna bindings at turn time). Without
-- this, an active binding with no primary fails topology validation and the store cannot load.
update cp2_native_runtime_binding_models role_row
set record = role_row.record || jsonb_build_object('role', 'primary', 'priority', 0),
  updated_at = now()
where role_row.entity_id in (
  select distinct on (fallback.parent_id) fallback.entity_id
  from cp2_native_runtime_binding_models fallback
  where fallback.role = 'fallback'
    and fallback.enabled
    and not exists (
      select 1
      from cp2_native_runtime_binding_models current_primary
      where current_primary.parent_id = fallback.parent_id
        and current_primary.role = 'primary'
        and current_primary.enabled
    )
  order by fallback.parent_id, fallback.priority, fallback.entity_id
);

-- 5b. A shop binding left with no usable primary is deactivated, so the next turn provisions a
-- fresh local binding through the ordinary zero-setup path instead of failing on a dead primary.
update cp2_native_runtime_bindings binding
set record = binding.record || jsonb_build_object('status', 'inactive'),
  updated_at = now()
where binding.entity_id <> 'builtin:grogoni-default-runtime:v1'
  and binding.record ->> 'status' in ('active', 'draft')
  and not exists (
    select 1
    from cp2_native_runtime_binding_models role_row
    where role_row.parent_id = binding.entity_id
      and role_row.role = 'primary'
      and role_row.enabled
  );

-- 6. Hosted catalog entries stay for history but are no longer offered or routed.
update cp2_model_catalog
set record = record
    || jsonb_build_object('available', false, 'recommended', false)
    || case
      when jsonb_typeof(record -> 'inference') = 'object'
        then jsonb_build_object('inference', (record -> 'inference') || jsonb_build_object('enabled', false))
      else '{}'::jsonb
    end,
  updated_at = now()
where entity_id in ('gpt-6-luna', 'openai-fast', 'openai-reasoning', 'qwen3-4b', 'qwen3-4b-grogoni-cloud');
