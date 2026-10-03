-- Vercel is an execution host. Neon remains the control plane and stores artifact metadata only;
-- GGUF bytes live in the configured Neon object-storage bucket, never in a PostgreSQL bytea.
--
-- cp2_runtime_model_artifacts is a distinct table from cp2_model_artifacts (migration 066).
-- cp2_model_artifacts is the legacy account-scoped subsystem: private, user-uploaded GGUF chunks
-- stored as Postgres bytea (artifact_id/account_id/user_id/metadata/chunk_*), still owned by
-- services/api/src/cp2/postgres-store.ts. cp2_runtime_model_artifacts below is the platform's
-- shared runtime model registry: pointers to objects in Neon's S3-compatible object storage,
-- owned by services/api/src/inference/model-artifact-store.ts. Never merge these two tables or
-- reuse either name for the other concept - a prior draft of this migration collided with the
-- legacy table by reusing its name, which fails in production because the schemas differ (the
-- legacy table has no `id` column).
create table if not exists cp2_runtime_model_artifacts (
  id text primary key,
  model_id text not null references cp2_native_runtime_models(entity_id) on delete restrict,
  storage_provider text not null,
  bucket text not null,
  object_key text not null,
  format text not null,
  quantization text,
  size_bytes bigint,
  sha256 text,
  content_type text not null default 'application/octet-stream',
  status text not null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint cp2_runtime_model_artifacts_location_unique
    unique (storage_provider, bucket, object_key),
  constraint cp2_runtime_model_artifacts_status_check
    check (status in ('pending', 'available', 'invalid', 'retired')),
  constraint cp2_runtime_model_artifacts_format_check
    check (format ~ '^[a-z0-9][a-z0-9._-]{0,31}$'),
  constraint cp2_runtime_model_artifacts_object_key_check check (
    object_key !~ '(^|/)\.\.(/|$)' and object_key !~ '^/' and object_key !~ '[\\]'
  ),
  constraint cp2_runtime_model_artifacts_size_check check (size_bytes is null or size_bytes > 0),
  constraint cp2_runtime_model_artifacts_sha256_check
    check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$')
);

create unique index if not exists cp2_runtime_model_artifacts_one_available_per_model_idx
  on cp2_runtime_model_artifacts (model_id) where status = 'available';

-- Seed normal runtime data for the existing platform default. Operators upload this exact object
-- to NEON_MODEL_STORAGE_BUCKET before switching traffic; the checksum is the upstream GGUF hash.
insert into cp2_runtime_model_artifacts (
  id, model_id, storage_provider, bucket, object_key, format, quantization, size_bytes, sha256,
  content_type, status, created_at, updated_at
) values (
  'builtin:smollm2-360m:q4_0:gguf',
  'smollm2-360m',
  'neon-object-storage',
  'grogoni-model-artifacts',
  'models/smollm2-360m/SmolLM2-360M-Instruct-Q4_0.gguf',
  'gguf',
  'Q4_0',
  230000000,
  'c3608933eb6e5763b87f769bda40c204dc158333668c7af214644fe39da58627',
  'application/octet-stream',
  'available',
  '2026-08-31T00:00:00.000Z',
  '2026-08-31T00:00:00.000Z'
) on conflict (id) do update set
  model_id = excluded.model_id,
  storage_provider = excluded.storage_provider,
  bucket = excluded.bucket,
  object_key = excluded.object_key,
  format = excluded.format,
  quantization = excluded.quantization,
  size_bytes = excluded.size_bytes,
  sha256 = excluded.sha256,
  content_type = excluded.content_type,
  status = excluded.status,
  updated_at = excluded.updated_at;

insert into cp2_native_execution_hosts (entity_id, record, updated_at) values (
  'builtin:vercel-inference:v1',
  '{"id":"builtin:vercel-inference:v1","businessId":null,"accountId":null,"type":"vercel","name":"Vercel inference","endpoint":null,"status":"available","capabilities":["vercel","gguf","streaming","pi"],"configuration":{"executionTarget":"vercel"},"credentialReference":"env:GROGONI_INFERENCE_SERVICE_TOKEN","lastKnownHealthyAt":null,"createdAt":"2026-08-31T00:00:00.000Z","updatedAt":"2026-08-31T00:00:00.000Z"}'::jsonb,
  now()
) on conflict (entity_id) do update set record = excluded.record, updated_at = excluded.updated_at;

update cp2_native_runtime_models
set record = jsonb_set(
    jsonb_set(record, '{configuration,executionTarget}', '"vercel"'::jsonb, true),
    '{configuration,artifactId}',
    '"builtin:smollm2-360m:q4_0:gguf"'::jsonb,
    true
  ),
  updated_at = now()
where entity_id = 'smollm2-360m';

insert into cp2_native_model_installations (entity_id, parent_id, record, updated_at) values (
  'builtin:smollm2-360m:vercel:v1',
  'builtin:vercel-inference:v1',
  '{"id":"builtin:smollm2-360m:vercel:v1","modelId":"smollm2-360m","executionHostId":"builtin:vercel-inference:v1","status":"available","configuration":{"artifactId":"builtin:smollm2-360m:q4_0:gguf"},"lastKnownHealthyAt":null,"createdAt":"2026-08-31T00:00:00.000Z","updatedAt":"2026-08-31T00:00:00.000Z"}'::jsonb,
  now()
) on conflict (entity_id) do update
set parent_id = excluded.parent_id, record = excluded.record, updated_at = excluded.updated_at;

update cp2_native_runtime_binding_models
set record = jsonb_set(record, '{executionHostId}', '"builtin:vercel-inference:v1"'::jsonb, true),
  updated_at = now()
where parent_id = 'builtin:grogoni-default-runtime:v1' and role = 'primary';

-- The superseded Render backend host/install remain historical runtime records but are explicitly
-- unavailable, so no binding can silently fail over to Render-hosted model execution.
update cp2_native_execution_hosts
set record = jsonb_set(record, '{status}', '"unavailable"'::jsonb, true), updated_at = now()
where entity_id = '83ac7c89-b541-44e0-affc-520fa6e12a72';

update cp2_native_model_installations
set record = jsonb_set(record, '{status}', '"unavailable"'::jsonb, true), updated_at = now()
where parent_id = '83ac7c89-b541-44e0-affc-520fa6e12a72';
