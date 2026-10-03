-- Reverts only the runtime object-storage structures and runtime-graph edits migration 079 made.
-- Never touch cp2_model_artifacts / cp2_model_artifact_chunks here - those belong to migration 066
-- (the legacy account-scoped artifact subsystem) and are owned by that migration's rollback.
drop table if exists cp2_runtime_model_artifacts;

-- Repoint the binding's execution host before deleting the Vercel host row below:
-- cp2_native_runtime_binding_models.execution_host_id is a generated column with an
-- `on delete restrict` FK to cp2_native_execution_hosts(entity_id), so the delete would fail
-- while any binding row still points at 'builtin:vercel-inference:v1'.
update cp2_native_runtime_binding_models
set record = jsonb_set(
    record,
    '{executionHostId}',
    '"83ac7c89-b541-44e0-affc-520fa6e12a72"'::jsonb,
    true
  ),
  updated_at = now()
where parent_id = 'builtin:grogoni-default-runtime:v1' and role = 'primary';

delete from cp2_native_model_installations
where entity_id = 'builtin:smollm2-360m:vercel:v1';

delete from cp2_native_execution_hosts
where entity_id = 'builtin:vercel-inference:v1';

update cp2_native_runtime_models
set record = jsonb_set(
    record #- '{configuration,artifactId}',
    '{configuration,executionTarget}',
    '"backend"'::jsonb,
    true
  ),
  updated_at = now()
where entity_id = 'smollm2-360m';

-- Restore the Render backend host/install that migration 077 originally materialized as available.
update cp2_native_execution_hosts
set record = jsonb_set(record, '{status}', '"available"'::jsonb, true), updated_at = now()
where entity_id = '83ac7c89-b541-44e0-affc-520fa6e12a72';

update cp2_native_model_installations
set record = jsonb_set(record, '{status}', '"available"'::jsonb, true), updated_at = now()
where parent_id = '83ac7c89-b541-44e0-affc-520fa6e12a72';
