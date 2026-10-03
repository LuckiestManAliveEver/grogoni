---
name: diagnose-inference-availability
description: Diagnose Grogoni model-runtime unavailable or unreachable reports without confusing an intentionally unconfigured execution target with a network outage. Use for Grogoni inference health, model test, activation, and deployment-capability incidents.
---

# Diagnose Grogoni inference availability

Treat the API error code and the deployed execution-target contract as the sources of truth. A
catalogue model being downloadable does not mean a backend adapter is configured.

1. Read `docs/architecture/inference-runtime.md` and `docs/deployment/vercel-inference.md` for the
   current architecture, plus the active deployment manifest.
2. Locate the exact user-facing message and the request that produced it.
3. Capture the API error code before interpreting the failure.
4. Query `/health/ready` (database + inference readiness) and `/health/ai` (a real inference call
   through the resolved default adapter) independently.
5. Check whether `VERCEL_INFERENCE_URL`, `GROGONI_INFERENCE_SERVICE_TOKEN`, and the
   `NEON_MODEL_STORAGE_*` credentials are configured on the API side, and that
   `GROGONI_INFERENCE_SERVICE_TOKEN` matches on the Vercel side.
6. Confirm whether the model catalogue advertises `runtimeAvailability.backend` for the requested
   model (the field key is `backend` for historical/frontend-contract reasons even though the live
   target is `vercel` - see `services/api/src/cp2/domains/agent-runtime/store.ts`'s
   `listAiModels()`).
7. Classify `RUNTIME_NOT_CONFIGURED` as unconfigured and `INFERENCE_DISABLED` as disabled. Keep
   `RUNTIME_UNAVAILABLE` neutral because it can represent a configured runtime failure.
8. Reserve unreachable wording for `INFERENCE_SERVICE_UNREACHABLE`; report timeout,
   authentication, artifact-download, model-loading, and response errors separately - Vercel's
   `InferenceServiceError` codes (`services/ai-runtime/src/service-error.ts`) round-trip to Render's
   `ModelRuntimeError` verbatim over the NDJSON `{type: "error"}` event.
9. Use `pnpm inference:health` (Vercel deployment liveness, no token needed) and `pnpm inference:probe`
   (a real end-to-end call through Render's `/health/ai`) to check the live deployment. Never expose
   `GROGONI_INFERENCE_SERVICE_TOKEN` or the Neon storage credentials in output.
10. Add a regression scenario to `tests/ai-eval/backend-runtime-status-scenarios.ts` whenever a new
    runtime error code reaches the UI.

Production runs inference on Vercel (`services/ai-runtime`, deployed independently of Render - see
`docs/deployment/vercel-inference.md`), not a Render-hosted service. `render.yaml` no longer
declares any inference `pserv`; `scripts/check-render-inference-boundaries.mjs` now enforces the
_opposite_ of what it used to - it fails the build if `render.yaml` ever reintroduces a
`grogoni-inference` private service, `BACKEND_INFERENCE_*` env vars, or an `node-llama-cpp`
dependency in `services/api`, and requires `VERCEL_INFERENCE_URL`/`GROGONI_INFERENCE_SERVICE_TOKEN` on
the API service instead. Do not remove or bypass the Vercel deployment, and do not reintroduce a
client-first/browser-only inference story; that architecture (WebLLM, Transformers.js, the native
GGUF bridge) was deliberately removed from `apps/web` in favor of the hosted-first Pi + SmolLM 360M
default. The docs under `docs/inference/webllm-runtime-contract.md`, `native-bridge.md`,
`model-manifest.md`, and `grogoni-web-inference-engine.md` describe that removed system and are
historical only, as are `docs/deployment/backend-inference-render.md` (the retired Render-hosted
Ollama runbook, now a pointer to `vercel-inference.md`).
