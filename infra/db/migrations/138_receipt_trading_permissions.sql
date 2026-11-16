-- Owner-issued, scoped receipt permissions in the existing durable commerce collection.
alter table cp2_unified_commerce_records drop constraint unified_commerce_record_scope;
alter table cp2_unified_commerce_records add constraint unified_commerce_record_scope check (coalesce(
  jsonb_typeof(record) = 'object' and record->>'id' = entity_id and record->>'businessId' = business_id
  and record->>'kind' in ('source','binding','offer','relationship','candidate','representation','packaging','trading_grant'), false));
create unique index unified_commerce_active_trading_permission on cp2_unified_commerce_records
  (business_id, (record->>'partnerBusinessId'), (record->>'partnerRole'))
  where record->>'kind' = 'trading_grant' and record->>'status' = 'active';
alter table cp2_unified_commerce_records add constraint unified_commerce_trading_permission_valid check (
  record->>'kind' <> 'trading_grant' or coalesce(
    record->>'status' in ('active','revoked') and record->>'partnerRole' in ('supplier','customer','salesperson')
    and length(record->>'partnerBusinessId') > 0 and record->>'partnerBusinessId' <> business_id
    and length(record->>'createdBy') > 0 and record->>'currency' ~ '^[A-Z]{3}$'
    and jsonb_typeof(record->'allowedKinds') = 'array'
    and jsonb_typeof(record->'permissions') = 'object'
    and jsonb_typeof(record->'permissions'->'postInventory') = 'boolean'
    and jsonb_typeof(record->'permissions'->'recordBalance') = 'boolean'
    and jsonb_typeof(record->'permissions'->'recordPayment') = 'boolean'
    and jsonb_typeof(record->'permissions'->'attributeSales') = 'boolean'
    and jsonb_typeof(record->'agentDelegation') = 'object'
    and length(record->>'expiresAt') > 0, false));
