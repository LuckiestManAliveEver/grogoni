-- Durable outbox for a WhatsApp Linked Devices session hosted on the owner's Android phone
-- (docs/architecture/whatsapp-linked-devices.md, "Device outbox"). Any API host (Supabase Edge
-- included) records a row when a reply, an assistant reply or a delegated result is sent to a
-- phone-hosted chat, or when the shop reads a message in a phone-hosted chat with read receipts
-- on. The owner's phone claims rows with the owner's own session and settles them.
-- entity_id is `send:<canonical message id>` or `read:<canonical message id>`, so a message has
-- at most one row per kind. Holds routing ids, the gateway idempotency key, the WhatsApp id of a
-- message read and fixed status codes: never message text or a credential (the phone reads the
-- text from the canonical message at pull time).
create table if not exists cp2_whatsapp_linked_device_outbox (
  entity_id text primary key,
  business_id text,
  account_id text,
  user_id text,
  parent_id text,
  record jsonb not null,
  updated_at timestamp with time zone not null default now(),
  constraint cp2_whatsapp_linked_device_outbox_identity check (
    entity_id = record ->> 'id'
    and entity_id = (record ->> 'kind') || ':' || (record ->> 'messageId')
  ),
  constraint cp2_whatsapp_linked_device_outbox_scope check (
    business_id is not null and business_id = record ->> 'businessId'
  ),
  constraint cp2_whatsapp_linked_device_outbox_kind check (record ->> 'kind' in ('send', 'read')),
  constraint cp2_whatsapp_linked_device_outbox_status check (
    record ->> 'status' in ('pending', 'claimed', 'sent', 'failed', 'uncertain', 'suppressed')
  ),
  constraint cp2_whatsapp_linked_device_outbox_no_text check (
    not (record ? 'text') and not (record ? 'body')
  )
);

-- The phone's pull reads one business's unsettled rows, oldest first.
create index if not exists cp2_whatsapp_linked_device_outbox_open_idx
  on cp2_whatsapp_linked_device_outbox (business_id, (record ->> 'createdAt'), entity_id)
  where record ->> 'status' in ('pending', 'claimed');

revoke all on cp2_whatsapp_linked_device_outbox from public;
do $roles$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on cp2_whatsapp_linked_device_outbox from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on cp2_whatsapp_linked_device_outbox from authenticated';
  end if;
end
$roles$;

comment on table cp2_whatsapp_linked_device_outbox is
  'WhatsApp Linked Devices outbox for phone-hosted sessions. Routing ids, idempotency keys and status codes only: no message text or credential.';
