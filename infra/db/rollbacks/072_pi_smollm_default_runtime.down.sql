-- Restores only the repository-owned global binding. Tenant/user runtime selections are untouched.
update cp2_native_runtime_bindings
set parent_id = 'builtin:grogoni-agent:v1',
  record = record || jsonb_build_object(
    'agentId', 'builtin:grogoni-agent:v1',
    'name', 'Grogoni default runtime',
    'status', 'draft',
    'configuration', jsonb_build_object('source', 'repository-default'),
    'updatedAt', now()::text,
    'updatedBy', 'system'
  ),
  updated_at = now()
where entity_id = 'builtin:grogoni-default-runtime:v1'
  and parent_id = 'builtin:pi:v1'
  and record -> 'configuration' ->> 'source' = 'repository-default';

delete from cp2_native_runtime_models model
where model.entity_id = 'smollm2-360m'
  and not exists (
    select 1 from cp2_native_runtime_binding_models role
    where role.record ->> 'modelId' = model.entity_id and (role.record ->> 'enabled')::boolean
  );

delete from cp2_native_runtime_agents agent
where agent.entity_id = 'builtin:pi:v1'
  and not exists (
    select 1 from cp2_native_runtime_bindings binding where binding.parent_id = agent.entity_id
  );

delete from cp2_model_catalog catalog
where catalog.entity_id = 'smollm2-360m'
  and not exists (
    select 1 from cp2_native_runtime_binding_models role
    where role.record ->> 'modelId' = catalog.entity_id and (role.record ->> 'enabled')::boolean
  );
