-- Permanently retire the superseded selection architecture. Legacy rows are preserved in the
-- native graph as inactive/draft/unavailable records; none are treated as verified execution
-- state. The source tables are dropped only after the archival inserts complete.

insert into cp2_native_execution_hosts
  (entity_id, business_id, account_id, user_id, record, updated_at)
select
  h.entity_id,
  h.business_id,
  h.account_id,
  h.user_id,
  jsonb_build_object(
    'id', h.entity_id,
    'businessId', h.business_id,
    'accountId', h.account_id,
    'type', 'retired-fabric-host',
    'name', coalesce(h.record ->> 'name', 'Retired Execution Fabric host'),
    'endpoint', null,
    'status', 'unavailable',
    'capabilities', coalesce(h.record -> 'declaredRuntimes', '[]'::jsonb),
    'configuration', jsonb_build_object(
      'source', 'retired-execution-fabric-host',
      'legacyTrustLevel', h.record -> 'trustLevel',
      'legacyBrokerNodeId', h.record -> 'brokerNodeId',
      'legacyMaxConcurrentJobs', h.record -> 'maxConcurrentJobs'
    ),
    'credentialReference', null,
    'lastKnownHealthyAt', null,
    'createdAt', coalesce(h.record ->> 'createdAt', h.updated_at::text),
    'updatedAt', coalesce(h.record ->> 'updatedAt', h.updated_at::text)
  ),
  h.updated_at
from cp2_runtime_hosts h
on conflict (entity_id) do nothing;

with legacy_models as (
  select distinct i.record ->> 'modelId' as model_id, i.updated_at
  from cp2_runtime_model_installations i
  where nullif(i.record ->> 'modelId', '') is not null
  union
  select distinct jsonb_array_elements_text(
    coalesce(p.record -> 'preferredModelIds', '[]'::jsonb)
  ) as model_id, p.updated_at
  from cp2_model_preferences p
  union
  select distinct jsonb_array_elements_text(
    coalesce(p.record -> 'fallbackModelIds', '[]'::jsonb)
  ) as model_id, p.updated_at
  from cp2_model_preferences p
)
insert into cp2_native_runtime_models (entity_id, record, updated_at)
select distinct on (model_id)
  model_id,
  jsonb_build_object(
    'id', model_id,
    'name', model_id,
    'provider', case when model_id like 'openai-%' then 'openai' else 'legacy' end,
    'providerModelId', model_id,
    'runtimeContractVersion', '1',
    'capabilities', jsonb_build_array('chat', 'tool-routing'),
    'configuration', jsonb_build_object('source', 'retired-execution-fabric'),
    'status', 'active',
    'createdAt', updated_at::text,
    'updatedAt', updated_at::text
  ),
  updated_at
from legacy_models
where nullif(model_id, '') is not null
order by model_id, updated_at desc
on conflict (entity_id) do nothing;

insert into cp2_native_model_installations
  (entity_id, business_id, account_id, user_id, parent_id, record, updated_at)
select
  i.entity_id,
  i.business_id,
  i.account_id,
  i.user_id,
  i.parent_id,
  jsonb_build_object(
    'id', i.entity_id,
    'modelId', i.record ->> 'modelId',
    'executionHostId', i.parent_id,
    'status', 'unavailable',
    'configuration', jsonb_build_object(
      'source', 'retired-execution-fabric-installation',
      'legacyStatus', i.record -> 'status'
    ),
    'lastKnownHealthyAt', null,
    'createdAt', coalesce(i.record ->> 'installedAt', i.updated_at::text),
    'updatedAt', coalesce(i.record ->> 'updatedAt', i.updated_at::text)
  ),
  i.updated_at
from cp2_runtime_model_installations i
where i.parent_id is not null
  and nullif(i.record ->> 'modelId', '') is not null
on conflict (entity_id) do nothing;

insert into cp2_native_runtime_agents
  (entity_id, business_id, account_id, user_id, record, updated_at)
