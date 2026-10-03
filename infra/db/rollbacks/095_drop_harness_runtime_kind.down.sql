-- Restores the pre-migration constraint (kind allows 'harness' again). Rows deleted by the up
-- migration (kind='harness' import records) are not recoverable.

alter table cp2_runtime_registry_imports
  drop constraint cp2_runtime_registry_imports_record_check;

alter table cp2_runtime_registry_imports
  add constraint cp2_runtime_registry_imports_record_check check (
    jsonb_typeof(record) = 'object'
    and record ?& array['id', 'accountId', 'kind', 'provider', 'state', 'ref', 'createdAt', 'updatedAt']
    and record ->> 'id' = entity_id
    and record ->> 'accountId' = account_id
    and record ->> 'kind' in ('agent', 'harness', 'model')
    and record ->> 'provider' in ('grogoni', 'github', 'huggingface')
    and record ->> 'state' in (
      'DISCOVERED', 'INSPECTING', 'VALIDATED', 'IMPORTING', 'REGISTERED', 'PROVISIONING',
      'READY', 'ACTIVE', 'INSPECTION_FAILED', 'VALIDATION_FAILED', 'IMPORT_FAILED',
      'PROVISIONING_FAILED', 'INCOMPATIBLE', 'ACCESS_REQUIRED', 'LICENSE_CONFIRMATION_REQUIRED'
    )
    and jsonb_typeof(record -> 'ref') = 'object'
  );
