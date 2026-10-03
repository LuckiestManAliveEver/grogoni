-- Corridor fulfillment Phase 1c: order provenance and fulfillment intake state
-- (docs/architecture/corridor-fulfillment.md §13).

-- Descriptive order provenance on the canonical order. Nullable and not backfilled: historical
-- invoices have no recorded source or creator, and none is invented. No FK to users - account
-- purge deletes user rows and must not be blocked by historical invoices.
alter table invoices
  add column if not exists source text,
  add column if not exists source_message_channel text,
  add column if not exists created_by_user_id uuid,
  add constraint invoices_source_valid check (
    source is null or source in (
      'FIELD_SALES', 'RETAIL_SALES', 'GROGONI_CHAT', 'WHATSAPP', 'TELEGRAM', 'TIKTOK', 'INSTAGRAM',
      'PHONE', 'MANUAL', 'API'
    )
  );

-- Intake copies the canonical order weight (A5, computed once from immutable confirmation
-- snapshots) onto the Postgres-authoritative order row, so pooling and allocation read it under
-- the same row lock. `weight_status` null means "row exists but intake has not run" (a 1b
-- resolution created it); it is never read as zero.
alter table fulfillment_orders
  add column if not exists weight_status text,
  add column if not exists total_weight_grams bigint,
  add column if not exists unresolved_line_ids text[] not null default '{}',
  add column if not exists state text not null default 'POOLED',
  add column if not exists source text,
  add column if not exists taken_in_at timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancel_reason text,
  add column if not exists delivered_at timestamptz,
  add column if not exists updated_at timestamptz,
  add constraint fulfillment_orders_weight_status_valid
    check (weight_status is null or weight_status in ('RESOLVED', 'UNRESOLVED')),
  add constraint fulfillment_orders_total_weight_nonnegative
    check (total_weight_grams is null or total_weight_grams >= 0),
  add constraint fulfillment_orders_weight_consistent check (
    (weight_status = 'RESOLVED' and total_weight_grams is not null)
    or (weight_status is distinct from 'RESOLVED' and total_weight_grams is null)
  ),
  add constraint fulfillment_orders_state_valid
    check (state in ('POOLED', 'ALLOCATED', 'DELIVERED', 'CANCELLED', 'ORPHANED')),
  add constraint fulfillment_orders_cancel_reason_length
    check (cancel_reason is null or char_length(cancel_reason) <= 240);

create index if not exists fulfillment_orders_business_state_idx
  on fulfillment_orders (business_id, state, confirmed_at, id);
