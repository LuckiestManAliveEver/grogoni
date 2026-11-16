-- Extend existing commerce metadata; no second product or movement ledger.
alter table cp2_unified_commerce_records drop constraint unified_commerce_record_scope;
alter table cp2_unified_commerce_records add constraint unified_commerce_record_scope check (coalesce(
  jsonb_typeof(record) = 'object' and record->>'id' = entity_id and record->>'businessId' = business_id
  and record->>'kind' in ('source','binding','offer','relationship','candidate','representation','packaging'), false));
create unique index unified_commerce_packaging_identity on cp2_unified_commerce_records
  (business_id, (record->>'productId'), (record->>'packUnit'), (record->>'baseUnit'))
  where record->>'kind' = 'packaging';
alter table cp2_unified_commerce_records add constraint unified_commerce_packaging_valid check (
  record->>'kind' <> 'packaging' or coalesce(
    record->>'status' in ('active', 'revoked') and length(record->>'verifiedBy') > 0
    and length(record->>'verifiedAt') > 0 and length(record->>'productId') > 0
    and length(record->>'packUnit') > 0 and length(record->>'baseUnit') > 0
    and record->>'packUnit' <> record->>'baseUnit'
    and jsonb_typeof(record->'unitsPerPack') = 'number'
    and (record->>'unitsPerPack')::numeric between 1 and 1000000
    and trunc((record->>'unitsPerPack')::numeric) = (record->>'unitsPerPack')::numeric, false));
