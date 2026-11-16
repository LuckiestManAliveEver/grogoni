-- Pending rows are replies the WhatsApp participant has not received yet. Stop the connector
-- hosts (or let them drain) before rolling back; this drops any remaining entries.
drop table if exists cp2_whatsapp_linked_delegation_results;
