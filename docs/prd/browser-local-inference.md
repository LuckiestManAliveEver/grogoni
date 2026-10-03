# Browser-local inference PRD

> **Retired.** This PRD's feature was built and later retired — see
> ADR-device-independent-runtime-and-registry-discovery.md. `ModelExecutionTarget` no longer
> includes `browser-local`; do not use this document to plan new work. Kept as historical record.

## Current architecture

Grogoni's PWA is a React 19 application built by Vite. `OwnerApp` owns the current account, business,
chat, agent-profile, catalogue, and offline state through React state and refs; there is no global
state library. The single `ChatSurface` sends customer messages through `/v1/messages` and agent
turns through the CP2 runtime. The server chooses the configured llama.cpp, Ollama, or OpenAI
provider and preserves permission checks and tool execution on the backend.

The existing on-device model work has two layers:

- `ai-model-manager.ts` validates and stores GGUF files in OPFS and maintains a canonical
  device-scoped installation registry.
- `agent-model-runtime.ts` exposes Grogoni's runtime interface and currently calls an optional
  Android-injected `GrogoniAgentModelRuntime` bridge.

The PWA already has a versioned IndexedDB sync repository for account-scoped records and queued
mutations. The application service worker caches the app shell and notifications; it does not run
continuous application logic. Chat messages have an existing local outbox. Browser-local inference
must extend these boundaries and must not introduce a second chat or agent.

## Proposed architecture

The existing chat resolver will choose exactly one route for each turn: browser-local, native local,
or server. Browser inference is owned by a single page-session controller. The controller talks to
a dedicated worker through a typed protocol and hides the third-party engine behind Grogoni's
`BrowserModelEngine` interface. The worker owns the tokenizer, generation pipeline, and live
generation state.

A deterministic Grogoni context manager builds bounded chat input from the protected system prefix,
agent and shop identity, recent messages, a separately persisted rolling summary, relevant context
scripts, and lexical catalogue retrieval. Required instructions and the latest user message are
never dropped. The model is never treated as authoritative application state and cannot execute
tools directly.

A separate versioned `grogoni-browser-inference` IndexedDB database stores account-scoped model
metadata, download state, summaries, local chat cache, retrieval metadata, offline inference queue,
and per-user settings. Model bytes remain in the engine-managed browser cache; IndexedDB records
their approved model ID, state, and expected size without copying a large asset. Service-worker
upgrades do not clear this database or the engine cache.

## Selected engine

The primary engine is `@huggingface/transformers` (Transformers.js), backed by ONNX Runtime Web.
It was selected because it:

- supports text generation, token streaming, tokenizers and chat templates;
- runs in a dedicated Web Worker;
- supports quantized models with WebGPU and a WASM/CPU fallback;
- uses the commercially permissible Apache-2.0 license;
- packages with Vite and does not require an API key;
- exposes model-loading progress and bounded generation controls.

Grogoni code outside the worker must not import Transformers.js. This contains supply-chain and API
change risk at one replaceable adapter boundary. The initial model is
`onnx-community/SmolLM2-360M-Instruct-ONNX`, derived from Apache-2.0
`HuggingFaceTB/SmolLM2-360M-Instruct`, loaded at q4 and limited to a conservative 2,048-token Grogoni
context even though the model advertises a larger window.

WebLLM was not selected because this phase requires a usable WASM fallback as well as WebGPU.
Using raw ONNX Runtime Web would require Grogoni to independently maintain tokenizer, chat-template,
streaming, and generation-loop behavior already supplied by Transformers.js.

## Security and privacy

- The deployment flag is disabled by default and each user must explicitly opt in and download.
- Only HTTPS model repositories on the allowlist may reach the worker.
- No access token, cookie, API credential, or backend secret is sent to the worker.
- Prompt and output text are excluded from telemetry.
- Worker output is untrusted. Only validated chat replies are displayed; server-required actions
  continue through authenticated server routes.
- IndexedDB keys contain the authenticated user and tenant namespace. Logout terminates the worker,
  clears in-memory prompts, and deletes account-scoped summaries, queues, and settings.
- Catalogue values in prompts are retrieved from Grogoni's current structured state and remain
  non-authoritative model context.
- Browser inference never weakens backend authorization or confirmation rules.

## Storage implications

The q4 model is a large explicit download and may consume hundreds of megabytes. Grogoni shows the
approximate transfer and runtime-memory costs before consent, reports quota, handles quota errors,
and supports deleting model cache metadata without deleting chat summaries. Persistent storage is
requested only after the user chooses to download and is accompanied by an explanation.

The engine may use Cache Storage for model files. Grogoni does not duplicate the binary in OPFS or
IndexedDB. IndexedDB schema upgrades preserve valid account data and service-worker activation does
not delete inference storage.

