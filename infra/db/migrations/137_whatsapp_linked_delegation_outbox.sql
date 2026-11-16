-- Durable outbox for the WhatsApp reply a delegated participant gets once the shop owner approves
-- or rejects their request (docs/architecture/whatsapp-linked-devices.md, "Delegated-result
-- outbox"). Any API host records a row when the owner resolves the approval; only the Node host
-- that runs the business's WhatsApp connector sends the reply and settles the row.
-- entity_id is the idempotency key `whatsapp-result:<turnId>`, so a turn has at most one row.
create table if not exists cp2_whatsapp_linked_delegation_results (
  entity_id text primary key,
  business_id text,
  account_id text,
  user_id text,
  parent_id text,
  record jsonb not null,
  updated_at timestamp with time zone not null default now(),
  constraint cp2_whatsapp_linked_delegation_results_identity check (
    entity_id = record ->> 'id'
    and entity_id = record ->> 'idempotencyKey'
    and entity_id = 'whatsapp-result:' || (record ->> 'turnId')
  ),
  constraint cp2_whatsapp_linked_delegation_results_scope check (
    business_id is not null and business_id = record ->> 'businessId'
  ),
  constraint cp2_whatsapp_linked_delegation_results_status check (
    record ->> 'status' in ('pending', 'sent', 'suppressed', 'failed')
  )
);

-- The connector host's drain reads pending rows only.
create index if not exists cp2_whatsapp_linked_delegation_results_pending_idx
  on cp2_whatsapp_linked_delegation_results ((record ->> 'createdAt'), entity_id)
  where record ->> 'status' = 'pending';

create index if not exists cp2_whatsapp_linked_delegation_results_business_idx
  on cp2_whatsapp_linked_delegation_results (business_id, updated_at desc);

revoke all on cp2_whatsapp_linked_delegation_results from public;
do $roles$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on cp2_whatsapp_linked_delegation_results from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on cp2_whatsapp_linked_delegation_results from authenticated';
  end if;
end
$roles$;

comment on table cp2_whatsapp_linked_delegation_results is
  'WhatsApp Linked Devices delegated-result outbox. Holds fixed outcome codes and routing ids only: no message body, tool input, tool result or credential.';
