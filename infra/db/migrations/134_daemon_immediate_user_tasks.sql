-- Trusted channel workers can enqueue prompt replies without bypassing owner admission budgets.
-- Browser-created tasks keep their existing takeover policy (default false).
alter table grogoni_daemon_tasks add column if not exists server_immediate boolean not null default false;
alter table grogoni_daemon_tasks add constraint daemon_immediate_owned_once
  check (not server_immediate or (owner_user_id is not null and interval_ms is null));
