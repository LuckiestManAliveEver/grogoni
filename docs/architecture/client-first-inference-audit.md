# Client-first inference audit

> **Superseded.** The client-first inference architecture this audit examines was retired — see
> ADR-device-independent-runtime-and-registry-discovery.md. Kept as historical record.

Date: 2026-07-19

## Executive finding

Grogoni already has two distinct inference implementations:

- a browser-only ONNX runtime built on `@huggingface/transformers`, running in a dedicated
  Web Worker with WebGPU preferred and WASM available; and
- server-side model adapters in `services/ai-runtime` for llama.cpp-compatible HTTP servers,
  Ollama, and OpenAI.

The Render API currently imports the server runtime package and constructs local providers during
process startup. This makes server-side local inference part of the production dependency and
deployment graph even when no model is reachable. The Render Blueprint also exposes
`LOCAL_MODEL_*` configuration and includes `services/ai-runtime/**` in the API build filter.

No llama.cpp binary, GGUF weight, Node native binding, worker thread, or inference subprocess is
checked into this repository. llama.cpp and Ollama are contacted over HTTP. Nevertheless, the API
is the owner of local inference execution today, so an operator must provision an adjacent model
server for those paths to work. That is the architecture that pressures the API deployment toward
more CPU and memory.

## Current inference dependency map

```text
chat / agent request
  -> services/api/src/cp2/routes.ts
  -> Cp2Store in services/api/src/cp2/store.ts
  -> Grogoniclaw runtime in packages/tool-core/src/index.ts
  -> RuntimeModelProvider resolved by services/api/src/index.ts
       -> @grogoni/ai-runtime
          -> services/ai-runtime/src/local-model.ts -> llama.cpp /completion over HTTP
          -> services/ai-runtime/src/ollama-model.ts -> Ollama /api/chat over HTTP
          -> services/ai-runtime/src/openai-model.ts -> OpenAI Responses API

browser chat
  -> apps/web/src/GrogoniApplication.tsx
  -> apps/web/src/browser-inference-session.ts
  -> apps/web/src/browser-model-engine.ts
  -> apps/web/src/workers/browser-model.worker.ts
  -> @huggingface/transformers
       -> WebGPU when detected
       -> ONNX Runtime WASM otherwise
       -> public model files loaded lazily from an approved Hugging Face repository
       -> browser Cache Storage / IndexedDB persistence
```

## Inference packages and entry points

### Shared runtime contracts

- `packages/shared-types/src/index.ts` defines `RuntimeModelProvider`,
  `RuntimeModelPrompt`, completion/diagnostic results, model assignments, and telemetry.
- `packages/tool-core/src/index.ts` owns the agent planning/runtime boundary and accepts the
  provider abstraction. It does not import a model engine.

### Server runtime

- `services/ai-runtime/src/local-model.ts` is the llama.cpp-compatible HTTP adapter. It calls
  `/completion`; it does not bind or spawn llama.cpp.
- `services/ai-runtime/src/ollama-model.ts` calls Ollama `/api/chat` and `/api/tags`.
- `services/ai-runtime/src/openai-model.ts` calls the OpenAI Responses API.
- `services/ai-runtime/src/index.ts` and `app.ts` export all three adapters.
- `services/ai-runtime/src/server.ts` starts a small health-only Fastify service. Render does not
  currently declare this as a separate service.
- `services/api/src/index.ts` is the production inference composition root. It imports all server
  adapters, creates local provider instances, resolves model IDs, and exposes inference
  diagnostics.

### Browser runtime

- `apps/web/src/browser-inference-types.ts` contains browser engine, model, progress, and routing
  types.
- `apps/web/src/browser-inference-capability.ts` feature-detects WebGPU, WASM, Worker, IndexedDB,
  storage, memory when exposed, hardware concurrency, PWA mode, and cross-origin isolation.
