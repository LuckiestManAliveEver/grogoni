-- Stop browser and Edge daemon lanes first. User-owned tasks become operator tasks if they remain.
drop index if exists grogoni_daemon_tasks_owner;
alter table grogoni_daemon_tasks drop column if exists lane;
alter table grogoni_daemon_tasks drop column if exists owner_user_id;
