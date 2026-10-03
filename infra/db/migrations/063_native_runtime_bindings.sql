-- Native in-process runtime bindings. Additive replacement for the feature-flagged Execution
-- Fabric selection path; old Fabric tables remain during stabilization.

create table if not exists cp2_native_runtime_agents (
  entity_id text primary key,
  business_id text,
  account_id text,
  user_id text,
  parent_id text,
  record jsonb not null,
  updated_at timestamp with time zone not null default now(),
  constraint cp2_native_runtime_agents_record_check check (
    record ->> 'status' in ('active', 'inactive')
    and char_length(record ->> 'runtimeContractVersion') between 1 and 40
  )
);

create table if not exists cp2_native_runtime_models (
  entity_id text primary key,
  business_id text,
  account_id text,
  user_id text,
  parent_id text,
  record jsonb not null,
  updated_at timestamp with time zone not null default now(),
  constraint cp2_native_runtime_models_record_check check (
    record ->> 'status' in ('active', 'inactive')
    and char_length(record ->> 'runtimeContractVersion') between 1 and 40
  )
);

create table if not exists cp2_native_execution_hosts (
  entity_id text primary key,
  business_id text,
  account_id text,
  user_id text,
  parent_id text,
  record jsonb not null,
  updated_at timestamp with time zone not null default now(),
  constraint cp2_native_execution_hosts_record_check check (
    record ->> 'status' in ('available', 'unavailable')
    and not (coalesce(record ->> 'endpoint', '') ~* '://[^/@:]+:[^/@]+@')
    and not (coalesce(record ->> 'endpoint', '') ~* '[?&](api_key|apikey|token|password|secret)=')
  )
);

create table if not exists cp2_native_model_installations (
  entity_id text primary key,
  business_id text,
  account_id text,
  user_id text,
  parent_id text not null references cp2_native_execution_hosts(entity_id) on delete cascade,
  model_id text generated always as (record ->> 'modelId') stored,
  record jsonb not null,
  updated_at timestamp with time zone not null default now(),
  constraint cp2_native_model_installations_model_fk
    foreign key (model_id) references cp2_native_runtime_models(entity_id) on delete cascade,
  constraint cp2_native_model_installations_record_check check (
    record ->> 'executionHostId' = parent_id
    and record ->> 'status' in ('available', 'unavailable')
  ),
  constraint cp2_native_model_installations_unique unique (model_id, parent_id)
);

create table if not exists cp2_native_runtime_bindings (
  entity_id text primary key,
  business_id text,
  account_id text,
  user_id text,
  parent_id text not null references cp2_native_runtime_agents(entity_id) on delete restrict,
  record jsonb not null,
  updated_at timestamp with time zone not null default now(),
  constraint cp2_native_runtime_bindings_record_check check (
    record ->> 'agentId' = parent_id
    and record ->> 'status' in ('draft', 'active', 'inactive', 'failed')
    and jsonb_typeof(record -> 'isDefault') = 'boolean'
  ),
  constraint cp2_native_runtime_bindings_default_scope_check check (
    record ->> 'isDefault' <> 'true' or (business_id is null and account_id is null)
  )
);

create unique index if not exists cp2_native_runtime_bindings_one_global_default_idx
  on cp2_native_runtime_bindings ((record ->> 'isDefault'))
  where record ->> 'isDefault' = 'true' and record ->> 'status' = 'active';

create index if not exists cp2_native_runtime_bindings_business_agent_idx
  on cp2_native_runtime_bindings (business_id, parent_id)
  where record ->> 'status' = 'active';

create table if not exists cp2_native_runtime_binding_models (
  entity_id text primary key,
  business_id text,
  account_id text,
  user_id text,
  parent_id text not null references cp2_native_runtime_bindings(entity_id) on delete cascade,
  model_id text generated always as (record ->> 'modelId') stored,
  execution_host_id text generated always as (record ->> 'executionHostId') stored,
  role text generated always as (record ->> 'role') stored,
  priority integer generated always as ((record ->> 'priority')::integer) stored,
  enabled boolean generated always as ((record ->> 'enabled')::boolean) stored,
  record jsonb not null,
  updated_at timestamp with time zone not null default now(),
  constraint cp2_native_runtime_binding_models_model_fk
    foreign key (model_id) references cp2_native_runtime_models(entity_id) on delete restrict,
  constraint cp2_native_runtime_binding_models_host_fk
    foreign key (execution_host_id) references cp2_native_execution_hosts(entity_id) on delete restrict,
  constraint cp2_native_runtime_binding_models_record_check check (
    record ->> 'runtimeBindingId' = parent_id
    and char_length(record ->> 'role') between 1 and 80
    and (record ->> 'priority')::integer >= 0
    and jsonb_typeof(record -> 'enabled') = 'boolean'
  )
);

