-- Restore the local host from migration 108; keep Luna data for explicit shop selections.
update cp2_agent_catalog set record = record || jsonb_build_object('runtimeAdapterId', 'grogoni'), updated_at = now()
where entity_id = 'builtin:shopkeeper';
update cp2_native_runtime_agents set record = record || jsonb_build_object('provider', 'grogoni-business-agent',
  'configuration', jsonb_build_object('runtimeAdapterId', 'grogoni', 'requiredModelCapabilities', jsonb_build_array('chat'))), updated_at = now()
where entity_id = 'builtin:shopkeeper:v1';
update cp2_native_runtime_binding_models set record = record || jsonb_build_object(
  'modelId', 'smollm2-360m', 'executionHostId', '1e113c34-998f-43f2-8f53-a35f0d3d4ed6', 'updatedAt', now()), updated_at = now()
where parent_id = 'builtin:grogoni-default-runtime:v1' and role = 'primary';
update cp2_native_runtime_bindings set record = record || jsonb_build_object('name', 'Shopkeeper default runtime', 'updatedAt', now()), updated_at = now()
where entity_id = 'builtin:grogoni-default-runtime:v1';
