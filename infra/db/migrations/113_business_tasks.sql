-- Postgres-authoritative task contracts, outside the CP2 asynchronous snapshot writer.
-- As with fulfillment, do not reference snapshot-managed records with foreign keys.
create table if not exists business_environment_tasks (
  business_id text not null,
  task_id text not null,
  actor_id text not null,
  environment_id text not null,
  environment_version text not null,
  task jsonb not null,
  created_at timestamptz not null default now(),
  primary key (business_id, task_id),
  check (jsonb_typeof(task) = 'object'),
  check (task->>'id' is not null and task->>'id' = task_id),
  check (task->>'businessId' is not null and task->>'businessId' = business_id),
  check (task->>'actorId' is not null and task->>'actorId' = actor_id),
  check (task->>'environmentId' is not null and task->>'environmentId' = environment_id),
  check (task->>'environmentVersion' is not null and task->>'environmentVersion' = environment_version)
);
create index if not exists business_environment_tasks_actor_idx
  on business_environment_tasks (business_id, actor_id, created_at desc, task_id);