create unique index if not exists cp2_native_runtime_binding_models_one_primary_idx
  on cp2_native_runtime_binding_models (parent_id)
  where role = 'primary' and enabled;

create unique index if not exists cp2_native_runtime_binding_models_fallback_priority_idx
  on cp2_native_runtime_binding_models (parent_id, priority)
  where role = 'fallback' and enabled;

create index if not exists cp2_native_runtime_binding_models_resolution_idx
  on cp2_native_runtime_binding_models (parent_id, role, priority)
  where enabled;

create or replace function check_native_runtime_binding_primary()
returns trigger language plpgsql as $$
declare
  binding_key text;
begin
  binding_key := case when tg_table_name = 'cp2_native_runtime_bindings'
    then coalesce(new.entity_id, old.entity_id)
    else coalesce(new.parent_id, old.parent_id)
  end;
  if exists (
    select 1 from cp2_native_runtime_bindings b
    where b.entity_id = binding_key and b.record ->> 'status' = 'active'
  ) and (
    select count(*) from cp2_native_runtime_binding_models bm
    where bm.parent_id = binding_key and bm.role = 'primary' and bm.enabled
  ) <> 1 then
    raise exception 'active runtime binding % must have exactly one enabled primary model', binding_key
      using errcode = '23514';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists cp2_native_runtime_bindings_primary_guard on cp2_native_runtime_bindings;
create constraint trigger cp2_native_runtime_bindings_primary_guard
after insert or update on cp2_native_runtime_bindings
deferrable initially deferred for each row execute function check_native_runtime_binding_primary();

drop trigger if exists cp2_native_runtime_binding_models_primary_guard on cp2_native_runtime_binding_models;
create constraint trigger cp2_native_runtime_binding_models_primary_guard
after insert or update or delete on cp2_native_runtime_binding_models
deferrable initially deferred for each row execute function check_native_runtime_binding_primary();

alter table cp2_conversations
  add column if not exists runtime_binding_id text
  generated always as (record ->> 'runtimeBindingId') stored;
alter table cp2_conversations
  drop constraint if exists cp2_conversations_runtime_binding_fk;
alter table cp2_conversations
  add constraint cp2_conversations_runtime_binding_fk
  foreign key (runtime_binding_id) references cp2_native_runtime_bindings(entity_id) on delete restrict;
create index if not exists cp2_conversations_runtime_binding_idx
  on cp2_conversations (runtime_binding_id);

alter table conversations add column if not exists runtime_binding_id text;
alter table conversations drop constraint if exists conversations_runtime_binding_fk;
alter table conversations add constraint conversations_runtime_binding_fk
  foreign key (runtime_binding_id) references cp2_native_runtime_bindings(entity_id) on delete restrict;
create index if not exists conversations_runtime_binding_idx on conversations (runtime_binding_id);

-- Real repository-supported default: the built-in deterministic agent/model path. It is the only
-- runtime that is executable without assuming an optional provider or an installed device.
insert into cp2_native_runtime_agents (entity_id, record)
values (
  'builtin:grogoni-agent:v1',
  '{"id":"builtin:grogoni-agent:v1","businessId":null,"accountId":null,"name":"Grogoni built-in agent","provider":"grogoni","packageRef":null,"version":"1","runtimeContractVersion":"1","capabilities":["deterministic-tools","mcp"],"configuration":{"requiredModelCapabilities":[]},"status":"active","createdAt":"2026-08-27T00:00:00.000Z","updatedAt":"2026-08-27T00:00:00.000Z"}'::jsonb
) on conflict (entity_id) do nothing;

insert into cp2_native_runtime_models (entity_id, record)
values (
  'grogoniclaw-local',
  '{"id":"grogoniclaw-local","name":"Grogoni deterministic compatibility fallback","provider":"grogoni","providerModelId":"grogoniclaw-local","runtimeContractVersion":"1","capabilities":["tool-routing","offline"],"configuration":{"executionTarget":"backend","deterministic":true},"status":"active","createdAt":"2026-08-27T00:00:00.000Z","updatedAt":"2026-08-27T00:00:00.000Z"}'::jsonb
) on conflict (entity_id) do nothing;

insert into cp2_native_execution_hosts (entity_id, record)
values (
  '20b0f146-aa96-4d03-91e2-6a58049883c8',
  '{"id":"20b0f146-aa96-4d03-91e2-6a58049883c8","businessId":null,"accountId":null,"type":"in-process","name":"Grogoni API process","endpoint":null,"status":"available","capabilities":["backend","deterministic-tools"],"configuration":{},"credentialReference":null,"lastKnownHealthyAt":"2026-08-27T00:00:00.000Z","createdAt":"2026-08-27T00:00:00.000Z","updatedAt":"2026-08-27T00:00:00.000Z"}'::jsonb
) on conflict (entity_id) do nothing;

