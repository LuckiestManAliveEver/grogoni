-- Reverses 105_network_connections.sql. Phonebook contacts and their Grogoni links live in
-- cp2_network_nodes / cp2_grogoni_identity_links and are untouched; only connection records are dropped.
drop table if exists cp2_network_connections;
