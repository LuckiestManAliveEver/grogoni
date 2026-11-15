-- WhatsApp Linked Devices owner state (docs/architecture/whatsapp-linked-devices.md, "Shop owner
-- change"). One row per business: the owner whose connector last reported a state, and the notice
-- shown to a new owner after a shop owner change removed the former owner's WhatsApp link.
-- Holds ids, a connection state code and cleanup counts only: no message, phone number or
-- credential.
create table if not exists cp2_whatsapp_linked_owner_states (
  entity_id text primary key,
  business_id text,
  account_id text,
  user_id text,
  parent_id text,
  record jsonb not null,
  updated_at timestamp with time zone not null default now(),
  constraint cp2_whatsapp_linked_owner_states_identity check (
    entity_id = record ->> 'id' and entity_id = record ->> 'businessId'
  ),
  constraint cp2_whatsapp_linked_owner_states_scope check (
    business_id is not null and business_id = record ->> 'businessId'
  )
);

revoke all on cp2_whatsapp_linked_owner_states from public;
do $roles$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on cp2_whatsapp_linked_owner_states from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on cp2_whatsapp_linked_owner_states from authenticated';
  end if;
end
$roles$;

comment on table cp2_whatsapp_linked_owner_states is
  'WhatsApp Linked Devices owner state and owner-change notice. Ids, a state code and counts only.';
