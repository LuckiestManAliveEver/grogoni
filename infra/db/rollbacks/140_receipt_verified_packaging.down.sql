-- Deploy the previous application first. Keep packaging metadata for audit/recovery; older
-- versions ignore its kind. Removing the supporting index/validation does not delete records.
drop index if exists unified_commerce_packaging_identity;
alter table cp2_unified_commerce_records drop constraint if exists unified_commerce_packaging_valid;
-- Deliberately retain the expanded kind allowlist until packaging records have been archived
-- under an approved retention process. Narrowing it with retained records would fail rollback.
