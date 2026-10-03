-- Materializes the repository default policy introduced with the swappable agent/runtime seam.
-- Only deterministic repository-owned IDs are changed; tenant/user bindings are left intact.

insert into cp2_model_catalog (entity_id, record, updated_at) values (
  'smollm2-360m',
  '{"id":"smollm2-360m","label":"SmolLM2 360M Instruct Q4_0","provider":"local","description":"Small Apache-2.0 instruction model used by the default hosted runtime.","capabilities":["chat","english","instruction-following"],"available":true,"source":"hosted","format":"remote","license":"Apache-2.0","licenseUrl":"https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct/blob/main/LICENSE","modelCardUrl":"https://ollama.com/library/smollm2:360m-instruct-q4_0","downloadUrl":null,"fileName":null,"fileSizeBytes":229000000,"minimumMemoryGb":null,"recommended":true,"contextWindow":8192}'::jsonb,
  now()
) on conflict (entity_id) do update
set record = excluded.record, updated_at = excluded.updated_at;

insert into cp2_native_runtime_agents (entity_id, record, updated_at) values (
  'builtin:pi:v1',
  '{"id":"builtin:pi:v1","businessId":null,"accountId":null,"name":"Pi","provider":"pi","packageRef":"npm:@earendil-works/pi-agent-core@0.84.4","version":"0.84.4","runtimeContractVersion":"1","capabilities":["tools","mcp"],"configuration":{"runtimeAdapterId":"pi","requiredModelCapabilities":["chat"]},"status":"active","createdAt":"2026-08-29T00:00:00.000Z","updatedAt":"2026-08-29T00:00:00.000Z"}'::jsonb,
  now()
) on conflict (entity_id) do update
set record = excluded.record, updated_at = excluded.updated_at;

insert into cp2_native_runtime_models (entity_id, record, updated_at) values (
  'smollm2-360m',
  '{"id":"smollm2-360m","name":"SmolLM2 360M Instruct Q4_0","provider":"ollama","providerModelId":"smollm2:360m-instruct-q4_0","runtimeContractVersion":"1","capabilities":["chat","english","instruction-following"],"configuration":{},"status":"active","createdAt":"2026-08-29T00:00:00.000Z","updatedAt":"2026-08-29T00:00:00.000Z"}'::jsonb,
  now()
) on conflict (entity_id) do update
set record = excluded.record, updated_at = excluded.updated_at;

update cp2_native_runtime_bindings
set parent_id = 'builtin:pi:v1',
  record = record || jsonb_build_object(
    'agentId', 'builtin:pi:v1',
    'name', 'Pi default runtime',
    'status', 'draft',
    'configuration', jsonb_build_object('source', 'repository-default'),
    'updatedAt', '2026-08-29T00:00:00.000Z',
    'updatedBy', 'system'
  ),
  updated_at = now()
where entity_id = 'builtin:grogoni-default-runtime:v1'
  and parent_id = 'builtin:grogoni-agent:v1'
  and record -> 'configuration' ->> 'source' = 'repository-default';
