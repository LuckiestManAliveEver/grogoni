-- Converts the repository-seeded global default runtime binding from a forced dependency on
-- OpenAI into the provider-neutral, unconfigured slot the native runtime architecture requires
-- (see docs/architecture/provider-neutral-runtime.md). Migration 065 replaced the earlier
-- deterministic default with a hard 'openai-fast' primary role on 'builtin:grogoni-default-runtime:v1'
-- (role fa44cb93-7206-4265-88b9-d8493db05f21) and left the binding 'active' regardless of whether
-- an operator had actually configured OPENAI_API_KEY - that is the seed data behind the Render
-- startup crash this migration fixes forward from.
--
-- This migration touches only that one known, repository-seeded role and binding, using the
-- deterministic ids 065 created. It does not delete the 'openai-fast' catalog model, its
-- execution host (6672a55f-8ef8-46b1-8b11-9b1d92af8c78), or its installation
-- (a45acff5-3cfd-4041-84c1-6a3f665f7726) - those remain as a legitimate, optional model choice an
-- operator can still activate. It does not touch any user-created binding, role, model, host, or
-- installation: every statement below is scoped to the exact repository-seeded entity ids.

update cp2_native_runtime_binding_models
set record = jsonb_set(record, '{enabled}', 'false'::jsonb, true),
  updated_at = now()
where entity_id = 'fa44cb93-7206-4265-88b9-d8493db05f21'
  and parent_id = 'builtin:grogoni-default-runtime:v1'
  and record ->> 'modelId' = 'openai-fast'
  and record ->> 'role' = 'primary';

update cp2_native_runtime_bindings
set record = jsonb_set(record, '{status}', '"draft"'::jsonb, true),
  updated_at = now()
where entity_id = 'builtin:grogoni-default-runtime:v1'
  and record ->> 'isDefault' = 'true';
