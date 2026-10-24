-- Runtime checkpoint retention (services/api/src/cp2/domains/runtime-handoff/checkpoint-retention.ts).
--
-- Superseded checkpoints are now deleted on the write that adds a newer one. Two constraints from
-- 083/085 stood in the way:
--
-- 1. cp2_runtime_handoffs_parent_fk made every checkpoint keep its parent, so a linear chain could
--    never lose an old link. parentHandoffId stays in each (immutable) record as ancestry, but the
--    parent may now be pruned. A new checkpoint must still name an existing parent when it is
--    inserted: the trigger below checks that at the end of each insert statement (an offline chain
--    inserts parent and child in one statement), which is what the foreign key guaranteed for
--    inserts. The application checks it too (syncOneOfflineCheckpoint).
-- 2. Task heads, task instances and transfers point at checkpoints with immediate foreign keys.
--    The snapshot writer deletes pruned checkpoints before it writes the heads, instances and
--    transfers that stopped pointing at them, so these keys are checked at commit instead.
--
-- Forward-only and idempotent: nothing here rewrites a checkpoint.

alter table cp2_runtime_handoffs drop constraint if exists cp2_runtime_handoffs_parent_fk;

create or replace function cp2_runtime_handoffs_parent_exists()
returns trigger language plpgsql as $$
begin
  if new.parent_handoff_id is not null and not exists (
    select 1 from cp2_runtime_handoffs where entity_id = new.parent_handoff_id
  ) then
    raise exception 'cp2_runtime_handoffs parent % does not exist (entity_id=%)',
      new.parent_handoff_id, new.entity_id
      using errcode = '23503';
  end if;
  return null;
end;
$$;

drop trigger if exists cp2_runtime_handoffs_parent_exists on cp2_runtime_handoffs;
create trigger cp2_runtime_handoffs_parent_exists
after insert on cp2_runtime_handoffs
for each row execute function cp2_runtime_handoffs_parent_exists();

alter table cp2_runtime_task_heads
  alter constraint cp2_runtime_task_heads_active_handoff_fk deferrable initially deferred;
alter table cp2_runtime_task_instances
  alter constraint cp2_runtime_task_instances_active_handoff_fk deferrable initially deferred;
alter table cp2_runtime_transfers
  alter constraint cp2_runtime_transfers_source_handoff_id_fkey deferrable initially deferred;
alter table cp2_runtime_transfers
  alter constraint cp2_runtime_transfers_checkpoint_id_fkey deferrable initially deferred;

-- The retention rule's lookups: transfers by task (the child lookup uses
-- cp2_runtime_handoffs_parent_idx, the version window cp2_runtime_handoffs_task_version_idx).
create index if not exists cp2_runtime_transfers_task_idx on cp2_runtime_transfers (task_id);
