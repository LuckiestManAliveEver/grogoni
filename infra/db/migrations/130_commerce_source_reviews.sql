-- Expand the existing metadata collection; no new inventory/order ledger.
alter table cp2_unified_commerce_records drop constraint unified_commerce_record_scope;
alter table cp2_unified_commerce_records add constraint unified_commerce_record_scope check (coalesce(
  jsonb_typeof(record) = 'object' and record->>'id' = entity_id and record->>'businessId' = business_id
  and record->>'kind' in ('source','binding','offer','relationship','candidate','representation'), false));
create unique index unified_commerce_candidate_version on cp2_unified_commerce_records
(business_id, (record->>'sourceId'), (record->>'externalProductId'), (record->>'fingerprint')) where record->>'kind'='candidate';
create index unified_commerce_representation_principal on cp2_unified_commerce_records
((record->>'principalBusinessId'), (record->>'status')) where record->>'kind'='representation';
