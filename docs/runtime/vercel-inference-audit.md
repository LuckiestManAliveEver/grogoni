# Vercel inference migration audit

Phase 0 deliverable for moving Grogoni's inference execution off Render and onto Vercel, keeping
Render as the control plane and Neon as the store for both application state and model-artifact
metadata. This documents the actual repository state found, what was reused, what was removed, and
the resulting architecture - not a plan written before the code existed.

## Architecture before

```text
Chat client
    -> Render API (services/api)
        -> authenticate, resolve conversation/business context
        -> resolve agent + model + runtime binding (native runtime graph, Neon Postgres)
        -> resolve execution target: "backend"
        -> createBackendModelAdapter (services/api/src/inference/model-runtime.ts)
            -> HTTP call over Render's private network to services/ai-runtime
                -> Fastify app (services/ai-runtime/src/app.ts)
                -> Ollama engine (services/ai-runtime/src/inference-engine.ts,
                   services/ai-runtime/src/ollama-model.ts) against a Render persistent disk
                   (/var/lib/grogoni-models), OR
                -> optional OpenAI cloud fallback (services/api/src/inference/openai-provider.ts)
        <- normalized completion
    -> tool execution, persistence, response
```

`render.yaml` declared `grogoni-inference` as a Render private (`pserv`) Docker service running
`services/ai-runtime/Dockerfile`, with a 5 GB persistent disk mounted at `/var/lib/grogoni-models` and
Ollama bound to loopback inside the container. The API received the service's private
`hostport`/token through Render's `fromService` linking and never had a public inference endpoint.

## Canonical entry points identified

- **Chat entry point:** `POST /v1/messages` and `POST /businesses/:id/runtime/turns`
  (`services/api/src/cp2/domains/agent-runtime/routes.ts`), both routing through
  `AgentRuntimeDomain.createRuntimeTurn` (`store.ts`).
- **Runtime resolver:** `resolveExecutionTarget()` /
  `resolveNativeRuntimeModelProvider()` (`services/api/src/cp2/domains/agent-runtime/
native-runtime-routing.ts`) - already fully generic over `ModelExecutionTarget`, driven by the
  native runtime graph (`cp2_native_execution_hosts`, `cp2_native_runtime_models`,
  `cp2_native_model_installations`, `cp2_native_runtime_bindings`). This module required **no**
  changes; it never hardcoded a target.
- **Inference provider interface:** `ModelRuntimeAdapter` (`canRun` / `healthCheck` / `generate`)
  and `RuntimeModelProvider` (`complete`) in `services/api/src/inference/model-runtime.ts`, adapted
  into each other by `runtimeProviderFromAdapter`. This is the swappable-primitive boundary the task
  asked to preserve, and it did not need to change shape.
- **Model artifact/binding tables:** `cp2_native_execution_hosts`, `cp2_native_runtime_models`,
  `cp2_native_model_installations`, `cp2_native_runtime_bindings`,
  `cp2_native_runtime_binding_models` (all pre-existing, from the prior native-runtime-binding
  unification work referenced in `docs/architecture/native-runtime-bindings.md`).

## Components reused as-is

