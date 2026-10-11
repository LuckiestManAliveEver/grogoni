-- Stop all daemon workers before rollback. This removes queued work and execution results.
drop table if exists grogoni_daemon_tasks;
