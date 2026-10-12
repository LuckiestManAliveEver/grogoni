create table if not exists business_runtime_approvals (
  token_hash text primary key check (length(token_hash)=64),
  business_id text not null,
  actor_id text not null,
  runtime_session_id text not null,
  conversation_id text,
  intent text not null check (length(intent) between 1 and 64),
  action jsonb not null check (jsonb_typeof(action)='object'),
  expires_at timestamptz not null,
  status text not null default 'PENDING' check (status in ('PENDING','CLAIMED')),
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists business_runtime_approvals_retention_idx
  on business_runtime_approvals (expires_at);
