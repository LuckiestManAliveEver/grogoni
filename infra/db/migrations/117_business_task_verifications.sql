create table if not exists business_environment_task_verifications (
  id uuid primary key,
  business_id text not null,
  task_id text not null,
  step_id text not null,
  actor_id text not null,
  runtime_turn_id text not null,
  state_version text not null,
  status text not null check (status in ('PASSED','FAILED','INCONCLUSIVE')),
  report jsonb not null check (jsonb_typeof(report)='object'),
  created_at timestamptz not null default now(),
  foreign key (business_id,task_id,step_id)
    references business_environment_task_steps (business_id,task_id,step_id),
  unique (business_id,task_id,step_id,state_version)
);

create index if not exists business_environment_task_verifications_actor_idx
  on business_environment_task_verifications (business_id,actor_id,task_id);
