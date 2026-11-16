-- Enrolled remote connector workers for WhatsApp Linked Devices
-- (docs/architecture/whatsapp-linked-devices.md, "Remote connector workers").
-- The business owner enrolls one worker process per business. The credential secret is shown
-- once and only its SHA-256 is stored. Rotation replaces the hash and increments
-- credential_version, which invalidates the previous secret at once; revocation is permanent.
-- attached_* records which API host the worker is connected to right now (a heartbeated claim,
-- compared with the database clock), so other hosts can forward requests there.
create table if not exists whatsapp_linked_workers (
  id text primary key check (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  business_id text not null check (length(business_id) between 1 and 200),
  owner_id text not null check (length(owner_id) between 1 and 200),
  label text not null check (length(label) between 1 and 80),
  secret_hash text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  credential_version integer not null default 1 check (credential_version > 0),
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  rotated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  attached_holder text check (attached_holder is null or length(attached_holder) between 1 and 200),
  attached_url text check (attached_url is null or (length(attached_url) <= 500 and attached_url ~ '^https?://')),
  attached_until timestamptz,
  constraint whatsapp_linked_workers_revoked_at check ((status = 'revoked') = (revoked_at is not null))
);

-- At most one active worker per business: the socket always has exactly one place to run.
create unique index if not exists whatsapp_linked_workers_one_active_idx
  on whatsapp_linked_workers (business_id) where status = 'active';

create index if not exists whatsapp_linked_workers_business_idx
  on whatsapp_linked_workers (business_id, created_at desc);

revoke all on whatsapp_linked_workers from public;
do $roles$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on whatsapp_linked_workers from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on whatsapp_linked_workers from authenticated';
  end if;
end
$roles$;

comment on table whatsapp_linked_workers is
  'WhatsApp Linked Devices remote worker enrollments. Stores a SHA-256 of each credential secret, never the secret.';
