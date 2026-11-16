-- Set WHATSAPP_LINKED_LEASE_MODE=off on every worker (or stop them) first: lease-mode workers
-- write holder_url on every acquire and fail closed without the column.
alter table whatsapp_linked_leases drop constraint if exists whatsapp_linked_leases_holder_state_check;
alter table whatsapp_linked_leases drop constraint if exists whatsapp_linked_leases_holder_url_check;
alter table whatsapp_linked_leases drop column if exists holder_state;
alter table whatsapp_linked_leases drop column if exists holder_url;
