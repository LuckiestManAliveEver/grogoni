-- Disable channel automation and drain/cancel queued immediate tasks before rolling back workers.
alter table grogoni_daemon_tasks drop constraint if exists daemon_immediate_owned_once;
alter table grogoni_daemon_tasks drop column if exists server_immediate;