- The entire native runtime graph and its resolver (`native-runtime-routing.ts`,
  `native-runtime/store.ts`'s binding/host/installation/role tables).
- `ModelRuntimeAdapter` / `RuntimeModelProvider` / `runtimeProviderFromAdapter` - the adapter
  abstraction itself.
- `OwnerNodeBroker` (`services/api/src/inference/owner-node-broker.ts`) - the separate
  `remote-shop-device` execution target (merchant-owned hardware, WebSocket-registered, HMAC-signed
  jobs). Untouched; a legitimate second execution target with its own broker, not a duplicate of the
  Vercel path.
- `modelExecutionTargets` / `isModelExecutionTarget` (`packages/shared-types/src/index.ts`) - the
  existing three-value union (`"vercel" | "backend" | "remote-shop-device"`) already modeled Vercel
  as a first-class target before this audit; the gap was in code that hardcoded `"backend"` instead
  of consulting this union or the platform's configured default.

## Components removed

- `services/ai-runtime/src/app.ts`, `server.ts`, `inference-engine.ts`, `local-model.ts`,
  `ollama-model.ts`, `openai-model.ts`, `redis-client.ts`, `runtime-config.ts`,
  `scripts/model-admin.mjs`, `scripts/start-inference.sh`, `Dockerfile` - the entire Fastify +
  Ollama + Redis private-service implementation.
- `services/api/src/inference/openai-provider.ts` - the OpenAI Responses API adapter and its
  `openai-fast` / `openai-reasoning` catalog entries
  (`services/api/src/cp2/domains/agent-runtime/model-catalog.ts`).
- `createBackendModelAdapter`, `createBackendModelAdapterRegistry`, `createBackendInferenceClient`,
  `createProviderModelAdapter` (`services/api/src/inference/model-runtime.ts`) - replaced by
  `createVercelModelAdapter` / `createVercelInferenceClient`.
- `resolveOllamaModelName` and the `BACKEND_INFERENCE_*` / `INFERENCE_CLOUD_*` / `OPENAI_*` /
  `INFERENCE_ENGINE` environment variables (`services/api/src/config.ts`).
- The `grogoni-inference` Render Blueprint service, its persistent disk, and every
  `BACKEND_INFERENCE_*` env var on the API service.

## New components

- `services/ai-runtime/src/vercel-handler.ts` - `createVercelInferenceHandler` /
  `createVercelHealthHandler`, the Vercel `fetch`-handler request/response contract (bearer auth,
  manual schema validation, NDJSON streaming), backed by `services/ai-runtime/api/inference.ts` and
  `api/health.ts`.
- `services/ai-runtime/src/artifact-loader.ts` - `downloadVerifiedArtifact`: SSRF-guarded (host
  allowlist, no-redirect fetch), size-capped, sha256/size/format-verified GGUF download with an
  on-disk cache keyed by hash.
- `services/ai-runtime/src/llama-runtime.ts` - `loadLlamaRuntime`, the `node-llama-cpp` (CPU-only)
  wrapper actually running inference.
- `services/ai-runtime/src/runtime-cache.ts` - `RuntimeCache`, a bounded (1-4 entries) LRU cache
  with concurrent-load deduplication, scoped to one warm Vercel instance.
- `services/ai-runtime/src/service-error.ts` - `InferenceServiceError`, typed errors with an HTTP
  status baked in.
- `services/api/src/inference/model-artifact-store.ts` - `createNeonModelArtifactStore`
  (`ModelArtifactStore`): resolves the available artifact row for a model, hand-rolls AWS SigV4
  presigning for Neon's S3-compatible object storage (no AWS SDK dependency), and does a
  path-traversal/bucket-name-hardened `HEAD`-based size verification.
- `services/api/src/inference/model-runtime.ts` additions - `createVercelInferenceClient` (the
  HTTPS + bearer + NDJSON client) and `createVercelModelAdapter` (wraps the client + artifact store
  into the same `ModelRuntimeAdapter` shape every other target already implements).
- `infra/db/migrations/079_vercel_inference_artifacts.sql` - see Schema changes below.

## Schema changes

Migration `079_vercel_inference_artifacts.sql`:

- Creates `cp2_runtime_model_artifacts` (metadata-only: `storage_provider`, `bucket`, `object_key`,
  `format`, `quantization`, `size_bytes`, `sha256`, `content_type`, `status`), with a CHECK
  constraint rejecting path traversal / absolute / backslash object keys, a format regex, a
  sha256-hex regex, and a partial unique index enforcing at most one `status = 'available'` artifact
  per model. GGUF bytes are never stored in Postgres.
- Seeds `builtin:smollm2-360m:q4_0:gguf` as the available artifact for the platform default model,
  and a `builtin:vercel-inference:v1` row in `cp2_native_execution_hosts` (`type: "vercel"`,
  `credentialReference: "env:GROGONI_INFERENCE_SERVICE_TOKEN"`).
- Points `cp2_native_runtime_models` for `smollm2-360m` at `executionTarget: "vercel"` and the new
  artifact, adds a `cp2_native_model_installations` row binding model to host, and repoints the
  default runtime binding's primary role at the Vercel host.
- Marks the old Render-hosted host record and its installations `status: "unavailable"`, so no
  binding can silently fail over to Render-hosted execution - the retirement is explicit in data,
  not just in code.

No destructive drops. The old host/installation rows remain as unavailable historical records,
consistent with this repository's existing migration convention (see migration 065's retirement of
the execution-fabric tables, referenced throughout `native-runtime-deployment.md`).

## Bugs found and fixed during this migration

