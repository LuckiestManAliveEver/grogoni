alter table conversation_participants
  add column if not exists external_identity_id text;

alter table products
  add column if not exists primary_media_id text;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'platform_identities',
    'conversation_channels',
    'provider_update_receipts',
    'customer_runtime_capabilities',
    'product_media',
    'product_capture_jobs'
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
    execute format(
      'create index if not exists %I on %I (business_id) where business_id is not null',
      table_name || '_business_idx',
      table_name
    );
  end loop;
end $$;

create unique index if not exists platform_identities_provider_user_unique_idx
  on platform_identities (business_id, (record ->> 'provider'), (record ->> 'externalUserId'));

create unique index if not exists conversation_channels_provider_conversation_unique_idx
  on conversation_channels (
    business_id,
    (record ->> 'provider'),
    (record ->> 'externalConversationId')
  );

create unique index if not exists provider_update_receipts_provider_update_unique_idx
  on provider_update_receipts ((record ->> 'provider'), (record ->> 'externalUpdateId'));

create unique index if not exists customer_runtime_capabilities_token_hash_unique_idx
  on customer_runtime_capabilities ((record ->> 'tokenHash'));

create index if not exists product_media_product_idx
  on product_media ((record ->> 'productId'))
  where record ->> 'productId' is not null;

create index if not exists product_capture_jobs_status_idx
  on product_capture_jobs (business_id, (record ->> 'status'));

comment on table platform_identities is
  'Business-scoped provider identities. External identities are never auto-linked to Grogoni accounts.';
comment on table conversation_channels is
  'Provider-neutral bindings between external chats and canonical Grogoni conversations.';
comment on table provider_update_receipts is
  'Durable provider update idempotency receipts.';
comment on table customer_runtime_capabilities is
  'Hashed, revocable public commerce runtime capability records.';
comment on table product_media is
  'Canonical product media and temporary capture uploads.';
comment on table product_capture_jobs is
  'Auditable camera-to-catalogue capture lifecycle records.';
