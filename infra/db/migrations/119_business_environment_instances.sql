create table if not exists business_environment_instances (
  business_id text not null,
  task_id text not null,
  actor_id text not null,
  revision integer not null default 0 check (revision >= 0),
  instance jsonb not null check (jsonb_typeof(instance)='object'),
  completion jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_id,task_id),
  foreign key (business_id,task_id) references business_environment_tasks (business_id,task_id),
  check (instance->>'businessId'=business_id and instance->>'taskId'=task_id),
  check (completion is null or jsonb_typeof(completion)='object')
);

create index if not exists business_environment_instances_actor_idx
  on business_environment_instances (business_id,actor_id);