The adapter/config/DB layers were migrated correctly, but several places in the business-logic
layer still hardcoded the literal `"backend"` as if it were the only live execution target, instead
of consulting `isModelExecutionTarget()` or the platform's configured default. Since production
`PLATFORM_DEFAULT_EXECUTION_TARGET` moved to `"vercel"` and `modelRuntimeAdapterResolver` only ever
registers adapters under `vercel:*` keys, these were live production bugs, not just stale tests:

- `getEffectiveRuntime` (`agent-runtime/store.ts`) hand-enumerated `"backend" | "remote-shop-device"`
  instead of using `isModelExecutionTarget()`, so it never resolved an adapter for a Vercel-executed
  binding - `/businesses/:id/runtime/effective` always reported `ready: false` even when Vercel was
  healthy. Fixed to use the existing type guard.
- `resolveRuntimeModelProvider`'s `eligibleExecutionTargets` was hardcoded to
  `Set(["backend"])` - the one call site gating which targets a real chat turn is even allowed to
  route to. This meant **no chat turn could ever route to Vercel**, regardless of any other fix.
  Fixed to `modelExecutionTargets` minus `"remote-shop-device"`.
- `ensureDefaultRuntimeForTurn`'s zero-setup provisioning bailed out unless
  `platformDefaultRuntime.executionTarget === "backend"`, so a fresh shop's first chat could never
  auto-provision a working Pi + SmolLM + Vercel binding - the exact "Phase 9: Default Runtime"
  requirement. Fixed to compare against the configured default / exclude only
  `remote-shop-device`.
- `validateAgentModelBindingConfiguration` (`agent-runtime/shared.ts`) required
  `executionTarget === "backend"` for hosted-source models and `CLOUD_ONLY` mode, rejecting a
  legitimate `"vercel"` selection. Fixed to reject only `remote-shop-device`.
- `cp2/store.ts`'s `ensureDefaultRuntimeBinding` wrapper was missing the `activeShopId !== null &&`
  tolerance its sibling `resolveNativeRuntimeBinding` check already had, incorrectly rejecting a
  conversation with no explicit shop scope once `ensureDefaultRuntimeForTurn` started actually
  running (previously masked because that function always bailed out early). Fixed to match.
- Three call sites in `apps/web/src/AgentModelPanel.tsx` and `QuickRuntimeSwitcher.tsx` sent
  `executionTarget: "backend"` when a merchant activated or tested a "Grogoni backend" model from the
  UI - this would have made every UI-driven activation fail its own health probe. Fixed to send
  `"vercel"`.

All of the above were caught by re-running the full test suite after the adapter/config layer
changes, not by inspection alone - several tests that hardcoded `"backend"` as their expected
execution target started failing once the routing bugs were fixed, which is what surfaced them.
See `tests/model-activation-runtime.test.ts`, `tests/native-runtime-execution-target-resolution.test.ts`,
`tests/zero-setup-native-runtime.test.ts`, `tests/effective-runtime.test.ts`.

## Migration strategy actually used

1. Land the new Vercel-side service (`services/ai-runtime`) and Render-side adapter/client
   (`model-runtime.ts`, `model-artifact-store.ts`) as pure additions.
2. Wire `index.ts` to register a `createVercelModelAdapter` per enabled catalog model under
   `vercel:${modelId}`, gated on `VERCEL_INFERENCE_URL` being configured.
3. Migrate the database: seed the Vercel host/artifact rows, repoint the default binding, mark the
   old Render host unavailable - all in one migration, no separate backfill step needed since the
   native runtime graph already supported multiple execution targets.
4. Remove the old Render-hosted implementation and its Blueprint declaration.
5. Fix the business-logic call sites that still hardcoded `"backend"` (found via full test-suite
   regression, see above).
