create table if not exists buyer_shopping_sessions (
  entity_id text primary key,
  business_id text,
  account_id text,
  user_id text,
  parent_id text,
  record jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists buyer_shopping_sessions_account_updated_idx
  on buyer_shopping_sessions (account_id, updated_at desc);
comment on table buyer_shopping_sessions is
  'Account-scoped shopping assistant history, browser references and checkout reviews. No payment credentials.';
