-- Restores the pre-067 state: the repository-seeded global default binding active again with its
-- openai-fast primary role re-enabled. This does not restore any state migration 067 didn't touch
-- (it never deleted the openai-fast model/host/installation, and it never touched user-created
-- bindings/roles).

update cp2_native_runtime_bindings
set record = jsonb_set(record, '{status}', '"active"'::jsonb, true),
  updated_at = now()
where entity_id = 'builtin:grogoni-default-runtime:v1'
  and record ->> 'isDefault' = 'true';

update cp2_native_runtime_binding_models
set record = jsonb_set(record, '{enabled}', 'true'::jsonb, true),
  updated_at = now()
where entity_id = 'fa44cb93-7206-4265-88b9-d8493db05f21'
  and parent_id = 'builtin:grogoni-default-runtime:v1'
  and record ->> 'modelId' = 'openai-fast'
  and record ->> 'role' = 'primary';
