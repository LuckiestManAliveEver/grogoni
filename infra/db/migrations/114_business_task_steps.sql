create table if not exists business_environment_task_steps (
  business_id text not null,
  task_id text not null,
  step_id text not null,
  actor_id text not null,
  claim_id uuid not null,
  status text not null check (status in ('RUNNING','AWAITING_APPROVAL','VERIFYING','FAILED','INCONCLUSIVE')),
  runtime_turn_id text,
  observation jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id,task_id,step_id),
  foreign key (business_id,task_id) references business_environment_tasks (business_id,task_id),
  check (observation is null or jsonb_typeof(observation)='object')
);

create index if not exists business_environment_task_steps_actor_idx
  on business_environment_task_steps (business_id,actor_id,task_id);
