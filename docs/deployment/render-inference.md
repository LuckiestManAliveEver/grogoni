# Render inference boundary

Production routes inference through Vercel, declared as an independent deployment in
`services/ai-runtime` (not a service block in `render.yaml`). The Render API holds only Vercel's
public HTTPS URL (`VERCEL_INFERENCE_URL`) and a shared bearer token
(`GROGONI_INFERENCE_SERVICE_TOKEN`) - Vercel has no access to Postgres, business data, or tool
credentials, and never receives a database connection string.

The API remains the authenticated control plane for sessions, business data, message persistence,
tool allow-lists, authorization, confirmation and audit. Model output is untrusted input to that
boundary. Vercel has no business-data or tool-execution authority - it downloads a GGUF artifact
from a signed Neon object-storage URL Render mints for it, runs inference, and streams tokens back.

`pnpm check:render-inference-boundaries` enforces separation: API source cannot import
`node-llama-cpp` or any local model engine, `render.yaml` must not declare a Render-hosted
inference service (no `grogoni-inference`, no `BACKEND_INFERENCE_*`, no `type: pserv` on the
API), the API service block must carry `VERCEL_INFERENCE_URL`/`GROGONI_INFERENCE_SERVICE_TOKEN`, and
no browser environment variable may contain the inference token or the Neon storage credentials.

The default runtime is Pi plus canonical model `smollm2-360m`, executed on Vercel
(`PLATFORM_DEFAULT_EXECUTION_TARGET=vercel`). Other agent adapters, models and execution targets
(a self-hosted `backend` adapter, `remote-shop-device`) remain valid explicit selections through the
same `ModelExecutionTarget` union - there is no implicit provider substitution.

Operational configuration, verification and rollback are in
[vercel-inference.md](./vercel-inference.md). Architecture and precedence are in
[inference-runtime.md](../architecture/inference-runtime.md) and
[swappable-agent-model-runtime.md](../architecture/swappable-agent-model-runtime.md).
