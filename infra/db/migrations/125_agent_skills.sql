-- Portable instruction packages. Existing tool bindings and execution/approval tables remain authoritative.
create table cp2_agent_skills (
  entity_id text primary key,
  business_id text,
  account_id text,
  user_id text,
  parent_id text,
  record jsonb not null,
  updated_at timestamptz not null default now(),
  constraint cp2_agent_skills_record_check check (coalesce((
    jsonb_typeof(record) = 'object'
    and record ?& array['id','kind','scope','status','versions','grants','currentVersion','ownerUserId','reviewDigest']
    and record->>'id' = entity_id
    and record->>'ownerUserId' <> ''
    and record->>'businessId' is not distinct from business_id
    and record->>'accountId' is not distinct from account_id
    and record->>'kind' in ('installation', 'publication')
    and record->>'scope' in ('SYSTEM', 'TENANT', 'USER')
    and record->>'status' in ('DRAFT', 'INSTALLED', 'ENABLED', 'DISABLED', 'UNINSTALLED', 'REVOKED')
    and jsonb_typeof(record->'versions') = 'array'
    and jsonb_array_length(record->'versions') between 1 and 100
    and jsonb_typeof(record->'grants') = 'array'
    and ((record->>'scope' = 'TENANT' and business_id is not null and account_id is null)
      or (record->>'scope' = 'USER' and account_id is not null and business_id is null)
      or (record->>'scope' = 'SYSTEM' and account_id is null and business_id is null))
  ), false))
);
create index cp2_agent_skills_business_idx on cp2_agent_skills (business_id);
create index cp2_agent_skills_account_idx on cp2_agent_skills (account_id);
create index cp2_agent_skills_public_idx on cp2_agent_skills ((record->>'kind'), (record->>'status'));
