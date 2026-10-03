alter table conversation_messages
  add column if not exists idempotency_key text,
  add column if not exists status text not null default 'delivered',
  add column if not exists queued_at timestamp with time zone,
  add column if not exists sent_at timestamp with time zone,
  add column if not exists delivered_at timestamp with time zone,
  add column if not exists read_at timestamp with time zone,
  add column if not exists failure_code text,
  add column if not exists retry_count integer not null default 0,
  add column if not exists next_retry_at timestamp with time zone,
  add column if not exists selected_channel text not null default 'grogoni',
  add column if not exists actual_channel text,
  add column if not exists provider_message_id text,
  add column if not exists imported_source text,
  add column if not exists imported_external_id text,
  add column if not exists consent_record_id uuid;

update conversation_messages
set idempotency_key = 'grogoni:' || conversation_id::text || ':' || client_message_id
where idempotency_key is null;

update conversation_messages
set sent_at = coalesce(sent_at, created_at),
    delivered_at = coalesce(delivered_at, created_at)
where status in ('sent', 'delivered', 'read');

alter table conversation_messages
  alter column idempotency_key set not null,
  drop constraint if exists conversation_messages_status_check,
  add constraint conversation_messages_status_check
    check (status in (
      'draft',
      'queued',
      'sending',
      'retrying',
      'pending',
      'sent',
      'delivered',
      'read',
      'failed'
    )),
  drop constraint if exists conversation_messages_retry_count_check,
  add constraint conversation_messages_retry_count_check check (retry_count >= 0),
  drop constraint if exists conversation_messages_selected_channel_check,
  add constraint conversation_messages_selected_channel_check
    check (selected_channel in (
      'grogoni',
      'sms',
      'mms',
      'rcs_business',
      'whatsapp_business',
      'telegram',
      'facebook_messenger',
      'instagram_messaging',
      'email'
    )),
  drop constraint if exists conversation_messages_actual_channel_check,
  add constraint conversation_messages_actual_channel_check
    check (
      actual_channel is null
      or actual_channel in (
        'grogoni',
        'sms',
        'mms',
        'rcs_business',
        'whatsapp_business',
        'telegram',
        'facebook_messenger',
        'instagram_messaging',
        'email'
      )
    );

create unique index if not exists conversation_messages_idempotency_idx
  on conversation_messages (conversation_id, idempotency_key);

create unique index if not exists conversation_messages_imported_source_idx
  on conversation_messages (conversation_id, imported_source, imported_external_id)
  where imported_source is not null and imported_external_id is not null;

create table if not exists message_delivery_attempts (
  id uuid primary key,
  account_id uuid not null references accounts (id) on delete cascade,
  conversation_id uuid not null references conversations (id) on delete cascade,
  message_id uuid not null references conversation_messages (id) on delete cascade,
  channel text not null check (channel in (
    'grogoni',
    'sms',
    'mms',
    'rcs_business',
    'whatsapp_business',
    'telegram',
    'facebook_messenger',
    'instagram_messaging',
    'email'
  )),
  provider text not null,
  attempt_number integer not null check (attempt_number > 0),
  requested_at timestamp with time zone not null,
  responded_at timestamp with time zone,
  result text not null check (result in (
    'succeeded',
    'transient_failure',
    'permanent_failure'
  )),
  normalized_failure_code text,
  provider_response_reference text
);

create index if not exists message_delivery_attempts_account_requested_idx
  on message_delivery_attempts (account_id, requested_at desc);

create index if not exists message_delivery_attempts_message_idx
  on message_delivery_attempts (message_id, attempt_number);

create unique index if not exists message_delivery_attempts_message_channel_attempt_idx
  on message_delivery_attempts (message_id, channel, attempt_number);

create table if not exists cp2_message_delivery_attempts (
  entity_id text primary key,
  business_id text,
  account_id text,
  user_id text,
  parent_id text,
  record jsonb not null,
  updated_at timestamp with time zone not null default now()
);

create index if not exists cp2_message_delivery_attempts_account_idx
  on cp2_message_delivery_attempts (account_id, updated_at desc);

comment on column conversation_messages.idempotency_key is
  'Caller-stable key scoped to a conversation; retries with the same key return the original message.';

comment on table message_delivery_attempts is
  'Append-only, account-scoped transport attempt metadata. Provider credentials and message bodies are never stored here.';