## Device compatibility strategy

Capability detection checks WebGPU, WebAssembly, IndexedDB, storage estimates, persistent-storage
state, installed-PWA display mode, browser family, logical processors, reported device memory,
cross-origin isolation, and whether a worker can initialize. Unknown or weak devices receive
conservative limits. WebGPU is preferred; WASM is allowed only for the small starter model and
devices with sufficient storage and compute. Any failed signal safely selects the server route.

Low-tier devices use at most 1,024 context tokens and 96 output tokens. Medium and high tiers use at
most 2,048 context tokens and 160 output tokens for the initial model.

## Routing and fallback

Browser-local is selected only when the deployment flag and user preference are enabled, a model is
downloaded and loaded, the device is supported, the bounded context fits, the page is active, and
the request needs no server-only tool. The existing native assignment remains the next local route.
All other requests use the existing server path.

Each routing decision has a reason code. Local failure falls back only when online and allowed by
the user's existing fallback policy. The compact chat status identifies On-device or Cloud and
includes a safe fallback reason. No request is sent to two models simultaneously.

Offline, supported chat and lexical catalogue retrieval run locally. Server-required actions are
placed in the existing outbox and are never reported as successful. Without a ready local model,
the user's message remains queued until reconnection.

## Context management

The stable prefix contains core Grogoni rules, privacy rules, and agent/shop identity and has a
deterministic cache key. The dynamic suffix contains the current message, bounded recent history,
intent-selected context scripts, lexical catalogue results, retrieved memory, and a rolling
summary.

The token controller uses the engine tokenizer when available. Until then it uses a conservative
word-and-punctuation estimate and marks the result estimated. It preserves system/security rules
and the latest user message, then drops complete low-priority sources in this order: tools, summary,
memory, catalogue, context scripts, oldest recent messages. It never presents a character count as
an exact token count.

Rolling summaries are stored separately from raw history, update after a defined threshold, retain
facts and pending actions with source IDs, and never replace structured Grogoni state. Phase-one
summary extraction is deterministic; local model summarization can replace only the prose field
later while retaining the structured facts.

## Rollout phases

1. Contracts, capability service, registry, routing, feature flag and tests.
2. Worker-based Transformers.js generation, streaming, cancellation and safe server fallback.
3. Deterministic context budgets, stable prefix, intent scripts, catalogue retrieval and summaries.
4. IndexedDB persistence, explicit model controls, offline reconstruction and account isolation.
5. Browser/device performance testing, memory hardening, security review and controlled production
   enablement.

The implementation remains disabled until `VITE_BROWSER_LOCAL_INFERENCE_ENABLED=true` and a user
opts in. The flag does not trigger a download.

## Risks

- WebGPU support and driver stability vary, especially on mobile; WASM generation may be slow.
- Model-cache behavior and quota eviction differ by browser.
- A 360M model is useful for short assistance but is not a replacement for the server runtime's
  reasoning and tool execution.
- Worker termination is the reliable hard-cancellation fallback; some engine operations cannot
  interrupt inside a single WASM kernel.
- Third-party model hosting availability and cache semantics can change.
- Cross-origin isolation improves WASM threading but can break unrelated integrations. It is not
  required for initial single-thread fallback and is therefore not forced in this rollout.

## Test plan

Unit tests cover capability tiers, token allocation and source priority, summary thresholds, cache
keys, routing decisions, worker protocol validation, error normalization, action validation, schema
upgrades and account isolation. Integration-style engine tests mock only the heavy worker boundary
and cover WebGPU, WASM, progress, tokenization, cancellation, and worker termination. Routing,
unsupported-device, context-limit, cache-error, offline-queue, account-switching, reload, and
service-worker behavior are exercised at their deterministic module or repository boundaries.

Repository gates are formatting, lint, typecheck, Vitest, production build, package-boundary checks
and production-import checks. Manual browser testing covers a real model download and generation
plus mobile memory pressure and cache interruption because CI must not download
multi-hundred-megabyte assets.

## Acceptance criteria

- Browser inference remains disabled by default and never downloads without consent.
- A supported browser can download/load the starter model in a worker and stream into the existing
  chat.
- Generation is cancellable and never blocks the main UI.
- Context always stays within the selected model's budget and does not blindly include full history.
- Account-scoped summaries, settings and queue data survive reload without leaking across accounts.
- Unsupported devices and local failures safely retain the existing native/server paths.
- Offline local chat works for supported conversational requests; server actions remain queued.
- Model output cannot bypass schema validation, authorization or server confirmations.
- Service-worker upgrades preserve browser inference data.
- Formatting, lint, typecheck, tests and production build pass.
