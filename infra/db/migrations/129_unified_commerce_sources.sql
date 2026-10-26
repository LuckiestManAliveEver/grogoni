-- Additive source/offer metadata. Products, movements, invoices and orders remain authoritative.
create table cp2_unified_commerce_records (
  entity_id text primary key,
  business_id text not null,
  account_id text,
  user_id text,
  parent_id text,
  record jsonb not null,
  updated_at timestamptz not null default now(),
  constraint unified_commerce_record_scope check (coalesce(
    jsonb_typeof(record) = 'object' and record->>'id' = entity_id
    and record->>'businessId' = business_id
    and record->>'kind' in ('source', 'binding', 'offer', 'relationship'), false))
);
create index unified_commerce_tenant on cp2_unified_commerce_records (business_id, (record->>'kind'));
create unique index unified_commerce_binding on cp2_unified_commerce_records (business_id, (record->>'sourceId'), (record->>'externalProductId')) where record->>'kind' = 'binding';
create index unified_commerce_public_offers on cp2_unified_commerce_records ((record->>'status'), (record->>'validUntil')) where record->>'kind' = 'offer';
create index unified_commerce_relationship_target on cp2_unified_commerce_records ((record->>'targetBusinessId')) where record->>'kind' = 'relationship';
revoke all on cp2_unified_commerce_records from public;
do $roles$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on cp2_unified_commerce_records from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on cp2_unified_commerce_records from authenticated';
  end if;
end
$roles$;
