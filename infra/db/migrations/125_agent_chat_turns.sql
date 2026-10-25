-- One row per chat message whose agent reply runs in the background on the Edge API
-- (docs/deployment/supabase-edge-api.md, "Agent turns"). The request that accepts the message
-- writes the row as 'pending' in its own transaction; a worker claims it under a lease, makes the
-- model call with no transaction open, and marks it 'completed' in the same commit as the reply.
-- A run that stops renewing its lease is retried once, then marked 'failed'.
create table if not exists agent_chat_turns (
  id uuid primary key,
  message_id text not null unique,
  conversation_id text not null,
  account_id uuid not null references accounts(id) on delete cascade,
  business_id text not null,
  -- The session that sent the message; the worker acts as it. Cleared once the turn ends.
  session_id uuid,
  -- What the worker needs to run the turn again: the agent part of the original request.
  request jsonb not null,
  stream_turn_id text,
  status text not null default 'pending' check (status in ('pending','running','completed','failed')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 2 check (max_attempts between 1 and 5),
  lease_token uuid,
  lease_until timestamptz,
  result jsonb,
  error_code text,
  retryable boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  -- A running row without a lease could never be recovered.
  constraint agent_chat_turns_running_leased
    check (status <> 'running' or (lease_token is not null and lease_until is not null))
);
-- Claims run turns of one conversation in order; recovery scans unfinished rows.
create index if not exists agent_chat_turns_open on agent_chat_turns (conversation_id, created_at)
where status in ('pending','running');
-- Retention deletes finished rows oldest first.
create index if not exists agent_chat_turns_finished on agent_chat_turns (updated_at)
where status in ('completed','failed');
revoke all on agent_chat_turns from public;
do $roles$
begin
  if exists (select 1 from pg_roles where rolname='anon') then
    execute 'revoke all on agent_chat_turns from anon';
  end if;
  if exists (select 1 from pg_roles where rolname='authenticated') then
    execute 'revoke all on agent_chat_turns from authenticated';
  end if;
end
$roles$;
