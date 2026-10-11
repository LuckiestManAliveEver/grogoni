-- Least-privilege role for the native daemon (docs/deployment/native-daemon.md).
-- Not a migration: run once as the database owner, after 112_native_daemon.sql, with the
-- search_path pointing at the schema that holds grogoni_daemon_tasks. Create the login role first:
--   create role grogoni_daemon login password '<openssl rand -hex 32>';  (hex: URL-safe)
-- DELETE is required only for DAEMON_RETENTION_DAYS; revoke it if retention is disabled (0).
do $grant$
begin
  execute format('grant usage on schema %I to grogoni_daemon', current_schema());
end
$grant$;
grant select, insert, update, delete on grogoni_daemon_tasks to grogoni_daemon;
