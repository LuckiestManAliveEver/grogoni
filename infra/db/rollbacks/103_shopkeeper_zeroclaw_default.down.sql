-- Reverses 103_shopkeeper_zeroclaw_default.sql: the global default slot returns to Pi + SmolLM2
-- 360M on the Vercel inference host (as 079 left it) and Shopkeeper returns to Grogoni's built-in engine. The
-- GPT-6 Luna catalog row stays when a binding still uses it; otherwise it is removed.

delete from cp2_native_runtime_binding_models
where parent_id = 'builtin:grogoni-default-runtime:v1' and role = 'primary';

insert into cp2_native_runtime_binding_models (entity_id, parent_id, record, updated_at) values (
  'de6d9c28-a4a9-4446-8f17-3a2b1837197e',
  'builtin:grogoni-default-runtime:v1',
  '{"id":"de6d9c28-a4a9-4446-8f17-3a2b1837197e","runtimeBindingId":"builtin:grogoni-default-runtime:v1","modelId":"smollm2-360m","role":"primary","priority":0,"executionHostId":"builtin:vercel-inference:v1","configuration":{},"enabled":true,"createdAt":"2026-08-30T00:00:00.000Z","updatedAt":"2026-08-30T00:00:00.000Z"}'::jsonb,
  now()
) on conflict (entity_id) do update
set parent_id = excluded.parent_id, record = excluded.record, updated_at = excluded.updated_at;

update cp2_native_runtime_bindings
set parent_id = 'builtin:pi:v1',
  record = record || jsonb_build_object(
    'agentId', 'builtin:pi:v1',
    'name', 'Pi + SmolLM2 360M default runtime',
    'updatedAt', '2026-08-30T00:00:00.000Z',
    'updatedBy', 'system'
  ),
  updated_at = now()
where entity_id = 'builtin:grogoni-default-runtime:v1';

delete from cp2_native_model_installations where entity_id = '4f0b8f3e-6c1d-4f5e-9a7b-2d3c9e1f6a05';

delete from cp2_native_execution_hosts
where entity_id = 'builtin:provider-router:v1'
  and not exists (
    select 1 from cp2_native_model_installations where parent_id = 'builtin:provider-router:v1'
  );

delete from cp2_native_runtime_agents
where entity_id = 'builtin:shopkeeper:v1'
  and not exists (
    select 1 from cp2_native_runtime_bindings where parent_id = 'builtin:shopkeeper:v1'
  );

update cp2_agent_catalog
set record = record || jsonb_build_object(
    'runtimeAdapterId', 'grogoni',
    'description', 'Safe offline fallback while the open-source agent catalogue is unavailable.'
  ),
  updated_at = now()
where entity_id = 'builtin:shopkeeper';

delete from cp2_agent_catalog where entity_id = 'builtin:shopkeeper-grogoni';

delete from cp2_native_runtime_models
where entity_id = 'gpt-6-luna'
  and not exists (
    select 1 from cp2_native_runtime_binding_models where record ->> 'modelId' = 'gpt-6-luna'
  );

delete from cp2_model_catalog
where entity_id = 'gpt-6-luna'
  and not exists (
    select 1 from cp2_native_runtime_binding_models where record ->> 'modelId' = 'gpt-6-luna'
  );
