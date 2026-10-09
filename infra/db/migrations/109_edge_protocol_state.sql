create table if not exists cp2_edge_protocol_state (
  entity_id text primary key,
  record jsonb not null,
  updated_at timestamptz not null default now()
);

comment on table cp2_edge_protocol_state is
  'Transactional MCP sessions, rate windows, checkout confirmations, and one-use OAuth grants for Edge workers.';
