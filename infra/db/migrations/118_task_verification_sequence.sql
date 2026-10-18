alter table business_environment_task_verifications
  add column if not exists evidence_sequence bigint generated always as identity;

-- Existing rows have no reliable observation order. Require a fresh verifier check.
alter table business_environment_task_verifications
  add column if not exists claim_eligible boolean not null default false;
alter table business_environment_task_verifications
  alter column claim_eligible set default true;

create index if not exists business_task_latest_verification_idx
  on business_environment_task_verifications (business_id,task_id,step_id,evidence_sequence desc);
