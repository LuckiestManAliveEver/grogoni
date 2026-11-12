-- Stop every linked connector, or set WHATSAPP_LINKED_LEASE_MODE=off and run a single worker,
-- before rolling back: without this table a configured Postgres lease store cannot acquire,
-- so connectors fail closed (no socket) rather than running unfenced.
drop table if exists whatsapp_linked_leases;
