-- Harness stops being an independently importable/searchable runtime-registry kind: engine choice
-- collapses into AgentDefinition.runtimeAdapterId (see ADR-collapse-harness-into-agent.md,
-- superseding ADR-device-independent-runtime-and-registry-discovery.md's four-dimension model).
-- The GitHub/HuggingFace harness-import pipeline is removed entirely, so existing kind='harness'
-- import records describe a capability that no longer exists; deleted as operational data, not
-- decision history.

delete from cp2_runtime_registry_imports where record ->> 'kind' = 'harness';

alter table cp2_runtime_registry_imports
  drop constraint cp2_runtime_registry_imports_record_check;

alter table cp2_runtime_registry_imports
  add constraint cp2_runtime_registry_imports_record_check check (
    jsonb_typeof(record) = 'object'
    and record ?& array['id', 'accountId', 'kind', 'provider', 'state', 'ref', 'createdAt', 'updatedAt']
    and record ->> 'id' = entity_id
    and record ->> 'accountId' = account_id
    and record ->> 'kind' in ('agent', 'model')
    and record ->> 'provider' in ('grogoni', 'github', 'huggingface')
    and record ->> 'state' in (
      'DISCOVERED', 'INSPECTING', 'VALIDATED', 'IMPORTING', 'REGISTERED', 'PROVISIONING',
      'READY', 'ACTIVE', 'INSPECTION_FAILED', 'VALIDATION_FAILED', 'IMPORT_FAILED',
      'PROVISIONING_FAILED', 'INCOMPATIBLE', 'ACCESS_REQUIRED', 'LICENSE_CONFIRMATION_REQUIRED'
    )
    and jsonb_typeof(record -> 'ref') = 'object'
  );
