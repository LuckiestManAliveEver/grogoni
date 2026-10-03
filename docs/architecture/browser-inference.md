# Browser inference architecture

> **Superseded.** Private in-browser model execution (`browser-local`) was retired in favor of a
> device-independent hosted runtime — see ADR-device-independent-runtime-and-registry-discovery.md.
> `ModelExecutionTarget` no longer includes `browser-local`; the files this document describes
> (`apps/web/src/browser-inference-*.ts`, `browser-model-registry.ts`, `browser-gguf-runtime.ts`)
> have been removed. Kept as historical record of the architecture that predated that decision.

## Runtime path

```text
ChatSurface
  → OwnerApp route resolution
  → browser-inference-session
  → capability + settings + context budget
  → BrowserModelEngine
  → browser-model.worker → Transformers.js → ONNX Runtime Web (WebGPU or WASM)
    or
  → webllm-model.worker → WebLLM/MLC (WebGPU)
  → streamed tokens in the existing agent message
```

Only one page-session worker and one generation may be active. The browser route is evaluated
before a server agent request is issued, so Grogoni never sends the same turn to browser and cloud
simultaneously. Native GGUF and server routing remain in the existing `AgentModelRuntime` and CP2
paths.

## Engine boundary

Only the dedicated runtime adapters import `@huggingface/transformers` or `@mlc-ai/web-llm`. The
rest of Grogoni uses `BrowserModelEngine`, versioned runtime/checkpoint contracts, typed generation
requests, progress handlers, and error codes. The adapters:

- validates the model against Grogoni's approved Hugging Face origin;
- use approved q4 ONNX or q4f16_1 MLC profiles and the declared backend;
- owns tokenizer, live generation state and in-session caches;
- streams decoded token text;
- uses an interruptible stopping criterion for cancellation;
- reports timing and counts without prompt text.

The selected engine and model are Apache-2.0. Dependency and model upgrades require licence,
bundle, model-card and browser-compatibility review.

## Context and retrieval

`browser-context-manager.ts` preserves protected system instructions, the current user message, and
agent/shop identity. It adds complete optional records in priority order until the model budget is
full, then rechecks the assembled prompt with the loaded model tokenizer and drops additional whole
low-priority records if necessary. The stable prefix receives a deterministic cache key. The
initial adapter does not claim durable KV-cache persistence; reload reconstructs context from
messages, summaries and structured state.

Catalogue retrieval is bounded lexical matching over current structured product records. Intent
matching chooses only relevant Grogoni context scripts. Write operations, server tools, complex
reasoning and background work route to the authenticated server.

## Persistence and offline behavior

`grogoni-browser-inference` is a versioned IndexedDB database with account-scoped settings, model
metadata, summaries, chat cache, retrieval metadata and offline queue stores. Transformers.js and
WebLLM own their binary asset caches, avoiding an extra model copy. The application service worker
does not run inference and does not delete inference storage during shell upgrades.

Logout terminates the worker and clears account-scoped inference records. Model cache deletion is
an explicit settings action and does not delete chat data.

## Deployment

Set `VITE_BROWSER_LOCAL_INFERENCE_ENABLED=true` at frontend build time to expose the opt-in
control. The production and staging Blueprints enable it, while every user must still explicitly
select and download a profile. Both deployments add a strict CSP plus
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`,
allowing memory measurements and threaded WASM without changing production authentication or
integrations.

The staging CSP permits only same-origin application assets and workers, the configured Grogoni API,
and HTTPS downloads under the Hugging Face `huggingface.co`/`hf.co` host families. It also permits
the exact `raw.githubusercontent.com` origin used by pinned WebLLM model libraries. Hub downloads
redirect to separate CDN/storage subdomains. Staging may force the WASM route with
`?browserInferenceBackend=wasm`; production ignores this diagnostic override.