6. Rewrite `render.yaml`, `docker-compose.yml`, `.env.example`, the ops scripts
   (`inference-health.mjs`, `inference-probe.mjs`, `verify-production-runtime.mjs`), and
   `scripts/check-render-inference-boundaries.mjs` (which had been asserting the _old_ boundary and
   would have failed Render's own build) to match the new contract.

## Final target flow

```text
Chat client
    -> Render API (services/api) - control plane
        -> authenticate, resolve conversation/business context
        -> resolve agent + model + runtime binding (native runtime graph, unchanged)
        -> resolve execution target: "vercel" (isModelExecutionTarget-driven, generic)
        -> createVercelModelAdapter.generate()
            -> resolve artifact metadata (Neon Postgres, cp2_runtime_model_artifacts)
            -> mint a short-lived signed download URL (Neon object storage, SigV4)
            -> POST https://<vercel-deployment>/v1/inference (bearer token, NDJSON stream)
                -> services/ai-runtime (Vercel serverless function)
                -> download + verify (SSRF-guarded, sha256/size/format) if not cache-hot
                -> load via node-llama-cpp (bounded LRU cache, dedup concurrent loads)
                -> generate, stream delta/result NDJSON events back
        <- normalized completion (ModelRuntimeGenerationResult)
    -> tool execution, persistence, response streamed to client
```

Neon stores. Render routes and coordinates. Vercel executes inference. Agent, model, artifact, and
execution host remain independently swappable: the same `ModelRuntimeAdapter` shape that serves
`vercel:smollm2-360m` today could serve a self-hosted `backend:*` adapter or a different model under
the identical resolver/routing/telemetry path with no chat-code branching.

## Documentation

- [../architecture/inference-runtime.md](../architecture/inference-runtime.md) - ownership boundary,
  runtime contracts, swap flows.
- [../deployment/vercel-inference.md](../deployment/vercel-inference.md) - Vercel deployment runbook.
- [../deployment/render-api.md](../deployment/render-api.md) - Render API deployment/config.
- [../storage/model-artifacts.md](../storage/model-artifacts.md) - Neon artifact storage contract.

## Hardening addendum (2026-09-01)

A follow-up pass found the migration above architecturally correct but not yet deploy-ready, and
verified it with real inference rather than a compiled build:

- **Wrong Vercel Node runtime.** Vercel resolves `engines.node` from the `package.json` at its
  configured Root Directory (`services/ai-runtime`), not the repository root's - that file had no
  `engines` field, so Vercel silently picked its own default instead of the repository's pinned
  `>=22.19.0 <23.0.0`. Fixed by adding the same `engines` field to
  `services/ai-runtime/package.json`.
- **`node-llama-cpp` install script blocked.** pnpm 10 blocks arbitrary `postinstall` scripts by
  default; `node-llama-cpp`'s links the correct prebuilt native binary and never ran. Fixed with
  `onlyBuiltDependencies: [node-llama-cpp]` in `pnpm-workspace.yaml` - the one dependency that
  legitimately needs it, nothing else approved.
- **`/health` and `/ready` made the same claim.** Both rewrote to the same handler
  (`{ok: true, state: "READY"}`) regardless of whether inference could actually run. Split into
  `api/health.ts` (bare liveness, no configuration dependency, cannot fail on misconfiguration) and
  a new `api/ready.ts` / `createVercelReadyHandler` (parses configuration, returns 503 when it's
  invalid, never triggers a download). Neither can know whether `/v1/inference`'s separate function
  has a warm model - documented explicitly rather than faked, consistent with the existing "Render's
  `/health/ai` is the real end-to-end probe" design.
- **Reverse deployment boundary was unchecked.** `scripts/check-render-inference-boundaries.mjs`
  only checked that Render doesn't depend on a local inference engine; nothing checked the other
  direction. Added a dependency-allowlist and import-scan check for `services/ai-runtime` (must
  depend on nothing but `@grogoni/shared-types` and `node-llama-cpp`, must never import
  `services/api`/`apps/web`), plus a standalone `tests/ai-runtime-deployment-boundary.test.ts` that
  asserts the same invariant independently of the script.
- **Wrong artifact size found by actually running inference.** Downloading the real upstream GGUF
  identified by migration 079's own `sha256` (byte-for-byte match) measured its real size as
  `229733280`, not the `230000000` the migration seeded. `downloadVerifiedArtifact` fails closed on
  any size mismatch by design, so the placeholder would have rejected the first real production
  download. Corrected in `infra/db/migrations/080_correct_smollm2_artifact_size.sql`.
- **Live proof, not just a compiled build.** `scripts/ai-runtime-live-inference-probe.mjs`
  (`pnpm inference:live-probe`) runs the real `createVercelInferenceHandler` against a real GGUF
  file and the real `node-llama-cpp` native binding, served from a throwaway local HTTP server. Two
  calls confirm both a cold load (`cacheHit: false`, real generated text) and warm-instance reuse
  (`cacheHit: true`, no re-download/re-load) with the real runtime, not a mock.

### Follow-up: `.node-version` drift and a stuck Vercel project (2026-09-01)

The hardening above fixed every repository-side cause of the wrong-runtime failure, but the
standalone Vercel project still failed with `Unsupported engine ... current: v24.19.0` followed by
`No Output Directory named "public" found`, and kept rebuilding an old commit
(`8671ce0`) after two further commits landed on `main`. Root-caused and fixed:

- **`.node-version` still said `20.19.0`.** `.nvmrc`, both `package.json` `engines.node` fields,
  `render.yaml`, and the CI workflows had all already moved to `22.19.0`; only `.node-version` was
  never updated in the Node 20 → 22 migration (`docs/adr/ADR-default-runtime-pi-smollm.md`). Some
  Vercel build-image detectors read `.node-version` in preference to `.nvmrc` or the `package.json`
  Root Directory `engines` field it depends on, so a stale `.node-version` can override the correct
  value even though the audit above found and fixed every other declaration. Corrected to
  `22.19.0`, and `tests/ai-runtime-deployment-boundary.test.ts` now asserts `.nvmrc`,
  `.node-version`, and both `engines.node` fields all agree, so this cannot drift silently again.
- **Native binding load was never actually proven under Node 22, only TypeScript compilation.**
  Added `services/ai-runtime/src/llama-runtime.native.test.ts`: a fast (~1s) real call to
  `node-llama-cpp`'s `getLlama({ gpu: false })`/`dispose()` - the same init/dispose lifecycle
  `loadLlamaRuntime` performs - with no GGUF file needed, so it runs in the regular gate-test suite
  instead of only the opt-in `pnpm inference:live-probe`.
- **No repository-level guard against a fake `public/` directory.** Added an assertion to
  `tests/ai-runtime-deployment-boundary.test.ts` that `services/ai-runtime/public` never exists and
  `vercel.json` never declares `builds` (the legacy config that would bypass this project's
  `functions`/`rewrites` setup), plus a check that every rewrite destination in `vercel.json`
  resolves to a real handler file - so a future "just add `public/`" workaround for a misconfigured
  Vercel project fails CI instead of shipping.
- **The stale-commit theory was wrong; the Output Directory failure was real and had a real
  cause.** Pushing the fixes above (with Vercel API credentials Julien provided mid-session)
  triggered a genuinely new deployment for the new commit - proving the Vercel↔GitHub Git
  integration was never stuck, and disproving the original hypothesis that `8671ce0` indicated a
  broken production-branch/root-directory link. That new deployment still failed with the exact
  reported error, and reading its real build log (`GET /v13/deployments/{id}` /
  `GET /v3/deployments/{id}/events` against the Vercel API) showed why: the project's Root
  Directory, Framework Preset ("Other"/unset), and production branch were all already correct, but
  **`nodeVersion` was explicitly `"24.x"` in the live project settings** (only the `engines.node`
  field in `package.json` saved the actual runtime - the build log showed Vercel's own warning that
  it was overriding the dashboard's `24.x` with `22.x` because of it), and **no `outputDirectory`
  was set while a `build` script exists in `package.json`** - Vercel's zero-config for a
  no-framework project always runs a package.json `build` script as a _static_ build and requires a
  real output directory afterward (documented at
  [vercel.com/docs/builds/configure-a-build](https://vercel.com/docs/builds/configure-a-build)),
  regardless of the `functions`/`rewrites` config; `api/*.ts` Vercel Functions are compiled directly
  from TypeScript source by `@vercel/node` independently of this step and were never the problem.
  Fixed by setting the live project's `nodeVersion` to `22.x` via the Vercel API, and by declaring
  `installCommand`, `buildCommand`, and `outputDirectory: "dist"` directly in
  `services/ai-runtime/vercel.json` (config as code instead of a dashboard-only setting that can
  drift silently again) - `dist` is `pnpm run build`'s real, already-necessary compiled output, not
  a directory invented to satisfy Vercel, and only exposes compiled JS/type-declarations that are
  already public in this open-source repository, unlike skipping the build step entirely (which
  would serve the whole `services/ai-runtime` root, including `node_modules` and TypeScript source,
  as static files). See [../deployment/vercel-inference.md](../deployment/vercel-inference.md)'s
  "Vercel project settings" table for the corrected values.

See [../deployment/vercel-inference.md](../deployment/vercel-inference.md) for the resulting
dashboard settings, pnpm configuration, and rollout order.
