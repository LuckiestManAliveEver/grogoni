-- Purchase receipts keep what confirmation decided (receipt-to-commerce checklist, P0): the
-- document type, values that were derived rather than printed, mismatches the person checked
-- against the paper, and the fingerprints that recognise the same receipt across photographs.
-- Before this, purchase_receipts held only its original columns and these were lost on every
-- save and reload. All columns are nullable: receipts saved earlier have none.
alter table purchase_receipts
  add column if not exists document_type text,
  add column if not exists derived_fields jsonb,
  add column if not exists acknowledged_discrepancies jsonb,
  add column if not exists document_fingerprint text,
  add column if not exists content_fingerprint text,
  add column if not exists confirmed_different_from uuid;

-- One saved receipt per commercial receipt and shop. Confirmation refuses a second one first;
-- this is the backstop for two confirmations at once. Earlier receipts have no fingerprint.
create unique index if not exists purchase_receipts_document_fingerprint_idx
  on purchase_receipts (business_id, document_fingerprint)
  where document_fingerprint is not null;
