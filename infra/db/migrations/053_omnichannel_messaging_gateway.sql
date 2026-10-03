alter table customers
  add column if not exists linked_account_id uuid references accounts (id) on delete set null;

create index if not exists customers_linked_account_idx
  on customers (linked_account_id)
  where linked_account_id is not null;

alter table conversation_messages
  add column if not exists provider text,
  add column if not exists direction text,
  add column if not exists external_conversation_id text,
  add column if not exists channel_identity_id text;

update conversation_messages
set provider = case
      when selected_channel = 'telegram' then 'telegram'
      else 'grogoni'
    end,
    direction = case
      when imported_source is not null and author = 'user' then 'inbound'
      else 'outbound'
    end
where provider is null or direction is null;

alter table conversation_messages
  alter column provider set not null,
  alter column direction set not null,
  drop constraint if exists conversation_messages_provider_check,
  add constraint conversation_messages_provider_check check (
    provider in ('grogoni', 'telegram', 'whatsapp', 'messenger', 'instagram', 'tiktok', 'x', 'sms')
  ),
  drop constraint if exists conversation_messages_direction_check,
  add constraint conversation_messages_direction_check check (direction in ('inbound', 'outbound')),
  drop constraint if exists conversation_messages_selected_channel_check,
  add constraint conversation_messages_selected_channel_check check (
    selected_channel in (
      'grogoni', 'sms', 'mms', 'rcs_business', 'whatsapp_business', 'telegram',
      'facebook_messenger', 'instagram_messaging', 'tiktok_business', 'x_dm', 'email'
    )
  ),
  drop constraint if exists conversation_messages_actual_channel_check,
  add constraint conversation_messages_actual_channel_check check (
    actual_channel is null or actual_channel in (
      'grogoni', 'sms', 'mms', 'rcs_business', 'whatsapp_business', 'telegram',
      'facebook_messenger', 'instagram_messaging', 'tiktok_business', 'x_dm', 'email'
    )
  );

create index if not exists conversation_messages_provider_thread_idx
  on conversation_messages (provider, external_conversation_id, created_at desc)
  where external_conversation_id is not null;

create table if not exists channel_identity_link_grants (
  entity_id text primary key,
  business_id text,
  account_id text,
  user_id text,
  parent_id text,
  record jsonb not null,
  updated_at timestamp with time zone not null default now()
);

create index if not exists channel_identity_link_grants_business_idx
  on channel_identity_link_grants (business_id)
  where business_id is not null;

create unique index if not exists channel_identity_link_grants_token_hash_unique_idx
  on channel_identity_link_grants ((record ->> 'tokenHash'));

create index if not exists channel_identity_link_grants_customer_idx
  on channel_identity_link_grants (business_id, (record ->> 'customerId'));

create index if not exists platform_identities_customer_idx
  on platform_identities (business_id, (record ->> 'customerId'))
  where record ->> 'customerId' is not null;

comment on table channel_identity_link_grants is
  'Short-lived, hashed grants that explicitly bind a provider identity to one canonical customer.';
comment on column conversation_messages.channel_identity_id is
  'Canonical provider identity used for this inbound or outbound delivery.';
