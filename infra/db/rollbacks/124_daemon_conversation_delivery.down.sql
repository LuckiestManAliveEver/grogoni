drop index if exists grogoni_daemon_conversation_delivery;
alter table grogoni_daemon_tasks drop column if exists conversation_delivered_at;
