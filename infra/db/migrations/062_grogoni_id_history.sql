-- Canonical store slug system (docs/architecture/grogoni-id-slug-system.md). Purely additive: one
-- new table, no changes to any existing table (cp2_businesses.grogoniId already exists as a jsonb
-- field on the businesses record and needs no schema change - only its generation/rename rules
-- change, in application code). Backed by services/api/src/cp2/store.ts's grogoniIdHistory map via
-- postgres-store.ts's existing generic normalizedCollections mechanism, the same pattern
-- cp2_model_preferences (migration 060) already uses - no bespoke SQL beyond this table
-- definition.

create table if not exists cp2_grogoni_id_history (
  entity_id text primary key check (
    entity_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  business_id text not null references cp2_businesses(entity_id) on delete cascade,
  account_id text,
  user_id text,
  parent_id text,
  record jsonb not null,
  updated_at timestamp with time zone not null default now(),
  constraint cp2_grogoni_id_history_grogoni_id_check check (
    record ? 'grogoniId' and char_length(record ->> 'grogoniId') between 1 and 60
  )
);

-- A retired grogoniId can only ever be released once, by exactly one history row - guards against
-- the same handle being recorded as "in cooldown" twice if a rename is ever retried.
create unique index if not exists cp2_grogoni_id_history_grogoni_id_idx
  on cp2_grogoni_id_history ((record ->> 'grogoniId'));

-- The cooldown runner's query pattern: "every entry not yet released, oldest first."
create index if not exists cp2_grogoni_id_history_pending_release_idx
  on cp2_grogoni_id_history (business_id)
  where record ->> 'releasedAt' is null;
