-- Return the global platform slot to the draft state used before migration 077. Tenant/user
-- bindings and model catalog entries are deliberately untouched.
update cp2_native_runtime_bindings
set record = record || jsonb_build_object(
    'status', 'draft',
    'configuration', jsonb_build_object('source', 'repository-default'),
    'updatedAt', now()::text,
    'updatedBy', 'system'
  ),
  updated_at = now()
where entity_id = 'builtin:grogoni-default-runtime:v1';

delete from cp2_native_runtime_binding_models
where entity_id = 'de6d9c28-a4a9-4446-8f17-3a2b1837197e';

delete from cp2_native_model_installations
where entity_id = '65d4a25c-10da-4cfc-ba54-8544d8639464';

delete from cp2_native_execution_hosts
where entity_id = '83ac7c89-b541-44e0-affc-520fa6e12a72';

update cp2_native_runtime_models
set record = record #- '{configuration,executionTarget}', updated_at = now()
where entity_id = 'smollm2-360m';
