-- Drops the phone-hosted WhatsApp outbox. Sends still waiting for a phone are lost: their
-- canonical messages stay `queued` in the inbox and are not delivered. Read receipts waiting for
-- a phone are dropped (harmless). Deploy an API build without the device outbox first, or the
-- next save of a phone-hosted send fails on the missing table.
drop table if exists cp2_whatsapp_linked_device_outbox;