select
  'native:retired-preference-agent:' || p.entity_id,
  p.business_id,
  coalesce(p.account_id, b.account_id),
  p.user_id,
  jsonb_build_object(
    'id', 'native:retired-preference-agent:' || p.entity_id,
    'businessId', p.business_id,
    'accountId', coalesce(p.account_id, b.account_id),
    'name', 'Retired ' || coalesce(p.record ->> 'scope', 'unknown') || ' preference holder',
    'provider', 'grogoni-migrated-preference',
    'packageRef', null,
    'version', '1',
    'runtimeContractVersion', '1',
    'capabilities', '[]'::jsonb,
    'configuration', jsonb_build_object(
      'requiredModelCapabilities', coalesce(p.record -> 'requiredCapabilities', '[]'::jsonb)
    ),
    'status', 'inactive',
    'createdAt', coalesce(p.record ->> 'createdAt', p.updated_at::text),
    'updatedAt', coalesce(p.record ->> 'updatedAt', p.updated_at::text)
  ),
  p.updated_at
from cp2_model_preferences p
left join cp2_businesses b on b.entity_id = p.business_id
on conflict (entity_id) do nothing;

insert into cp2_native_runtime_bindings
  (entity_id, business_id, account_id, user_id, parent_id, record, updated_at)
select
  'native:retired-preference:' || p.entity_id,
  p.business_id,
  coalesce(p.account_id, b.account_id),
  p.user_id,
  'native:retired-preference-agent:' || p.entity_id,
  jsonb_build_object(
    'id', 'native:retired-preference:' || p.entity_id,
    'businessId', p.business_id,
    'accountId', coalesce(p.account_id, b.account_id),
    'agentId', 'native:retired-preference-agent:' || p.entity_id,
    'name', 'Archived Execution Fabric preference',
    'status', 'draft',
    'isDefault', false,
    'configuration', jsonb_build_object(
      'source', 'retired-execution-fabric-preference',
      'legacyPreferenceId', p.entity_id,
      'legacyScope', p.record -> 'scope',
      'legacyScopeId', p.record -> 'scopeId',
      'executionPreference', p.record -> 'executionPreference',
      'qualityPreference', p.record -> 'qualityPreference',
      'allowCloudFallback', p.record -> 'allowCloudFallback',
      'maxCostPerRequest', p.record -> 'maxCostPerRequest',
      'maxLatencyMs', p.record -> 'maxLatencyMs',
      'minimumContextWindow', p.record -> 'minimumContextWindow'
    ),
    'runtimeContractVersion', '1',
    'createdAt', coalesce(p.record ->> 'createdAt', p.updated_at::text),
    'updatedAt', coalesce(p.record ->> 'updatedAt', p.updated_at::text),
    'updatedBy', coalesce(p.record ->> 'updatedBy', 'migration')
  ),
  p.updated_at
from cp2_model_preferences p
left join cp2_businesses b on b.entity_id = p.business_id
on conflict (entity_id) do nothing;

with expanded as (
  select p.entity_id as preference_id, model.model_id, model.source_rank, model.ordinality,
    p.business_id, coalesce(p.account_id, b.account_id) as account_id, p.user_id, p.updated_at
  from cp2_model_preferences p
  left join cp2_businesses b on b.entity_id = p.business_id
  cross join lateral (
    select value as model_id, 0 as source_rank, ordinality
    from jsonb_array_elements_text(
      coalesce(p.record -> 'preferredModelIds', '[]'::jsonb)
    ) with ordinality preferred(value, ordinality)
    union all
    select value as model_id, 1 as source_rank, ordinality
    from jsonb_array_elements_text(
      coalesce(p.record -> 'fallbackModelIds', '[]'::jsonb)
    ) with ordinality fallback(value, ordinality)
  ) model
), deduplicated as (
  select distinct on (preference_id, model_id) *
  from expanded
  where nullif(model_id, '') is not null
  order by preference_id, model_id, source_rank, ordinality
), ranked as (
  select *, row_number() over (
    partition by preference_id order by source_rank, ordinality, model_id
  ) as model_rank
  from deduplicated
)
insert into cp2_native_runtime_binding_models
  (entity_id, business_id, account_id, user_id, parent_id, record, updated_at)
select
  'native:retired-preference-role:' || preference_id || ':' || md5(model_id),
  business_id,
  account_id,
  user_id,
  'native:retired-preference:' || preference_id,
  jsonb_build_object(
    'id', 'native:retired-preference-role:' || preference_id || ':' || md5(model_id),
    'runtimeBindingId', 'native:retired-preference:' || preference_id,
    'modelId', model_id,
    'role', case when model_rank = 1 then 'primary' else 'fallback' end,
    'priority', case when model_rank = 1 then 0 else model_rank - 2 end,
    'executionHostId', null,
    'configuration', jsonb_build_object('source', 'retired-execution-fabric-preference'),
    'enabled', true,
    'createdAt', updated_at::text,
    'updatedAt', updated_at::text
  ),
  updated_at
