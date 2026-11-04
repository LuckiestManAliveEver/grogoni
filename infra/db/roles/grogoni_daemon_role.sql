-- Least-privilege role for the native daemon (docs/deployment/native-daemon.md).
-- Not a migration: run once as the database owner, after 112_native_daemon.sql (and again after
-- 132_my_assistant_rename.sql), with the
-- search_path pointing at the schema that holds grogoni_daemon_tasks. Create the login role first:
--   create role grogoni_daemon login password '<openssl rand -hex 32>';  (hex: URL-safe)
-- DELETE is required only for DAEMON_RETENTION_DAYS; revoke it if retention is disabled (0).
do $grant$
begin
  execute format('grant usage on schema %I to grogoni_daemon', current_schema());
end
$grant$;
grant select, insert, update, delete on grogoni_daemon_tasks to grogoni_daemon;
-- Lets conversation tasks follow a later switch in My Assistant's details (migration 132): one
-- SECURITY DEFINER question, no read access to users or conversations. Skipped on a database that
-- holds only the queue (no migration 132); re-run this file after migrating past 132.
do $grant$
begin
  if to_regprocedure('grogoni_conversation_task_runtime(uuid, text)') is not null then
    execute 'grant execute on function grogoni_conversation_task_runtime(uuid, text) to grogoni_daemon';
  end if;
end
$grant$;
