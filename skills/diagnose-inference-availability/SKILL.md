---
name: diagnose-inference-availability
description: Diagnose Grogoni model-runtime unavailable or unreachable reports without confusing an intentionally unconfigured execution target with a network outage. Use for Grogoni inference health, model test, activation, and deployment-capability incidents.
---

# Diagnose Grogoni inference availability

Treat the API error code and the deployed execution-target contract as the sources of truth. A
catalogue model being downloadable does not mean a backend adapter is configured.

1. Read `docs/architecture/inference-runtime.md` and `docs/deployment/grogoni-openrouter.md` for the
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
9. Check the live deployment through the API itself: grogoni.com's `/api/*` goes to the Supabase
   Edge Function (`vercel.json` rewrite), and hosted models are reached through the configured
   OpenRouter integration. There is no separate inference service to probe. Never expose provider
   credentials or database URLs in output.
10. Add a regression scenario to `tests/ai-eval/backend-runtime-status-scenarios.ts` whenever a new
    runtime error code reaches the UI.

No hosted inference service of Grogoni's own is deployed. `services/ai-runtime` (the old Vercel
inference deployment) and Render (`render.yaml`) are both gone, and the API refuses to boot with
their settings (`VERCEL_INFERENCE_URL`, `GROGONI_INFERENCE_SERVICE_TOKEN` and the rest of
`rejectRemovedCloudConfiguration` in `services/api/src/config.ts`). Hosted models go through the
OpenRouter adapter and model registry; see `docs/deployment/grogoni-openrouter.md`.
`scripts/check-inference-boundaries.mjs` fails the build if `services/api` depends on or imports an
in-process model engine (`node-llama-cpp`, Ollama, ONNX and similar), or if `vercel.json` sets a
retired inference marker, a setting the API rejects, or an inference secret for the browser. Do not
reintroduce a client-first/browser-only inference story; that architecture (WebLLM, Transformers.js,
the native GGUF bridge) was deliberately removed from `apps/web`. The docs under
`docs/inference/webllm-runtime-contract.md`, `native-bridge.md`, `model-manifest.md`,
`grogoni-web-inference-engine.md` and `docs/deployment/vercel-inference.md` describe removed systems
and are historical only; `docs/deployment/render-retirement.md` records where the Render services went.
