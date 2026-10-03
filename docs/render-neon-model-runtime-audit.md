# Render and Neon model runtime audit

> Historical note: this audit originally justified a Render-private Ollama service. That service
> has since been removed from `render.yaml`. The current production boundary is documented in
> `docs/deployment/render-inference.md`; the statements below describe the earlier implementation.

## Outcome

The repository had a sound agent-binding abstraction, but production backend inference stopped at
the API container boundary. The API called an Ollama-compatible `/api/generate` endpoint directly
and defaulted to `127.0.0.1:11434`. On Render that address refers to the API container, where no
model engine runs. The existing `services/ai-runtime` package exposed only a basic health route and
was not a deployable, authenticated inference gateway.

That implementation used this boundary:

```text
PWA -> public Grogoni API -> Render private grogoni-inference -> container-local Ollama
                         |
                         +-> external Neon PostgreSQL
```

The browser never receives the inference token or private service address. OpenAI fallback remains
off by default.

## Exact findings

### Runtime and deployment

- `services/api/src/inference/model-runtime.ts` called Ollama directly instead of a private Grogoni
  inference contract.
- API configuration allowed a loopback default even though the Render API did not contain Ollama.
- The registry ID `qwen2.5-0.5b-android` was not an Ollama model name. Provider mapping was spread
  through configuration rather than enforced at every boundary.
- `services/ai-runtime` used Ollama `/api/chat` and `/api/tags`, while the old API adapter used
  `/api/generate`. There was no authenticated gateway contract between them.
- The old Render Blueprint disabled backend inference and provisioned a Render PostgreSQL database,
  which conflicted with Neon being production's source of truth.
- API startup ran migrations as part of its start command. That made every restart a migration
  attempt instead of using Render's pre-deploy phase.
- Ordinary Render filesystems are ephemeral. No model disk or explicit install policy existed.

### Activation, UI, and chat

- Activation already required an adapter health check and preserved the previous active binding on
  a failed replacement.
- Chat already resolved the active agent binding rather than a hard-coded OpenAI provider.
- A successful request was persisted through the CP2 snapshot barrier, and a persistence failure
  restored the last database snapshot.
- Repeating activation of the same configuration could create another binding record.
- The frontend's active badge already came from `activeAgentModelBinding`, but its “Available” text
  meant only “in the registry.” It did not prove runtime availability.
- Installed-app activation correctly remained unavailable without the trusted native bridge.

### Neon and schema

- Runtime queries use `DATABASE_URL`; the migration script can use `DIRECT_DATABASE_URL`.
- The migration runner already uses a PostgreSQL advisory lock and wraps each migration in a
  transaction.
- Migration `040_agent_model_runtime_bindings.sql` creates
  `cp2_agent_model_bindings_one_active_per_agent_idx`, a partial unique index over the JSON
  `agentId`.
- CP2 persistence stores records as JSONB envelopes. Consequently, the binding table does **not**
  have relational `agent_id`, `shop_id`, or `model_id` columns and cannot honestly claim foreign
  keys to normalized agent/shop/registry tables. Adding parallel normalized tables would create a
  second source of truth. Ownership and canonical model validation remain application-enforced.

## Historical corrections

- One canonical mapping in `@grogoni/shared-types` maps `qwen2.5-0.5b-android` to
  `qwen2.5:0.5b`; readiness, probes, generation, and metadata all validate it.
- The private inference gateway exposes authenticated readiness, capability, probe, and generation
  routes with bounded requests and structured errors.
- The API uses the gateway contract, has separate connect/request timeouts, retries only readiness,
  propagates cancellation and correlation IDs, and never forwards browser cookies.
- The earlier Render design used a `pserv`, persistent disk, `hostport` private discovery, and a
  generated shared token. Production no longer provisions those inference resources.
- Activation is idempotent for an already-active equivalent binding.
- The UI now treats an untested registry entry as “Not verified,” a successful probe as
  “Available,” and only the persisted active binding as “Active for …”.

## Verification boundary

Mocked tests can validate the structural contract, but they cannot establish a deployed model
service, a live completion, or a Neon transaction. For a deliberately self-hosted runtime, use
`docs/deployment/model-runtime-verification.md` after deploying. Do not interpret a unit-test pass
as a live inference pass.
