-- Restore the previous default name on rows that still carry the renamed default.
update cp2_conversations
set record = jsonb_set(record, '{title}', to_jsonb('Your daemon'::text)),
  updated_at = now()
where record ->> 'isPermanentDaemon' = 'true'
  and record ->> 'title' = 'My Assistant';

update cp2_native_runtime_agents
set record = jsonb_set(record, '{name}', to_jsonb('Your daemon'::text)),
  updated_at = now()
where entity_id like 'account-%-agent'
  and record ->> 'name' = 'My Assistant';

-- Re-attach chats detached from a conversation-selection runtime, where that binding still exists.
update cp2_conversations
set record = jsonb_set(record - 'detachedRuntimeBindingId', '{runtimeBindingId}',
    record -> 'detachedRuntimeBindingId'),
  updated_at = now()
where record ? 'detachedRuntimeBindingId'
  and record ->> 'detachedRuntimeBindingId' in (select entity_id from cp2_native_runtime_bindings);

drop function if exists grogoni_conversation_task_runtime(uuid, text);

-- Before 132 the account agent always ran the default Grogoni engine (there was no agent switch):
-- put back any account agent switched to another engine, or old code would keep running it with
-- no way to see or change it.
update cp2_native_runtime_agents
set record = jsonb_set(
    jsonb_set(
      jsonb_set(record, '{configuration,runtimeAdapterId}', to_jsonb('grogoni'::text)),
      '{provider}', to_jsonb('grogoni-business-agent'::text)),
    '{packageRef}', 'null'::jsonb),
  updated_at = now()
where entity_id like 'account-%-agent'
  and record -> 'configuration' ->> 'runtimeAdapterId' is distinct from 'grogoni';
