# Browser model troubleshooting

> **Retired.** Browser-local model inference was retired — see
> ADR-device-independent-runtime-and-registry-discovery.md. `scripts/benchmark-browser-inference.mjs`
> and the `pnpm benchmark:browser-inference` command this runbook references no longer exist. Kept
> as historical record; do not use this to troubleshoot a current deployment.

## Supported baseline

- Current Chromium-based browser with WebGPU, or WebAssembly for the conservative fallback.
- IndexedDB, Web Workers and at least 225 MB available browser storage.
- Sufficient storage and working memory for the selected profile shown in Agent settings.
- `VITE_BROWSER_LOCAL_INFERENCE_ENABLED=true` in the frontend build.

WebGPU support and mobile memory reporting vary. An unsupported device must continue on Grogoni's
native or Cloud route.

## Diagnosis

1. Open **Agent model → Browser-local inference** and record the browser, backend, device tier and
   safe status/error code.
2. Confirm the deployment flag was present when Vite built the frontend.
3. Confirm IndexedDB and Workers are allowed and browser storage has not been disabled.
4. Inspect browser network requests to the approved `huggingface.co/onnx-community/` or
   `huggingface.co/mlc-ai/` namespace and verify no credential is attached. WebLLM also loads its
   pinned library from `raw.githubusercontent.com`.
5. Check worker errors for the typed code only. Do not add raw prompts or output to logs.
6. For a corrupt or interrupted cache, use **Delete browser model**, then explicitly opt in again.
7. For `OUT_OF_MEMORY`, close other tabs, retry on WebGPU, or leave browser inference disabled.
8. For `CONTEXT_LIMIT_EXCEEDED` or a server-tool request, confirm the compact status changes to
   Cloud and that the original user message remains present.
9. In staging, run `pnpm benchmark:browser-inference -- --profile=pixel-5
--backends=webgpu,wasm`. The staging query override is intentionally unavailable in production.

For an OPFS GGUF installation, inspect the structured `model_activation` record and identify the
last completed phase. `MODEL_FILE_MISSING`/`MODEL_CORRUPT` is an artifact failure;
`INFERENCE_TIMEOUT`, `INSUFFICIENT_MEMORY`, or `MODEL_LOAD_FAILED` is a worker/runtime failure;
`MODEL_READINESS_MISMATCH` means the engine loaded but the deterministic health inference failed.
After 120 seconds at most, the UI must show **Retry activation**. If it does not, treat that as a
regression in the activation coordinator rather than retrying downloads blindly.

## Clear model data

**Delete browser model** unloads the worker and clears engine model cache plus Grogoni model metadata.
It intentionally leaves chat history and the normal Grogoni sync database unchanged. Signing out
terminates generation and removes account-scoped settings, summaries, and offline inference queue
records.

## Add a model

Add only one reviewed descriptor at a time to `browser-model-registry.ts`. Require:

- HTTPS under an approved model origin;
- Transformers.js-compatible ONNX assets or a WebLLM model present in the pinned package catalogue;
- immutable weight and, for WebLLM, model-library revisions;
- verified commercial licence and licence URL;
- q4/q8 size and runtime-memory measurements;
- context limit, backend and device-tier metadata;
- capability, worker, context, routing and production-build tests.

Never enable or download a newly added model by default.

## Known limitations

- WASM generation on low-end Android may be too slow for comfortable chat.
- Browser quota eviction can remove model assets between sessions.
- Cancellation may wait for the current WebGPU/WASM kernel to return.
- The initial 360M model is for short assistance, not complex reasoning or authorized tools.
- Stable prefix keys are implemented, but evaluated KV caches are only reused when the active engine
  session supports it; they are not persisted across reloads.
