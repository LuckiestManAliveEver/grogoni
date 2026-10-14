delete from business_runtime_approvals where status='REJECTED';
alter table business_runtime_approvals drop constraint business_runtime_approvals_status_check;
alter table business_runtime_approvals add constraint business_runtime_approvals_status_check
  check (status in ('PENDING','CLAIMED'));
alter table business_runtime_approvals drop column if exists rejected_at;
