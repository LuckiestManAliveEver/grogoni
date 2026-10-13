create table if not exists business_supplier_quotes (
  business_id text not null,
  quote_id text not null,
  created_by text not null,
  record jsonb not null check (jsonb_typeof(record)='object'),
  created_at timestamptz not null default now(),
  primary key (business_id,quote_id),
  check (record->>'businessId'=business_id and record->>'id'=quote_id)
);

create table if not exists business_purchase_drafts (
  business_id text not null,
  task_id text not null,
  action_id text not null,
  supplier_id text not null,
  draft_id text not null,
  actor_id text not null,
  total_minor bigint not null check (total_minor between 0 and 9007199254740991),
  record jsonb not null check (jsonb_typeof(record)='object'),
  created_at timestamptz not null default now(),
  primary key (business_id,draft_id),
  unique (business_id,action_id,supplier_id),
  foreign key (business_id,task_id) references business_environment_tasks (business_id,task_id),
  check (record->>'businessId'=business_id and record->>'id'=draft_id),
  check (record->>'status'='DRAFT')
);

create index if not exists business_purchase_drafts_task_idx
  on business_purchase_drafts (business_id,task_id,actor_id);
