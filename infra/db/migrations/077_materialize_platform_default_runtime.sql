-- Materializes the platform default as the same native runtime resources used by every explicit
-- selection. This replaces the old draft/metadata-only default; it does not create a second
-- default table or provider-specific routing path.

insert into cp2_native_execution_hosts (entity_id, record, updated_at) values (
  '83ac7c89-b541-44e0-affc-520fa6e12a72',
  '{"id":"83ac7c89-b541-44e0-affc-520fa6e12a72","businessId":null,"accountId":null,"type":"backend","name":"Grogoni backend inference runtime","endpoint":null,"status":"available","capabilities":["backend"],"configuration":{"executionTarget":"backend"},"credentialReference":null,"lastKnownHealthyAt":null,"createdAt":"2026-08-30T00:00:00.000Z","updatedAt":"2026-08-30T00:00:00.000Z"}'::jsonb,
  now()
) on conflict (entity_id) do update
set record = excluded.record, updated_at = excluded.updated_at;

update cp2_native_runtime_models
set record = jsonb_set(record, '{configuration}', '{"executionTarget":"backend"}'::jsonb, true),
  updated_at = now()
where entity_id = 'smollm2-360m';

insert into cp2_native_model_installations (entity_id, parent_id, record, updated_at) values (
  '65d4a25c-10da-4cfc-ba54-8544d8639464',
  '83ac7c89-b541-44e0-affc-520fa6e12a72',
  '{"id":"65d4a25c-10da-4cfc-ba54-8544d8639464","modelId":"smollm2-360m","executionHostId":"83ac7c89-b541-44e0-affc-520fa6e12a72","status":"available","configuration":{},"lastKnownHealthyAt":null,"createdAt":"2026-08-30T00:00:00.000Z","updatedAt":"2026-08-30T00:00:00.000Z"}'::jsonb,
  now()
) on conflict (entity_id) do update
set parent_id = excluded.parent_id, record = excluded.record, updated_at = excluded.updated_at;

-- The global binding is the platform-default slot. Replace its obsolete deterministic/draft
-- primary in place so all existing conversation foreign keys keep pointing at the same binding.
delete from cp2_native_runtime_binding_models
where parent_id = 'builtin:grogoni-default-runtime:v1' and role = 'primary';

insert into cp2_native_runtime_binding_models (entity_id, parent_id, record, updated_at) values (
  'de6d9c28-a4a9-4446-8f17-3a2b1837197e',
  'builtin:grogoni-default-runtime:v1',
  '{"id":"de6d9c28-a4a9-4446-8f17-3a2b1837197e","runtimeBindingId":"builtin:grogoni-default-runtime:v1","modelId":"smollm2-360m","role":"primary","priority":0,"executionHostId":"83ac7c89-b541-44e0-affc-520fa6e12a72","configuration":{},"enabled":true,"createdAt":"2026-08-30T00:00:00.000Z","updatedAt":"2026-08-30T00:00:00.000Z"}'::jsonb,
  now()
) on conflict (entity_id) do update
set parent_id = excluded.parent_id, record = excluded.record, updated_at = excluded.updated_at;

update cp2_native_runtime_bindings
set parent_id = 'builtin:pi:v1',
  record = record || jsonb_build_object(
    'agentId', 'builtin:pi:v1',
    'name', 'Pi + SmolLM2 360M default runtime',
    'status', 'active',
    'isDefault', true,
    'configuration', jsonb_build_object('source', 'repository-default'),
    'updatedAt', '2026-08-30T00:00:00.000Z',
    'updatedBy', 'system'
  ),
  updated_at = now()
where entity_id = 'builtin:grogoni-default-runtime:v1';
