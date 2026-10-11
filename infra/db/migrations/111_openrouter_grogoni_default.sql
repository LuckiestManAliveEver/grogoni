-- Grogoni + Luna: update only the repository-owned default; preserve explicit shop/account bindings.
insert into cp2_model_catalog (entity_id, record, updated_at)
values ('gpt-6-luna', '{"id":"gpt-6-luna","label":"GPT-6 Luna","provider":"openrouter","description":"GPT-6 Luna through OpenRouter, platform-funded within deployment limits.","capabilities":["chat","multilingual","reasoning","instruction-following"],"available":true,"source":"hosted","format":"remote","license":null,"licenseUrl":null,"modelCardUrl":"https://openrouter.ai/openai/gpt-6-luna","downloadUrl":null,"fileName":null,"fileSizeBytes":null,"minimumMemoryGb":null,"recommended":true,"contextWindow":1050000,"canonicalModelId":"openai/gpt-6-luna","supportsToolCalling":true,"supportsStructuredOutput":true,"costResponsibility":"platform-included"}'::jsonb, now())
on conflict (entity_id) do update set record = excluded.record, updated_at = excluded.updated_at;

update cp2_agent_catalog set record = record || jsonb_build_object('runtimeAdapterId', 'grogoni'), updated_at = now()
where entity_id = 'builtin:shopkeeper';

insert into cp2_native_runtime_agents (entity_id, record, updated_at)
values ('builtin:shopkeeper:v1', jsonb_build_object(
  'id', 'builtin:shopkeeper:v1', 'businessId', null, 'accountId', null, 'name', 'Shopkeeper',
  'provider', 'grogoni-business-agent', 'packageRef', null, 'version', '1',
  'runtimeContractVersion', '1', 'capabilities', jsonb_build_array('tools', 'mcp'),
  'configuration', jsonb_build_object('runtimeAdapterId', 'grogoni', 'requiredModelCapabilities', jsonb_build_array('chat')),
  'status', 'active', 'createdAt', now(), 'updatedAt', now()), now())
on conflict (entity_id) do update set record = excluded.record, updated_at = excluded.updated_at;

insert into cp2_native_runtime_models (entity_id, record, updated_at)
values ('gpt-6-luna', jsonb_build_object(
  'id', 'gpt-6-luna', 'name', 'GPT-6 Luna', 'provider', 'openrouter', 'providerModelId', 'openai/gpt-6-luna',
  'runtimeContractVersion', '1', 'capabilities', jsonb_build_array('chat', 'multilingual', 'reasoning', 'instruction-following'),
  'configuration', jsonb_build_object('executionTarget', 'backend'), 'status', 'active', 'createdAt', now(), 'updatedAt', now()), now())
on conflict (entity_id) do update set record = excluded.record, updated_at = excluded.updated_at;

insert into cp2_native_execution_hosts (entity_id, record, updated_at)
values ('builtin:provider-router:v1', jsonb_build_object(
  'id', 'builtin:provider-router:v1', 'businessId', null, 'accountId', null, 'type', 'backend', 'name', 'Grogoni hosted runtime',
  'endpoint', null, 'status', 'available', 'capabilities', jsonb_build_array('backend'),
  'configuration', jsonb_build_object('executionTarget', 'backend'), 'credentialReference', null,
  'lastKnownHealthyAt', null, 'createdAt', now(), 'updatedAt', now()), now())
on conflict (entity_id) do update set record = excluded.record, updated_at = excluded.updated_at;

insert into cp2_native_model_installations (entity_id, parent_id, record, updated_at)
values ('4f0b8f3e-6c1d-4f5e-9a7b-2d3c9e1f6a05', 'builtin:provider-router:v1', jsonb_build_object(
  'id', '4f0b8f3e-6c1d-4f5e-9a7b-2d3c9e1f6a05', 'modelId', 'gpt-6-luna', 'executionHostId', 'builtin:provider-router:v1',
  'status', 'available', 'configuration', '{}'::jsonb, 'lastKnownHealthyAt', null, 'createdAt', now(), 'updatedAt', now()), now())
on conflict (entity_id) do update set parent_id = excluded.parent_id, record = excluded.record, updated_at = excluded.updated_at;

delete from cp2_native_runtime_binding_models where parent_id = 'builtin:grogoni-default-runtime:v1' and role = 'primary';
insert into cp2_native_runtime_binding_models (entity_id, parent_id, record, updated_at)
values ('9c2e7a41-3b5d-4e8f-a6c0-1d7f2b9e4c63', 'builtin:grogoni-default-runtime:v1', jsonb_build_object(
  'id', '9c2e7a41-3b5d-4e8f-a6c0-1d7f2b9e4c63', 'runtimeBindingId', 'builtin:grogoni-default-runtime:v1', 'modelId', 'gpt-6-luna',
  'role', 'primary', 'priority', 0, 'executionHostId', 'builtin:provider-router:v1', 'configuration', '{}'::jsonb,
  'enabled', true, 'createdAt', now(), 'updatedAt', now()), now())
on conflict (entity_id) do update set parent_id = excluded.parent_id, record = excluded.record, updated_at = excluded.updated_at;

update cp2_native_runtime_bindings set parent_id = 'builtin:shopkeeper:v1', record = record || jsonb_build_object(
  'agentId', 'builtin:shopkeeper:v1', 'name', 'Shopkeeper + GPT-6 Luna default runtime', 'status', 'active',
  'configuration', jsonb_build_object('source', 'repository-default'), 'updatedAt', now(), 'updatedBy', 'system'), updated_at = now()
where entity_id = 'builtin:grogoni-default-runtime:v1';
