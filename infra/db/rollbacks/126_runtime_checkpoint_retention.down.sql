-- Restores the immediate foreign keys. The parent foreign key can only come back once every
-- remaining checkpoint's parent exists again; pruned parents are gone, so their children's
-- parentHandoffId is left as recorded ancestry and the key is added only when it holds.
drop index if exists cp2_runtime_transfers_task_idx;
alter table cp2_runtime_transfers
  alter constraint cp2_runtime_transfers_checkpoint_id_fkey not deferrable;
alter table cp2_runtime_transfers
  alter constraint cp2_runtime_transfers_source_handoff_id_fkey not deferrable;
alter table cp2_runtime_task_instances
  alter constraint cp2_runtime_task_instances_active_handoff_fk not deferrable;
alter table cp2_runtime_task_heads
  alter constraint cp2_runtime_task_heads_active_handoff_fk not deferrable;
drop trigger if exists cp2_runtime_handoffs_parent_exists on cp2_runtime_handoffs;
drop function if exists cp2_runtime_handoffs_parent_exists();
do $$
begin
  if not exists (
    select 1 from cp2_runtime_handoffs child
    where child.parent_handoff_id is not null
      and not exists (select 1 from cp2_runtime_handoffs parent where parent.entity_id = child.parent_handoff_id)
  ) and not exists (select 1 from pg_constraint where conname = 'cp2_runtime_handoffs_parent_fk') then
    alter table cp2_runtime_handoffs add constraint cp2_runtime_handoffs_parent_fk
      foreign key (parent_handoff_id) references cp2_runtime_handoffs (entity_id);
  end if;
end;
$$;
