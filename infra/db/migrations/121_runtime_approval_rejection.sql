alter table business_runtime_approvals drop constraint if exists business_runtime_approvals_status_check;
alter table business_runtime_approvals add constraint business_runtime_approvals_status_check
  check (status in ('PENDING','CLAIMED','REJECTED'));
alter table business_runtime_approvals add column if not exists rejected_at timestamptz;
