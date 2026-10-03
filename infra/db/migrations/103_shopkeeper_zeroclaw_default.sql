-- Platform default before any swap: the Shopkeeper agent on the ZeroClaw agent runtime with
-- OpenAI's GPT-6 Luna, Grogoni-funded (docs/adr/ADR-zeroclaw-default-agent-runtime.md).
--
-- Mirrors repositoryDefaultRuntimePolicy and inferenceRouterSeedModels. Only repository-owned
-- rows change: the GPT-6 Luna catalog entry (never overwriting an operator's row), the built-in
-- Shopkeeper definitions, and the global default binding slot (rewritten in place, as 077 did, so
-- every conversation pointing at it keeps its foreign key). Tenant and account bindings a shop
-- already activated are left exactly as they are.

insert into cp2_model_catalog (entity_id, record, updated_at) values
  ('gpt-6-luna', '{"id":"gpt-6-luna","label":"GPT-6 Luna","provider":"openai","description":"OpenAI''s efficient model for focused, high-volume tasks. Included with Grogoni: the platform pays for it within Grogoni''s usage limits.","capabilities":["chat","multilingual","reasoning","instruction-following"],"available":true,"source":"hosted","format":"remote","license":null,"licenseUrl":null,"modelCardUrl":"https://developers.openai.com/api/docs/models/gpt-6-luna","downloadUrl":null,"fileName":null,"fileSizeBytes":null,"minimumMemoryGb":null,"recommended":true,"contextWindow":1050000,"canonicalModelId":"gpt-6-luna","supportsToolCalling":true,"supportsStructuredOutput":true,"inference":{"providerId":"openai","providerModelId":"gpt-6-luna","executionTarget":"remote-inference","capabilities":{"text":true,"structuredOutput":true,"streaming":true,"reasoning":true},"maxOutputTokens":1024,"enabled":true,"pricing":{"inputPerMillionTokens":0.1,"outputPerMillionTokens":0.5,"currency":"USD"}}}'::jsonb, now())
on conflict (entity_id) do nothing;

-- Shopkeeper now names ZeroClaw as its engine. A deployment without a ZeroClaw gateway resolves
-- that to Grogoni's built-in engine at configuration time; "Shopkeeper (Grogoni engine)" lets a shop
-- choose the built-in engine explicitly.
update cp2_agent_catalog
set record = record || jsonb_build_object(
    'runtimeAdapterId', 'zeroclaw',
    'description', 'Grogoni''s default shop assistant, running on the ZeroClaw agent runtime. Also the safe fallback while the open-source agent catalogue is unavailable.'
  ),
  updated_at = now()
where entity_id = 'builtin:shopkeeper';

insert into cp2_agent_catalog (entity_id, record, updated_at) values
  ('builtin:shopkeeper-grogoni', '{"id":"builtin:shopkeeper-grogoni","displayName":"Shopkeeper (Grogoni engine)","role":"General shopkeeper and storefront attendant","description":"Same shopkeeper behavior, running on Grogoni''s built-in agent engine.","operatingPattern":"Focused operator","workloadClass":"focused","minimumDeviceTier":"low","minimumMemoryGb":2,"recommendedContextTokens":1024,"personality":"Warm, concise, accurate and commercially practical","instructions":"Handle one clear shop task at a time, use saved business records, and ask before risky changes. When a workspace file should be given to the user, call workspace.deliver and refer to the delivered attachment without exposing its filesystem path.","knowledge":"Use saved products, customers, invoices, payments, receipts and shop policies.","tools":["Products","Customers","Suppliers","Invoices","Payments","Receipts","Reports","Notifications","Logistics","Workspace delivery"],"skillIds":[],"runtimeAdapterId":"grogoni"}'::jsonb, now())
on conflict (entity_id) do update
set record = excluded.record, updated_at = excluded.updated_at;

insert into cp2_native_runtime_agents (entity_id, record, updated_at) values
  ('builtin:shopkeeper:v1', '{"id":"builtin:shopkeeper:v1","businessId":null,"accountId":null,"name":"Shopkeeper","provider":"zeroclaw","packageRef":"github:zeroclaw-labs/zeroclaw","version":"1","runtimeContractVersion":"1","capabilities":["tools","mcp"],"configuration":{"runtimeAdapterId":"zeroclaw","requiredModelCapabilities":["chat"]},"status":"active","createdAt":"2026-09-26T00:00:00.000Z","updatedAt":"2026-09-26T00:00:00.000Z"}'::jsonb, now())
on conflict (entity_id) do update
set record = excluded.record, updated_at = excluded.updated_at;

insert into cp2_native_runtime_models (entity_id, record, updated_at) values
  ('gpt-6-luna', '{"id":"gpt-6-luna","name":"GPT-6 Luna","provider":"openai","providerModelId":"gpt-6-luna","runtimeContractVersion":"1","capabilities":["chat","multilingual","reasoning","instruction-following"],"configuration":{"executionTarget":"backend"},"status":"active","createdAt":"2026-09-26T00:00:00.000Z","updatedAt":"2026-09-26T00:00:00.000Z"}'::jsonb, now())
on conflict (entity_id) do update
set record = excluded.record, updated_at = excluded.updated_at;

-- Provider-routed models (GPT-6 Luna) run through the API's inference router, not on a model
-- host. This is the global default slot's backend host for them; the retired Render llama host
-- (83ac7c89-..., unavailable since 079) is left untouched.
insert into cp2_native_execution_hosts (entity_id, record, updated_at) values (
  'builtin:provider-router:v1',
  '{"id":"builtin:provider-router:v1","businessId":null,"accountId":null,"type":"backend","name":"Grogoni provider router","endpoint":null,"status":"available","capabilities":["backend","provider-routed"],"configuration":{"executionTarget":"backend"},"credentialReference":null,"lastKnownHealthyAt":null,"createdAt":"2026-09-26T00:00:00.000Z","updatedAt":"2026-09-26T00:00:00.000Z"}'::jsonb,
  now()
) on conflict (entity_id) do update
set record = excluded.record, updated_at = excluded.updated_at;

insert into cp2_native_model_installations (entity_id, parent_id, record, updated_at) values (
  '4f0b8f3e-6c1d-4f5e-9a7b-2d3c9e1f6a05',
  'builtin:provider-router:v1',
  '{"id":"4f0b8f3e-6c1d-4f5e-9a7b-2d3c9e1f6a05","modelId":"gpt-6-luna","executionHostId":"builtin:provider-router:v1","status":"available","configuration":{},"lastKnownHealthyAt":null,"createdAt":"2026-09-26T00:00:00.000Z","updatedAt":"2026-09-26T00:00:00.000Z"}'::jsonb,
  now()
) on conflict (entity_id) do update
set parent_id = excluded.parent_id, record = excluded.record, updated_at = excluded.updated_at;

delete from cp2_native_runtime_binding_models
where parent_id = 'builtin:grogoni-default-runtime:v1' and role = 'primary';

insert into cp2_native_runtime_binding_models (entity_id, parent_id, record, updated_at) values (
  '9c2e7a41-3b5d-4e8f-a6c0-1d7f2b9e4c63',
  'builtin:grogoni-default-runtime:v1',
  '{"id":"9c2e7a41-3b5d-4e8f-a6c0-1d7f2b9e4c63","runtimeBindingId":"builtin:grogoni-default-runtime:v1","modelId":"gpt-6-luna","role":"primary","priority":0,"executionHostId":"builtin:provider-router:v1","configuration":{},"enabled":true,"createdAt":"2026-09-26T00:00:00.000Z","updatedAt":"2026-09-26T00:00:00.000Z"}'::jsonb,
  now()
) on conflict (entity_id) do update
set parent_id = excluded.parent_id, record = excluded.record, updated_at = excluded.updated_at;

update cp2_native_runtime_bindings
set parent_id = 'builtin:shopkeeper:v1',
  record = record || jsonb_build_object(
    'agentId', 'builtin:shopkeeper:v1',
    'name', 'Shopkeeper + GPT-6 Luna default runtime',
    'status', 'active',
    'isDefault', true,
    'configuration', jsonb_build_object('source', 'repository-default'),
    'updatedAt', '2026-09-26T00:00:00.000Z',
    'updatedBy', 'system'
  ),
  updated_at = now()
where entity_id = 'builtin:grogoni-default-runtime:v1';
