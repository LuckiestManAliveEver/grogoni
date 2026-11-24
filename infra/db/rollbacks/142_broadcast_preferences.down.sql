-- Drops customers' turned-off shops: every shop's status updates reach those customers again.
-- Deploy an API build without broadcast preferences first; an Edge build that has them reads
-- this table on every request and fails while it is missing.
drop table if exists cp2_broadcast_preferences;
