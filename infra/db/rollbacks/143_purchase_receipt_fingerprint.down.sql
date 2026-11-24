-- Drops the backstop and the recorded decisions. Deploy an API build without them first: a build
-- that writes these columns fails while they are missing. Confirmation's own checks still run.
drop index if exists purchase_receipts_document_fingerprint_idx;
alter table purchase_receipts
  drop column if exists confirmed_different_from,
  drop column if exists content_fingerprint,
  drop column if exists document_fingerprint,
  drop column if exists acknowledged_discrepancies,
  drop column if exists derived_fields,
  drop column if exists document_type;
