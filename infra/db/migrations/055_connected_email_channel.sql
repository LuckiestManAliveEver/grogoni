alter table conversation_messages
  add column if not exists subject text,
  add column if not exists external_thread_id text,
  add column if not exists sender_address text,
  add column if not exists recipient_addresses jsonb not null default '[]'::jsonb,
  add column if not exists cc_addresses jsonb not null default '[]'::jsonb,
  add column if not exists bcc_addresses jsonb not null default '[]'::jsonb,
  drop constraint if exists conversation_messages_provider_check,
  add constraint conversation_messages_provider_check check (
    provider in (
      'grogoni', 'telegram', 'whatsapp', 'messenger', 'instagram', 'tiktok', 'x', 'sms',
      'native_sms', 'email'
    )
  );

create index if not exists conversation_messages_email_thread_idx
  on conversation_messages (external_thread_id, created_at desc)
  where provider = 'email' and external_thread_id is not null;

create table if not exists connected_mailboxes (
  entity_id text primary key,
  business_id text,
  account_id text,
  user_id text,
  parent_id text,
  record jsonb not null,
  updated_at timestamp with time zone not null default now()
);

create unique index if not exists connected_mailboxes_provider_account_unique_idx
  on connected_mailboxes (
    business_id,
    (record ->> 'provider'),
    (record ->> 'providerAccountId')
  )
  where business_id is not null and record ->> 'status' <> 'disconnected';

create unique index if not exists connected_mailboxes_business_default_unique_idx
  on connected_mailboxes (business_id)
  where business_id is not null
    and record ->> 'isDefault' = 'true'
    and record ->> 'status' = 'connected';

create index if not exists connected_mailboxes_business_status_idx
  on connected_mailboxes (business_id, (record ->> 'status'), updated_at desc)
  where business_id is not null;

create table if not exists connected_mailbox_oauth_sessions (
  entity_id text primary key,
  business_id text,
  account_id text,
  user_id text,
  parent_id text,
  record jsonb not null,
  updated_at timestamp with time zone not null default now()
);

create unique index if not exists connected_mailbox_oauth_state_unique_idx
  on connected_mailbox_oauth_sessions ((record ->> 'stateHash'));

create index if not exists connected_mailbox_oauth_pending_idx
  on connected_mailbox_oauth_sessions (
    (record ->> 'provider'),
    (record ->> 'completedAt'),
    (record ->> 'expiresAt')
  );

comment on table connected_mailboxes is
  'Business-scoped Gmail or Outlook authorizations. Encrypted credentials remain server-side and are never API response fields.';
comment on table connected_mailbox_oauth_sessions is
  'Short-lived PKCE mailbox authorization sessions, distinct from login OAuth sessions.';
