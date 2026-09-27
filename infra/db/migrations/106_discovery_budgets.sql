-- Discovery budgets (docs/architecture/phonebook-identity-resolution.md): each user's spending
-- in the rolling 24-hour window of numbers asked about (phonebook sync, social sync, invites).
-- Persisted so an API restart does not hand every user a fresh budget. One record per user; the
-- record is the DiscoveryBudgetRecord JSON (generic Cp2 collection shape, see
-- 023_storefront_interaction_contracts.sql).
create table if not exists cp2_discovery_budgets (
  entity_id text primary key,
  business_id text,
  account_id text,
  user_id text,
  parent_id text,
  record jsonb not null,
  updated_at timestamp with time zone not null default now()
);

create index if not exists cp2_discovery_budgets_user_idx
  on cp2_discovery_budgets (user_id) where user_id is not null;

comment on table cp2_discovery_budgets is
  'Per-user rolling 24h count of phone numbers and emails checked against Soko accounts.';
