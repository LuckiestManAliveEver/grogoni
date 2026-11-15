-- Drops the owner-change notices. Linked sessions, chats and messages are unaffected; a new owner
-- simply no longer sees why WhatsApp was disconnected. Stop the connector hosts first.
drop table if exists cp2_whatsapp_linked_owner_states;
