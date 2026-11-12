-- Cross-process ownership of WhatsApp Linked Devices sessions
-- (docs/architecture/whatsapp-linked-devices.md, "Multi-worker leasing").
-- One row per business. A worker may hold a business's socket only while its row names the
-- worker as holder_id and expires_at is in the future, by the database clock. Every takeover
-- increments generation; the row is never deleted, so generation never repeats and a stale
-- holder's generation can never match again. All time comparisons use the database's now().
create table if not exists whatsapp_linked_leases (
  business_id text primary key,
  holder_id text not null check (length(holder_id) between 1 and 200),
  generation bigint not null check (generation > 0),
  expires_at timestamptz not null,
  heartbeat_at timestamptz not null,
  acquired_at timestamptz not null default now()
);
revoke all on whatsapp_linked_leases from public;
do $roles$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on whatsapp_linked_leases from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on whatsapp_linked_leases from authenticated';
  end if;
end
$roles$;
