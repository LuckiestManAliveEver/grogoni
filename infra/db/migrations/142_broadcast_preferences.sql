-- A customer's turned-off shops (docs/audits/default-messenger-scorecard.md, "Opt-in broadcast
-- from a shop to its customers"). One row per account and shop while that shop's status updates
-- are off; turning them back on deletes the row. While off, the shop's statuses leave the
-- customer's feed and the shop can neither select nor send to them (CommerceDomain
-- setBroadcastPreference / mutedShop). Ids and a timestamp only.
create table if not exists cp2_broadcast_preferences (
  entity_id text primary key,
  business_id text,
  account_id text,
  user_id text,
  parent_id text,
  record jsonb not null,
  updated_at timestamp with time zone not null default now(),
  constraint cp2_broadcast_preferences_identity check (
    entity_id = record ->> 'id'
    and entity_id = (record ->> 'accountId') || ':' || (record ->> 'businessId')
  ),
  constraint cp2_broadcast_preferences_scope check (
    business_id is not null and business_id = record ->> 'businessId'
    and account_id is not null and account_id = record ->> 'accountId'
  ),
  constraint cp2_broadcast_preferences_off check (record ->> 'receive' = 'false')
);

-- A shop's picker and send look up its own rows.
create index if not exists cp2_broadcast_preferences_business_idx
  on cp2_broadcast_preferences (business_id);
create index if not exists cp2_broadcast_preferences_account_idx
  on cp2_broadcast_preferences (account_id);

revoke all on cp2_broadcast_preferences from public;
do $roles$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on cp2_broadcast_preferences from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on cp2_broadcast_preferences from authenticated';
  end if;
end
$roles$;

comment on table cp2_broadcast_preferences is
  'Shops whose status updates a customer turned off. Ids and a timestamp only.';
