# Model artifact storage

GGUF model weights live in Neon's S3-compatible object storage, never in this repository and never
in a PostgreSQL `bytea` column. Postgres holds metadata only.

## Schema

`cp2_runtime_model_artifacts` (`infra/db/migrations/079_vercel_inference_artifacts.sql`):

```text
id               text primary key
model_id         text references cp2_native_runtime_models(entity_id)
storage_provider text            -- "neon-object-storage" is the only supported value
bucket           text
object_key       text            -- validated: no "..", no leading "/", no backslash
format           text            -- "gguf" is the only format the runtime loads
quantization     text nullable
size_bytes       bigint nullable
sha256           text nullable   -- validated as 64 lowercase hex characters when present
content_type     text default 'application/octet-stream'
status           text            -- 'pending' | 'available' | 'invalid' | 'retired'
created_at, updated_at
```

Constraints worth knowing about, all enforced at the database level (not just application code):

- `cp2_runtime_model_artifacts_one_available_per_model_idx` - a partial unique index ensuring at most one
  `status = 'available'` artifact per `model_id`. Rotating a model's artifact is: insert the new row
  as `pending`, verify it, flip it to `available`, flip the old row to `retired` - never two
  `available` rows for the same model at once.
- `cp2_runtime_model_artifacts_object_key_check` - rejects path traversal (`..`), absolute paths, and
  backslashes at write time, on top of the same check `assertSafeArtifactLocation()`
  (`services/api/src/inference/model-artifact-store.ts`) performs again before every read, in case a
  row was ever written by a path that bypassed the constraint.
- `cp2_runtime_model_artifacts_format_check` / `_sha256_check` - regex-validated at write time.

## Who touches what

```text
Neon Postgres (cp2_runtime_model_artifacts)
    |
    | resolveArtifact(modelId) -> ModelArtifact (metadata only)
    v
Render (ModelArtifactStore, services/api/src/inference/model-artifact-store.ts)
    |
    | createDownloadUrl(artifact) -> hand-rolled AWS SigV4 GET presign,
    |                                 TTL 60-3600s (MODEL_ARTIFACT_URL_TTL_SECONDS, default 900)
    v
ResolvedModelArtifact { ...artifact, downloadUrl, expiresAt }
    |
    | sent as part of InferenceExecutionRequest
    v
Vercel (downloadVerifiedArtifact, services/ai-runtime/src/artifact-loader.ts)
    |
    +-- reject if host not in MODEL_ARTIFACT_ALLOWED_HOSTS, or protocol isn't https (SSRF guard)
    +-- reject if expiresAt has passed
    +-- reject if format isn't "gguf", or declared size exceeds VERCEL_MAX_ARTIFACT_BYTES
    +-- reuse an on-disk cached copy if one already matches by sha256 and size
    +-- otherwise stream-download with redirect: "error", enforcing the byte cap mid-stream
    +-- verify actual byte count == sizeBytes, actual sha256 == artifact.sha256
    +-- atomically rename into place only after every check passes
```

Render never has standing access to the object bytes - only short-lived, scoped, signed URLs it
mints on demand. Vercel never has standing storage credentials - it only ever receives one signed
URL per request, already scoped to one object.

## Uploading a new artifact

There is no upload endpoint; artifacts are staged directly in Neon object storage by an operator,
then registered in `cp2_runtime_model_artifacts`:

1. Upload the `.gguf` file to the configured bucket at a chosen object key (convention:
   `models/<model-id>/<filename>.gguf`).
2. Compute its SHA-256 and byte size.
3. Insert a `cp2_runtime_model_artifacts` row with `status: 'pending'`.
4. Verify: `ModelArtifactStore.verifyArtifact()` does a `HEAD` request against a signed URL and
   compares `content-length` to `size_bytes` - this is a metadata sanity check, not a hash proof (a
   `HEAD` request cannot prove a SHA-256). The real hash verification happens the first time Vercel
   actually downloads the object (`downloadVerifiedArtifact`), which is why `size_bytes` and
   `sha256` must both be correct before flipping status.
5. Flip the row to `status: 'available'`. If replacing an existing available artifact for the same
   model, flip the old row to `retired` in the same transaction (the partial unique index will
   reject two simultaneous `available` rows regardless).

Migration `079_vercel_inference_artifacts.sql` seeds the platform default this way:
`builtin:smollm2-360m:q4_0:gguf`, pointing at `models/smollm2-360m/SmolLM2-360M-Instruct-Q4_0.gguf`
in the `grogoni-model-artifacts` bucket. The operator uploading that exact object with a matching
checksum before switching traffic to Vercel is a deployment prerequisite, not something the
migration does for you - see [../deployment/vercel-inference.md](../deployment/vercel-inference.md).

## Format support

Only `format: "gguf"` is supported end to end today - both the database CHECK constraint and
`downloadVerifiedArtifact`'s `validateArtifact()` reject anything else before any network call. A
new format requires a corresponding runtime loader on the Vercel side (something implementing the
same `LoadedLlamaRuntime`-shaped contract `services/ai-runtime/src/llama-runtime.ts` does for GGUF)
before the format check can be relaxed.
