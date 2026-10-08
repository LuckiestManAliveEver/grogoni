-- Reverses 108_local_first_runtime_cleanup.sql from migration_108_backup, the copy 108 takes of
-- every runtime and catalog row before changing it.
--
-- Restores every backed-up row's record, re-inserts the binding roles 108 deleted, and removes the
-- global local host/installation/role 108 created when they did not exist before it. Not
-- reversible: the deleted BYOK keys (erased on purpose, never backed up) and the
-- inference_authorized flags. Rows the API wrote after 108 (e.g. a shop provisioned on local
-- Ollama) are kept. Only valid together with reverting the application code: the current code has
-- no adapter for the restored GPT-6 Luna / Vercel rows.

-- Rows 108 created that did not exist before it.
delete from cp2_native_runtime_binding_models
where entity_id = '29447109-91cf-489d-ad6c-375ae8ca5a99'
  and not exists (
    select 1 from migration_108_backup backup
    where backup.table_name = 'cp2_native_runtime_binding_models'
      and backup.entity_id = '29447109-91cf-489d-ad6c-375ae8ca5a99'
  );

delete from cp2_native_model_installations
where entity_id = '6afacf23-7914-436e-8b08-408f3e30d217'
  and not exists (
    select 1 from migration_108_backup backup
    where backup.table_name = 'cp2_native_model_installations'
      and backup.entity_id = '6afacf23-7914-436e-8b08-408f3e30d217'
  );

delete from cp2_native_execution_hosts host
where host.entity_id = '1e113c34-998f-43f2-8f53-a35f0d3d4ed6'
  and not exists (
    select 1 from migration_108_backup backup
    where backup.table_name = 'cp2_native_execution_hosts'
      and backup.entity_id = '1e113c34-998f-43f2-8f53-a35f0d3d4ed6'
  )
  and not exists (
    select 1 from cp2_native_model_installations installation
    where installation.parent_id = host.entity_id
  )
  and not exists (
    select 1 from cp2_native_runtime_binding_models role_row
    where role_row.execution_host_id = host.entity_id
  );

-- Roles: disable the backed-up ones first so restoring them never trips the one-enabled-primary
-- and fallback-priority unique indexes mid-statement, then restore their records.
update cp2_native_runtime_binding_models role_row
set record = role_row.record || jsonb_build_object('enabled', false)
from migration_108_backup backup
where backup.table_name = 'cp2_native_runtime_binding_models'
  and backup.entity_id = role_row.entity_id
  and role_row.enabled;

update cp2_native_runtime_binding_models role_row
set record = backup.record, updated_at = now()
from migration_108_backup backup
where backup.table_name = 'cp2_native_runtime_binding_models'
  and backup.entity_id = role_row.entity_id;

insert into cp2_native_runtime_binding_models (entity_id, parent_id, record, updated_at)
select backup.entity_id, backup.record ->> 'runtimeBindingId', backup.record, now()
from migration_108_backup backup
where backup.table_name = 'cp2_native_runtime_binding_models'
  and exists (
    select 1 from cp2_native_runtime_bindings binding
    where binding.entity_id = backup.record ->> 'runtimeBindingId'
  )
on conflict (entity_id) do nothing;

update cp2_native_runtime_bindings target
set record = backup.record, updated_at = now()
from migration_108_backup backup
where backup.table_name = 'cp2_native_runtime_bindings' and backup.entity_id = target.entity_id;

update cp2_native_execution_hosts target
set record = backup.record, updated_at = now()
from migration_108_backup backup
where backup.table_name = 'cp2_native_execution_hosts' and backup.entity_id = target.entity_id;

update cp2_native_model_installations target
set record = backup.record, updated_at = now()
from migration_108_backup backup
where backup.table_name = 'cp2_native_model_installations' and backup.entity_id = target.entity_id;

update cp2_native_runtime_models target
set record = backup.record, updated_at = now()
from migration_108_backup backup
where backup.table_name = 'cp2_native_runtime_models' and backup.entity_id = target.entity_id;

update cp2_native_runtime_agents target
set record = backup.record, updated_at = now()
from migration_108_backup backup
where backup.table_name = 'cp2_native_runtime_agents' and backup.entity_id = target.entity_id;

update cp2_agent_catalog target
set record = backup.record, updated_at = now()
from migration_108_backup backup
where backup.table_name = 'cp2_agent_catalog' and backup.entity_id = target.entity_id;

update cp2_model_catalog target
set record = backup.record, updated_at = now()
from migration_108_backup backup
where backup.table_name = 'cp2_model_catalog' and backup.entity_id = target.entity_id;

-- A later re-application of 108 captures a fresh backup.
drop table if exists migration_108_backup;
