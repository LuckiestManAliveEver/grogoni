-- Keep the repository-owned OpenAI model as the platform primary while making the existing
-- SmolLM2 installation on Vercel its explicit native-runtime fallback. Tenant/account bindings
-- remain untouched; switching the repository default provider later does not require schema work.

insert into cp2_native_runtime_binding_models (entity_id, parent_id, record, updated_at) values (
  'b5a8d41c-27fd-4a4b-a73b-9326f0dc159e',
  'builtin:grogoni-default-runtime:v1',
  '{"id":"b5a8d41c-27fd-4a4b-a73b-9326f0dc159e","runtimeBindingId":"builtin:grogoni-default-runtime:v1","modelId":"smollm2-360m","role":"fallback","priority":0,"executionHostId":"builtin:vercel-inference:v1","configuration":{"reason":"openai-provider-unavailable"},"enabled":true,"createdAt":"2026-09-27T00:00:00.000Z","updatedAt":"2026-09-27T00:00:00.000Z"}'::jsonb,
  now()
) on conflict (entity_id) do update
set parent_id = excluded.parent_id, record = excluded.record, updated_at = excluded.updated_at;
