-- Tenant columns for cp2_runtime_operation_dedup (idempotency records for checkpoint, swap,
-- rollback, offline sync and merge). Its rows carried no account, so the Edge request scope could
-- not load the caller's rows: an idempotent retry on Edge was not recognized, and its duplicate
-- row failed the write. Each record now names its account and task (RuntimeHandoffDomain
-- .withIdempotency); the snapshot writer fills account_id from the record like every CP2 table.
--
-- Backfill: every stored result carries its task head (checkpoint, swap, rollback, offline sync
-- and merge all return `taskHead`), a task is a conversation, and withIdempotency only ever
-- records the conversation owner's operations (requireConversation), so the account is the
-- conversation's. A row whose conversation no longer exists keeps no account and is never loaded
-- on Edge (as before). Forward-only and idempotent: only rows still missing an account change.

alter table cp2_runtime_operation_dedup
  add column if not exists task_id text generated always as (record ->> 'taskId') stored;

update cp2_runtime_operation_dedup dedup
set record = dedup.record || jsonb_build_object(
      'accountId', coalesce(conversation.account_id, conversation.record ->> 'accountId'),
      'taskId', conversation.entity_id),
    account_id = coalesce(conversation.account_id, conversation.record ->> 'accountId')
from cp2_conversations conversation
where dedup.record ->> 'accountId' is null
  and conversation.entity_id = coalesce(
    dedup.record #>> '{result,taskHead,taskId}',
    dedup.record #>> '{result,handoff,taskId}',
    dedup.record #>> '{result,activeHandoff,taskId}')
  and coalesce(conversation.account_id, conversation.record ->> 'accountId') is not null;

create index if not exists cp2_runtime_operation_dedup_account_idx
  on cp2_runtime_operation_dedup (account_id, task_id);