- `apps/web/src/browser-model-registry.ts` is the trusted browser model manifest.
- `apps/web/src/browser-model-engine.ts` is the typed Worker client with streaming and
  cancellation.
- `apps/web/src/workers/browser-model.worker.ts` loads `@huggingface/transformers`, selects
  WebGPU/WASM, downloads/loads the model, streams output, and maps safe errors.
- `apps/web/src/browser-inference-session.ts` builds bounded context, selects the current route,
  generates, updates the rolling summary, and records privacy-safe diagnostics.
- `apps/web/src/browser-inference-storage.ts` creates the dedicated
  `grogoni-browser-inference` IndexedDB database. Model-related stores and conversation-related stores
  are distinct.
- `apps/web/src/browser-inference-diagnostics.ts` emits structured local diagnostic events without
  prompt text.
- `apps/web/src/GrogoniApplication.tsx` owns settings/download controls and integrates browser-local
  replies with the existing chat UI.

## llama.cpp execution mode

`services/ai-runtime/src/local-model.ts` uses `fetch` to contact a configured llama.cpp-compatible
HTTP endpoint. There is no `node-llama-cpp` dependency, native addon, `child_process`, worker
thread, checked-in binary, or checked-in model weight. The model computation runs wherever
`LOCAL_MODEL_ENDPOINT` points. The default is loopback, which couples a working production path to
the API host or a colocated service.

The Android-facing `apps/web/src/agent-model-runtime.ts` already treats an unavailable installed
runtime as a safe condition; it does not execute llama.cpp in an ordinary browser.

## Model loading, caching, and selection

- Browser model metadata is kept in `browser-model-registry.ts`; no weight is imported into the
  JavaScript bundle.
- The Worker validates the manifest origin and delegates lazy file loading to Transformers.js.
- Browser Cache Storage uses the Transformers cache; the Grogoni IndexedDB database stores settings,
  model state, download state, summaries, and offline queue records in separate object stores.
- The current registry has one low-tier model, SmolLM2 360M ONNX q4, supporting WebGPU and WASM.
- Server-visible Android/GGUF model catalogue entries are embedded near the bottom of
  `services/api/src/cp2/store.ts`. These are metadata/download links, not downloaded weights.
- Agent model assignment and readiness are handled in `apps/web/src/agent-model-assignment.ts`,
  `apps/web/src/agent-model-runtime.ts`, `apps/web/src/ai-model-manager.ts`, and the CP2 store.

## Chat and agent flow

The browser attempts bounded local chat through `runBrowserChatInference`. Requests requiring an
authorized mutation tool, complex reasoning, an inactive page, an unsupported device, or an
unready model go to the existing API/agent runtime. The API passes a `RuntimeModelProvider` into
the CP2 store; the tool runtime asks that provider for a plan and falls back to deterministic
parsing when it is unavailable.

The existing browser generation request already has a stable request ID, token streaming,
cancellation, a single generation result, context limits, safe user errors, and privacy-preserving
timings. The old router only distinguishes `browser-local`, `native`, and `server`, so it cannot
express owner-node and explicitly consented cloud fallbacks independently.

## Realtime and worker processes

- `services/api` registers authenticated WebSocket routes in the CP2 routing layer for realtime
  synchronization and messaging.
- `apps/web/src/sync/realtime-client.ts` is the browser realtime client.
- Background API runners handle notifications and account deletion. They are not inference
  workers.
- `services/receipt-ocr-service` is a separate Python OCR worker and is unrelated to LLM
  inference.
- No Redis client is currently installed in the API despite `REDIS_URL` being part of shared
  configuration. Owner-node presence therefore needs an in-process ephemeral implementation
  first, with a Redis adapter required before multi-instance production enablement.

## Render deployment audit

`render.yaml` currently configures:

- API build: install the whole workspace, build `@grogoni/api...` (including dependencies), then run
  `check:production-imports`.
