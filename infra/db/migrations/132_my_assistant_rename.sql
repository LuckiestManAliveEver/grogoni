-- Rename the permanent daemon conversation and its account agent from "Your daemon" to
-- "My Assistant". Only rows still carrying the old default name change, so an owner-chosen title
-- is never overwritten. New rows get the name from permanentDaemonDisplayName in shared-types.
update cp2_conversations
set record = jsonb_set(record, '{title}', to_jsonb('My Assistant'::text)),
  updated_at = now()
where record ->> 'isPermanentDaemon' = 'true'
  and record ->> 'title' = 'Your daemon';

update cp2_native_runtime_agents
set record = jsonb_set(record, '{name}', to_jsonb('My Assistant'::text)),
  updated_at = now()
where entity_id like 'account-%-agent'
  and record ->> 'name' = 'Your daemon';

-- Only My Assistant may hold an explicit "conversation-selection" runtime: every such binding runs
-- the one shared account agent (account-<id>-agent), whose engine My Assistant's details now
-- switch. Before this change the selection route accepted any one-person agent chat, so detach
-- any other chat still bound that way; it falls back to the runtime it would have without a
-- selection. The old id is kept under detachedRuntimeBindingId for the rollback. Only accounts
-- whose permanent conversation is already flagged are touched: the flag is set lazily, and an
-- account without it may still promote this very chat to My Assistant, selection included.
update cp2_conversations c
set record = jsonb_set(c.record, '{runtimeBindingId}', 'null'::jsonb)
    || jsonb_build_object('detachedRuntimeBindingId', c.record -> 'runtimeBindingId'),
  updated_at = now()
where coalesce(c.record ->> 'isPermanentDaemon', 'false') <> 'true'
  and exists (
    select 1 from cp2_conversations assistant
    where assistant.account_id = c.account_id
      and assistant.record ->> 'isPermanentDaemon' = 'true'
  )
  and c.record ->> 'runtimeBindingId' in (
    select entity_id from cp2_native_runtime_bindings
    where record -> 'configuration' ->> 'source' = 'conversation-selection'
  );

-- The model and engine a queued task's conversation is on now (My Assistant's details), for the
-- daemon lanes' claim-time refresh. SECURITY DEFINER so the least-privilege native daemon role
-- (infra/db/roles/grogoni_daemon_role.sql), which may read only grogoni_daemon_tasks, can ask
-- this one question without read access to users or conversations. It answers only for the
-- owner's My Assistant conversation, and only an explicit selection whose binding, agent and model
-- are active.
create or replace function grogoni_conversation_task_runtime(owner_user_id uuid, conversation_id text)
returns table (engine text, model_id text)
language sql
stable
security definer
as $fn$select a.record->'configuration'->>'runtimeAdapterId' as engine, m.record->>'modelId' as model_id
       from users u
       join cp2_conversations c on c.entity_id = $2 and c.account_id = u.account_id::text
         and c.record->>'deletedAt' is null and c.record->>'isPermanentDaemon' = 'true'
       join cp2_native_runtime_bindings b on b.entity_id = c.record->>'runtimeBindingId'
         and b.record->>'status' = 'active'
         and b.record->'configuration'->>'source' = 'conversation-selection'
       join cp2_native_runtime_agents a on a.entity_id = b.parent_id and a.record->>'status' = 'active'
       join cp2_native_runtime_binding_models m on m.parent_id = b.entity_id
         and m.role = 'primary' and m.enabled
       join cp2_native_runtime_models model on model.entity_id = m.record->>'modelId'
         and model.record->>'status' = 'active'
       where u.id = $1
       limit 1
$fn$;
-- A SECURITY DEFINER function must not resolve names through a caller-controlled path: pin it to
-- this schema with pg_temp last, so a caller's temporary tables can never stand in for users or
-- the cp2 tables (pg_catalog is always searched first).
do $path$
begin
  execute format(
    'alter function grogoni_conversation_task_runtime(uuid, text) set search_path = %I, pg_temp',
    current_schema()
  );
end
$path$;
-- Only the owner (the API) and roles granted explicitly (infra/db/roles/grogoni_daemon_role.sql)
-- may call it; on Supabase also revoke the direct grants new functions get for PostgREST roles.
revoke all on function grogoni_conversation_task_runtime(uuid, text) from public;
do $roles$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function grogoni_conversation_task_runtime(uuid, text) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function grogoni_conversation_task_runtime(uuid, text) from authenticated';
  end if;
end
$roles$;
