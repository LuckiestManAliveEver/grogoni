-- The backfilled accountId/taskId stay in each record (older code ignores them).
drop index if exists cp2_runtime_operation_dedup_account_idx;
alter table cp2_runtime_operation_dedup drop column if exists task_id;
