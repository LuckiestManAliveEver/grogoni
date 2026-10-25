-- Durable projection of existing daemon tasks into the shared messenger, independent of browsers.
alter table grogoni_daemon_tasks add column if not exists conversation_delivered_at timestamptz;
create index if not exists grogoni_daemon_conversation_delivery
  on grogoni_daemon_tasks (updated_at, id)
  where owner_user_id is not null and payload->'conversation' is not null
    and status in ('completed', 'failed', 'cancelled');