- API start: migrate PostgreSQL, then start `@grogoni/api`.
- API build filter: includes `services/ai-runtime/**`.
- API environment: includes `LOCAL_MODEL_ENABLED`, provider, endpoint, model, and timeout plus
  OpenAI variables.
- Static web builds: build `@grogoni/web...`; staging enables browser-local inference.
- There is no llama.cpp Dockerfile or Render inference worker.

The production import check only rejects source-path imports. It does not reject server-local or
browser inference packages in the API output.

## Native and paid-service pressure

There are no native llama dependencies in `package.json` or `pnpm-lock.yaml`. The pressure to use
a paid service is operational rather than a native install failure: the API owns provider
construction and defaults the configured endpoint to loopback, so working local inference
requires compute colocated with or reachable from Render. Model memory/CPU should instead belong
to the browser, installed app, or owner device.

## Server endpoints that can perform inference

- Agent/chat routes in `services/api/src/cp2/routes.ts` eventually invoke the CP2 runtime model
  provider.
- AI health/diagnostic routes can request a real diagnostic inference via the callback assembled
  in `services/api/src/index.ts`.

The refactor must keep ordinary health checks lightweight and remove all local provider resolution
from the API process. A backend cloud provider may remain only behind disabled-by-default policy,
server-only credentials, allow-listing, and explicit consent.

## Exact files to change

Required production changes:

- `packages/shared-types/src/index.ts`: provider-neutral inference contracts, capability/route
  metadata, owner-node protocol types.
- `apps/web/src/browser-inference-types.ts`: align browser descriptors with shared runtimes.
- `apps/web/src/browser-inference-capability.ts`: normalized capability detector inputs.
- `apps/web/src/browser-model-registry.ts`: manifest version/integrity/runtime metadata.
- `apps/web/src/browser-inference-storage.ts`: cache inventory/version/eviction helpers.
- `apps/web/src/browser-inference-session.ts`: provider adapters and deterministic orchestration.
- new `apps/web/src/inference/*`: provider-neutral router, adapters, bridge, error mapping, flags,
  and privacy-safe metrics.
- `services/api/src/index.ts`: remove local provider construction; compose only optional secure
  cloud routing and owner-node coordination.
- new `services/api/src/inference/*`: backend cloud proxy policy and ephemeral owner-node broker.
- `services/api/src/config.ts`: client-first/cloud/owner feature flags.
- `services/api/src/cp2/routes.ts` and `services/api/src/app.ts`: authenticated owner-node protocol
  and lightweight inference metadata endpoints where the existing routing boundary permits.
- `services/api/package.json`: remove the local runtime package from Render dependencies.
- `render.yaml`: remove local inference variables/package filter and run the inference boundary
  check.
- `scripts/check-render-inference-boundaries.mjs` and root `package.json`: fail builds that
  reintroduce local/browser inference into the Render API.
- `.env.example`: safe disabled-by-default flags; local runtime settings become app/node-only.

Required tests and documentation:

- new focused tests under `tests/` for unified routing, providers, cache metadata, cloud policy,
  owner-node isolation, and Render boundaries.
- `docs/architecture/client-first-inference.md`
- `docs/deployment/render-without-inference.md`
- `docs/inference/native-bridge.md`
- `docs/inference/owner-node.md`
- `docs/inference/model-manifest.md`

## Risks identified before implementation

- Existing `RuntimeModelProvider` is planning-oriented rather than token-stream-oriented; it must
  remain compatible while the new chat provider contract is introduced.
- Owner-node presence held only in memory is safe for a single process but cannot support Render
  horizontal scaling. The feature must remain off until a shared ephemeral adapter is configured.
- Current model downloads are delegated to Transformers.js Cache Storage, so byte-level SHA-256
  verification is not exposed by the engine. The manifest can enforce trusted origins and record
  hashes, but verified custom downloads require a staged loader change.
- Chat UI code is concentrated in a very large component. Integration should stay behind the
  existing session boundary to avoid unrelated UI churn.