from ranked
on conflict (entity_id) do nothing;

-- Replace the deterministic compatibility default with a real supported generative model. It is
-- intentionally unavailable in persistent state until the API completes a live activation probe.
insert into cp2_native_runtime_models (entity_id, record)
values (
  'openai-fast',
  '{"id":"openai-fast","name":"OpenAI fast","provider":"openai","providerModelId":"openai-fast","runtimeContractVersion":"1","capabilities":["chat","tool-routing"],"configuration":{"executionTarget":"openai","activationRequired":true},"status":"active","createdAt":"2026-08-28T00:00:00.000Z","updatedAt":"2026-08-28T00:00:00.000Z"}'::jsonb
)
on conflict (entity_id) do update set record = excluded.record, updated_at = now();

insert into cp2_native_execution_hosts (entity_id, record)
values (
  '6672a55f-8ef8-46b1-8b11-9b1d92af8c78',
  '{"id":"6672a55f-8ef8-46b1-8b11-9b1d92af8c78","businessId":null,"accountId":null,"type":"openai","name":"OpenAI hosted runtime","endpoint":null,"status":"unavailable","capabilities":["openai","chat","tool-routing"],"configuration":{"executionTarget":"openai","activationRequired":true},"credentialReference":"env:OPENAI_API_KEY","lastKnownHealthyAt":null,"createdAt":"2026-08-28T00:00:00.000Z","updatedAt":"2026-08-28T00:00:00.000Z"}'::jsonb
)
on conflict (entity_id) do update set record = excluded.record, updated_at = now();

insert into cp2_native_model_installations (entity_id, parent_id, record)
values (
  'a45acff5-3cfd-4041-84c1-6a3f665f7726',
  '6672a55f-8ef8-46b1-8b11-9b1d92af8c78',
  '{"id":"a45acff5-3cfd-4041-84c1-6a3f665f7726","modelId":"openai-fast","executionHostId":"6672a55f-8ef8-46b1-8b11-9b1d92af8c78","status":"unavailable","configuration":{"activationRequired":true},"lastKnownHealthyAt":null,"createdAt":"2026-08-28T00:00:00.000Z","updatedAt":"2026-08-28T00:00:00.000Z"}'::jsonb
)
on conflict (entity_id) do update set
  parent_id = excluded.parent_id, record = excluded.record, updated_at = now();

update cp2_native_runtime_agents
set record = record || '{"capabilities":["tools","mcp"],"configuration":{"requiredModelCapabilities":["chat","tool-routing"]}}'::jsonb,
  updated_at = now()
where entity_id = 'builtin:grogoni-agent:v1';

update cp2_native_runtime_bindings
set record = jsonb_set(
    jsonb_set(record, '{configuration}', '{"source":"repository-default","activationRequired":true}'::jsonb, true),
    '{updatedAt}', to_jsonb('2026-08-28T00:00:00.000Z'::text), true
  ),
  updated_at = now()
where entity_id = 'builtin:grogoni-default-runtime:v1';

update cp2_native_runtime_binding_models
set record = jsonb_build_object(
    'id', 'fa44cb93-7206-4265-88b9-d8493db05f21',
    'runtimeBindingId', 'builtin:grogoni-default-runtime:v1',
    'modelId', 'openai-fast',
    'role', 'primary',
    'priority', 0,
    'executionHostId', '6672a55f-8ef8-46b1-8b11-9b1d92af8c78',
    'configuration', jsonb_build_object('activationRequired', true),
    'enabled', true,
    'createdAt', coalesce(record ->> 'createdAt', '2026-08-28T00:00:00.000Z'),
    'updatedAt', '2026-08-28T00:00:00.000Z'
  ),
  updated_at = now()
where entity_id = 'fa44cb93-7206-4265-88b9-d8493db05f21';

drop table cp2_runtime_model_installations;
drop table cp2_runtime_hosts;
drop table cp2_model_preferences;

