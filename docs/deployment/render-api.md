# Deploy the API on Render

## Topology

`render.yaml`'s `grogoni` service is a standard `type: web`, `runtime: node` Render
service - no persistent disk, no private inference service alongside it. It builds with
`pnpm build:production` (workspace build, then the production-boundary checks in
[../runtime/vercel-inference-audit.md](../runtime/vercel-inference-audit.md)'s "Bugs found" list
apply here too), migrates the database, and verifies the schema before starting.

The API talks to three external systems, none of them containing model weights:

- **Neon Postgres** (`DATABASE_URL` / `DIRECT_DATABASE_URL`) - application state and the native
  runtime graph.
- **Neon object storage** (`NEON_MODEL_STORAGE_*`) - used only to mint short-lived signed download
  URLs for model artifacts; the API never streams the bytes itself.
- **Vercel** (`VERCEL_INFERENCE_URL` + `GROGONI_INFERENCE_SERVICE_TOKEN`) - the inference execution
  host. See [vercel-inference.md](./vercel-inference.md).

## Required configuration

The full set lives in `render.yaml`'s `grogoni` service block and `.env.example`. The
inference-relevant subset:

```text
PLATFORM_DEFAULT_EXECUTION_TARGET=vercel
VERCEL_INFERENCE_URL=<generated per environment, sync: false>
VERCEL_INFERENCE_TIMEOUT_MS=300000
INFERENCE_REQUIRED=true
GROGONI_INFERENCE_SERVICE_TOKEN=<copy the existing shared value from the old API and Vercel>
NEON_MODEL_STORAGE_ENDPOINT=<sync: false>
NEON_MODEL_STORAGE_REGION=us-east-1
NEON_MODEL_STORAGE_ACCESS_KEY_ID=<sync: false>
NEON_MODEL_STORAGE_SECRET_ACCESS_KEY=<sync: false>
MODEL_ARTIFACT_URL_TTL_SECONDS=900
INFERENCE_OWNER_NODE_ENABLED=true
INFERENCE_MAX_FALLBACKS=3
INFERENCE_JOB_TIMEOUT_MS=120000
INFERENCE_JOB_SIGNING_SECRET=<generateValue: true>
```

`VERCEL_INFERENCE_URL`, `GROGONI_INFERENCE_SERVICE_TOKEN`, and the `NEON_MODEL_STORAGE_*` credentials
are `sync: false` in `render.yaml`; they must be set by hand in the Render dashboard because they
reference infrastructure Render does not provision itself. Preserve the existing shared
`GROGONI_INFERENCE_SERVICE_TOKEN` during this service migration and verify Vercel has the exact same
value (see [vercel-inference.md](./vercel-inference.md)). `INFERENCE_JOB_SIGNING_SECRET` remains
Render-generated because it is internal to this service and does not authenticate another
provider.

## What the API does and does not do

Does:

- authenticate sessions, resolve business/conversation context;
- resolve the agent, model, and runtime binding through the native runtime graph
  (`resolveExecutionTarget`, `resolveNativeRuntimeModelProvider`);
- mint short-lived signed artifact download URLs (`services/api/src/inference/
model-artifact-store.ts`) - the URL, not the bytes, crosses to Vercel;
- authorize and execute tool calls the model requests;
- persist the conversation and stream the response to the client.

Does not:

- load, cache, or run a model (`pnpm check:render-inference-boundaries` fails the build if
  `node-llama-cpp` or a similar engine ever becomes a dependency of `services/api`);
- give Vercel direct database access or tool-execution authority;
- expose `GROGONI_INFERENCE_SERVICE_TOKEN`, the Neon storage credentials, or a signed artifact URL to
  the browser (the same boundary check enforces this for every `VITE_*` variable).

## Health surfaces

- `GET /health/ready` - overall readiness (database + inference, gated by `INFERENCE_REQUIRED`).
  Render's own health check target (`healthCheckPath` in `render.yaml`).
- `GET /health/ai` - runs a real inference call through the resolved default adapter (Vercel today).
  Used by `pnpm inference:probe` and `pnpm verify:production-runtime` for true end-to-end
  verification, not just liveness.
- `GET /health/db` - database-only diagnostic.

See [vercel-inference.md](./vercel-inference.md) for the corresponding Vercel-side health surface
and the full rollout sequence, and [model-runtime-verification.md](./model-runtime-verification.md)
for the verification commands.
