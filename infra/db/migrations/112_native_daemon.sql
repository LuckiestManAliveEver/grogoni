create table if not exists grogoni_daemon_tasks (
  id uuid primary key,
  idempotency_key text not null unique,
  payload jsonb not null,
  status text not null default 'queued' check (status in ('queued','running','completed','failed','cancelled')),
  run_at timestamptz not null default now(),
  interval_ms bigint check (interval_ms >= 60000),
  attempts integer not null default 0,
  max_attempts integer not null default 3 check (max_attempts between 1 and 5),
  executions bigint not null default 0,
  lease_token uuid,
  lease_until timestamptz,
  result jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A running row without a lease could never be recovered by another worker.
  constraint grogoni_daemon_tasks_running_leased
    check (status <> 'running' or (lease_token is not null and lease_until is not null))
);
create index if not exists grogoni_daemon_tasks_due on grogoni_daemon_tasks (run_at)
where status in ('queued','running');
-- Every claim sweeps exhausted crash leases; keep that scan off the full table.
create index if not exists grogoni_daemon_tasks_leases on grogoni_daemon_tasks (lease_until)
where status = 'running';
-- Retention deletes terminal rows oldest first (DAEMON_RETENTION_DAYS).
create index if not exists grogoni_daemon_tasks_terminal on grogoni_daemon_tasks (updated_at)
where status in ('completed','failed','cancelled');
-- This is an operator queue, not a public client API. Never grant browser roles access.
revoke all on grogoni_daemon_tasks from public;
do $roles$
begin
  if exists (select 1 from pg_roles where rolname='anon') then
    execute 'revoke all on grogoni_daemon_tasks from anon';
  end if;
  if exists (select 1 from pg_roles where rolname='authenticated') then
    execute 'revoke all on grogoni_daemon_tasks from authenticated';
  end if;
end
$roles$;