insert into cp2_native_model_installations (entity_id, parent_id, record)
values (
  '27cf0dc8-7e1f-4848-8dfe-0dbace223125',
  '20b0f146-aa96-4d03-91e2-6a58049883c8',
  '{"id":"27cf0dc8-7e1f-4848-8dfe-0dbace223125","modelId":"grogoniclaw-local","executionHostId":"20b0f146-aa96-4d03-91e2-6a58049883c8","status":"available","configuration":{},"lastKnownHealthyAt":"2026-08-27T00:00:00.000Z","createdAt":"2026-08-27T00:00:00.000Z","updatedAt":"2026-08-27T00:00:00.000Z"}'::jsonb
) on conflict (entity_id) do nothing;

insert into cp2_native_runtime_bindings (entity_id, parent_id, record)
values (
  'builtin:grogoni-default-runtime:v1',
  'builtin:grogoni-agent:v1',
  '{"id":"builtin:grogoni-default-runtime:v1","businessId":null,"accountId":null,"agentId":"builtin:grogoni-agent:v1","name":"Grogoni default runtime","status":"active","isDefault":true,"configuration":{"source":"repository-default"},"runtimeContractVersion":"1","createdAt":"2026-08-27T00:00:00.000Z","updatedAt":"2026-08-27T00:00:00.000Z","updatedBy":"system"}'::jsonb
) on conflict (entity_id) do nothing;

insert into cp2_native_runtime_binding_models (entity_id, parent_id, record)
values (
  'fa44cb93-7206-4265-88b9-d8493db05f21',
  'builtin:grogoni-default-runtime:v1',
  '{"id":"fa44cb93-7206-4265-88b9-d8493db05f21","runtimeBindingId":"builtin:grogoni-default-runtime:v1","modelId":"grogoniclaw-local","role":"primary","priority":0,"executionHostId":"20b0f146-aa96-4d03-91e2-6a58049883c8","configuration":{},"enabled":true,"createdAt":"2026-08-27T00:00:00.000Z","updatedAt":"2026-08-27T00:00:00.000Z"}'::jsonb
) on conflict (entity_id) do nothing;

-- Safe legacy backfill. A verified AgentModelBinding has enough information to map one primary
-- and, when present, one ordered fallback. Fabric preferences without a verified binding remain
-- for the dry-run backfill script to report as ambiguous rather than guessing a host.
insert into cp2_native_runtime_agents (entity_id, business_id, account_id, record)
select distinct on (record ->> 'agentId')
  record ->> 'agentId', business_id, account_id,
  jsonb_build_object(
    'id', record ->> 'agentId', 'businessId', business_id, 'accountId', account_id,
    'name', 'Grogoni business agent', 'provider', 'grogoni-business-agent', 'packageRef', null,
    'version', '1', 'runtimeContractVersion', '1', 'capabilities', jsonb_build_array('tools','mcp'),
    'configuration', jsonb_build_object('requiredModelCapabilities', jsonb_build_array('tool-routing')),
    'status', 'active', 'createdAt', record ->> 'createdAt', 'updatedAt', record ->> 'updatedAt'
  )
from cp2_agent_model_bindings where record ->> 'status' = 'active'
order by record ->> 'agentId', updated_at desc
on conflict (entity_id) do nothing;

insert into cp2_native_runtime_models (entity_id, record)
select model_id,
  jsonb_build_object(
    'id', model_id, 'name', model_id, 'provider',
      case when model_id like 'openai-%' then 'openai' else 'local' end,
    'providerModelId', model_id, 'runtimeContractVersion', '1',
    'capabilities', jsonb_build_array('chat','tool-routing'),
    'configuration', jsonb_build_object('source','legacy-binding'), 'status','active',
    'createdAt', now(), 'updatedAt', now()
  )
from (
  select distinct record ->> 'modelId' as model_id from cp2_agent_model_bindings
  where record ->> 'status' = 'active'
  union
  select distinct record ->> 'fallbackModelId' from cp2_agent_model_bindings
  where record ->> 'status' = 'active' and record ->> 'fallbackModelId' is not null
) models
where model_id is not null
on conflict (entity_id) do nothing;

-- Existing conversations receive the real global default unless a later script maps a verified
-- business binding. This is intentionally JSON-authoritative for the CP2 normalized store.
update cp2_conversations
set record = jsonb_set(record, '{runtimeBindingId}', to_jsonb('builtin:grogoni-default-runtime:v1'::text), true)
where record ->> 'runtimeBindingId' is null;
update conversations set runtime_binding_id = 'builtin:grogoni-default-runtime:v1'
where runtime_binding_id is null;
