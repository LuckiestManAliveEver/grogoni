-- Unset WHATSAPP_LINKED_HUB_LISTEN on every API host first. Dropping the table revokes every
-- enrolled worker: their credentials stop verifying and owners must enroll again.
drop table if exists whatsapp_linked_workers;
