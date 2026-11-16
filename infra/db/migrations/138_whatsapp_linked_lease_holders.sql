-- Holder discovery for WhatsApp Linked Devices leases
-- (docs/architecture/whatsapp-linked-devices.md, "Requests that land on another worker").
-- A worker that does not hold a business's lease forwards owner requests (connect, disconnect,
-- scopes, groups, send) to the holder over the authenticated internal RPC. holder_url is the
-- holder's internal base URL, written with every acquire; holder_state is the connection state
-- the holder last published, so other workers can answer channel readiness without a round trip.
-- Both are advisory routing data: ownership is still only holder_id + generation + expires_at.
alter table whatsapp_linked_leases
  add column if not exists holder_url text,
  add column if not exists holder_state text;

alter table whatsapp_linked_leases
  drop constraint if exists whatsapp_linked_leases_holder_url_check;
alter table whatsapp_linked_leases
  add constraint whatsapp_linked_leases_holder_url_check
  check (holder_url is null or (length(holder_url) <= 500 and holder_url ~ '^https?://'));

alter table whatsapp_linked_leases
  drop constraint if exists whatsapp_linked_leases_holder_state_check;
alter table whatsapp_linked_leases
  add constraint whatsapp_linked_leases_holder_state_check
  check (holder_state is null or holder_state in (
    'DISCONNECTED', 'PAIRING', 'CONNECTING', 'CONNECTED', 'RECONNECTING',
    'AUTH_REQUIRED', 'REVOKED', 'SUSPENDED', 'ERROR'
  ));
