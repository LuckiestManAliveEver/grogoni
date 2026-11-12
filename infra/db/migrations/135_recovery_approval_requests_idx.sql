-- Trusted-device recovery approval (docs/authentication/trusted-device-recovery-approval.md).
-- Approval requests have no account until approved, so Edge finds them by phone number on every
-- app focus of a signed-in phone account. A partial index keeps that off a table scan.
create index if not exists cp2_auth_transactions_recovery_approval_idx
  on cp2_auth_transactions ((record->>'identifierValue'))
  where record->'metadata'->>'recoveryApprovalRequest' = 'true';
