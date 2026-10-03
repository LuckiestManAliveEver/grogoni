create table if not exists conversations (
  id uuid primary key,
  account_id uuid not null references accounts (id),
  kind text not null check (kind in ('personal', 'storefront', 'order')),
  active_shop_id uuid references businesses (id),
  created_at timestamp with time zone not null,
  updated_at timestamp with time zone not null
);

create index if not exists conversations_account_updated_idx
  on conversations (account_id, updated_at desc);

create table if not exists conversation_participants (
  id uuid primary key,
  conversation_id uuid not null references conversations (id) on delete cascade,
  role text not null check (role in ('account', 'shop', 'agent')),
  account_id uuid references accounts (id),
  business_id uuid references businesses (id),
  agent_id text,
  created_at timestamp with time zone not null,
  check (num_nonnulls(account_id, business_id, agent_id) = 1)
);

create index if not exists conversation_participants_conversation_idx
  on conversation_participants (conversation_id);

create table if not exists conversation_messages (
  id uuid primary key,
  conversation_id uuid not null references conversations (id) on delete cascade,
  client_message_id text not null,
  author text not null check (author in ('user', 'agent', 'system')),
  author_id text not null,
  content jsonb not null,
  client_timestamp timestamp with time zone,
  created_at timestamp with time zone not null,
  unique (conversation_id, client_message_id)
);

create index if not exists conversation_messages_conversation_created_idx
  on conversation_messages (conversation_id, created_at, id);

create table if not exists grogoni_session_contexts (
  session_id uuid primary key references sessions (id) on delete cascade,
  conversation_id uuid not null references conversations (id),
  active_shop_id uuid references businesses (id),
  active_model_id text not null,
  mode text not null check (mode in ('marketplace', 'seller')),
  active_surface text not null check (
    active_surface in (
      'conversation',
      'storefront',
      'catalogue',
      'product',
      'order',
      'receipt',
      'owner-controls'
    )
  ),
  session_version integer not null check (session_version > 0),
  updated_at timestamp with time zone not null
);

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'cp2_session_contexts',
    'cp2_conversations',
    'cp2_conversation_participants',
    'cp2_conversation_messages'
  ]
  loop
    execute format(
      'create table if not exists %I (
        entity_id text primary key,
        business_id text,
        account_id text,
        user_id text,
        parent_id text,
        record jsonb not null,
        updated_at timestamp with time zone not null default now()
      )',
      table_name
    );
  end loop;
end $$;
