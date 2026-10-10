create table if not exists cp2_edge_rate_limits (
  rate_key text primary key,
  window_start timestamptz not null,
  request_count integer not null
);

create index if not exists cp2_edge_rate_limits_window_start_idx
  on cp2_edge_rate_limits (window_start);

comment on table cp2_edge_rate_limits is
  'Fixed-window request counters for the Edge API, keyed by a digest of the client address (supabase/functions/api/rate-limit.ts). Expired windows are purged by the edge_rate_limit_retention job.';
