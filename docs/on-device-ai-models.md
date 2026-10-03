# On-device AI models

The Grogoni agent model library exposes five llama.cpp-compatible GGUF models that are small enough
for Android-class hardware. Each upstream repository identifies its license as Apache-2.0, which
permits commercial use subject to the license's notice and attribution terms.

| Grogoni model     | Hugging Face source                        | Quantization | Download | Device profile |
| -------------- | ------------------------------------------ | ------------ | -------: | -------------- |
| SmolLM2 360M   | `HuggingFaceTB/SmolLM2-360M-Instruct-GGUF` | Q8_0         |   386 MB | 2 GB+ RAM      |
| TinyLlama 1.1B | `TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF`   | Q3_K_M       |   551 MB | 3 GB+ RAM      |
| TinyLlama 1.1B | `TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF`   | Q4_K_M       |   669 MB | 4 GB+ RAM      |
| Qwen2.5 0.5B   | `Qwen/Qwen2.5-0.5B-Instruct-GGUF`          | Q4_K_M       |   491 MB | 3 GB+ RAM      |
| Qwen2.5 1.5B   | `Qwen/Qwen2.5-1.5B-Instruct-GGUF`          | Q4_K_M       |  1.12 GB | 6 GB+ RAM      |

Model files are streamed to the browser's origin-private file system. The download manager checks
for working storage, requests persistent storage, reports progress, and removes partial files after
a failed transfer. After a successful online install, the browser uploads the GGUF through
authenticated 4 MiB chunks to the account's existing Neon/Postgres database. Neon keeps one ready
copy per account user and model; superseded and incomplete copies are removed. Local inference
still runs only from a device-private copy, never directly from the database.

The agent AI model dropdown separates models that are installed on the current phone from catalog
models that still require a download. A catalog model cannot be activated until its GGUF weights
are present in private device storage. Completing a download installs and selects that model in
the library; the merchant then saves the agent settings.

Browser storage is not itself an inference runtime. The PWA does not execute a GGUF file directly
from OPFS; GGUF inference still requires the Android `GrogoniAgentModelRuntime` bridge or a configured
llama.cpp-compatible server.

An optional browser-local backend uses approved Transformers.js/ONNX and WebLLM/MLC profiles. The
Transformers.js adapter uses WebGPU when available and a conservative WASM fallback. WebLLM runs
only through WebGPU in its own dedicated worker. This backend is disabled by default with
`VITE_BROWSER_LOCAL_INFERENCE_ENABLED`, requires an explicit per-user download action, and shares
the existing Grogoni agent/chat router rather than treating a cached model as active.

The browser engine now exposes a reviewed multi-model profile registry. SmolLM2 135M is the
low-memory default, SmolLM2 360M remains the balanced option, and Qwen2.5 0.5B is restricted to
high-tier WebGPU profiles. Each combination must pass a tokenizer/allocation/readiness
generation before it is marked ready. See
[`docs/inference/grogoni-web-inference-engine.md`](inference/grogoni-web-inference-engine.md) for model
admission, resource budgets, device outcome history, and logical checkpoint behavior.

Compatible WebGPU devices prefer the pinned WebLLM profiles. Their immutable weight/library
mapping and cross-adapter task-state contract are documented in
[`docs/inference/webllm-runtime-contract.md`](inference/webllm-runtime-contract.md). WebLLM does
not make raw KV state portable and is never used on WASM-only devices.

SmolLM2 360M and Qwen2.5 0.5B are also embedded as catalog metadata in the web client, so a
temporary API/catalog outage does not make the default choices disappear. The “Install offline
starter” action ranks those defaults against the reported device capability and performs the
one-time download with visible progress.

The web/PWA build does not silently bundle these large weight files or download them without the
merchant's action. In the interface, “installed on this phone” means the merchant has completed the
predownload into origin-private storage on that Android device. “Available from your account” means
an authenticated Neon copy can be restored to another signed-in device.

The Android model library searches both the curated Grogoni registry and public GitHub releases:

- `/v1/ai-models?search=...` searches the curated registry.
- `/v1/ai-models/github?search=...` searches GitHub repositories and published release assets.

GitHub discovery accepts only repositories that GitHub identifies as Apache-2.0 and release assets
that are uploaded `.gguf` files between 50 MB and 2 GB. Download URLs must be HTTPS links under the
same repository's GitHub Releases path. Draft releases, prereleases, oversized files, non-GGUF
assets, and repositories without an allowlisted license are excluded. Results are cached for 15
minutes. Set `GITHUB_TOKEN` on the API to increase GitHub API rate limits; public discovery still
works without a token subject to GitHub's anonymous limits.

The API reports whether discovery is using the authenticated or public GitHub REST API. An empty
`GITHUB_TOKEN` is treated as public access rather than sending an invalid authorization header.
Render declares `GITHUB_TOKEN` as a secret environment value for the API service.

The “Built-in and hosted” selector also exposes the configured llama.cpp runtime. A loopback
`LOCAL_MODEL_ENDPOINT` is labeled built-in; a remote endpoint is labeled hosted. The option is
enabled only when `LOCAL_MODEL_ENABLED=true`, so it never advertises an unavailable runtime.

Hosted OpenAI profiles are enabled when the API has `OPENAI_API_KEY`. They are processed through
the OpenAI Responses API and can be configured with `OPENAI_FAST_MODEL` and
`OPENAI_REASONING_MODEL`. OpenAI has no implicit default. Like any hosted provider model, it is
selected by model identity and runs through the provider-neutral `backend` target. The separate
hosted-fallback selector stores a model ID, not a vendor choice, and never detaches, replaces, or
rewrites the downloaded model assignment.

## Device-switch and resource fallback

A runnable installation still belongs to one device; selecting it must not imply that its GGUF is
already present on another phone. The other phone can restore the account's Neon copy from the
model library, after which Grogoni validates and registers a new device-scoped installation. Until
then, the API marks the local installation missing. It never runs GGUF inference inside Neon,
converts the assignment into `CLOUD_ONLY`, or selects an OpenAI model from environment defaults.

If the merchant selected a hosted fallback model, a new device can display a separate consent
prompt before any chat context is sent to it. Declining preserves the downloaded-model preference.
Accepting stores consent only for that account and shop on the current device. Any fallback is an
explicit model binding; the runtime never chooses a vendor because a local target failed.

If the explicitly selected hosted model's provider is unavailable, the local assignment remains
unchanged and the generic provider error is surfaced. API keys remain server-only; users never
enter or handle provider keys. Provider-specific token budgets, timeouts, retry limits, and circuit
breakers still apply inside adapters.

The phone ranks compatible Hugging Face and GitHub candidates using reported RAM, free private
storage, model size, useful capabilities, and catalog recommendations. An install remains a
merchant-initiated action. Before a downloaded file is retained, the browser checks the GGUF magic
header and rejects a transfer that grows materially beyond the size reported by the catalog.

Custom model import is enabled only when the browser reports at least 6 GB RAM, 6 logical CPU
threads, and 2 GB free origin storage. If Android does not report RAM, 8 logical CPU threads plus
the storage threshold are required. Imports must use GGUF files with a valid `GGUF` header, and the
merchant must affirm that the model's license permits their commercial use.

License metadata is a product safeguard, not legal advice. Recheck an upstream model card and
license before shipping a model as part of a separately distributed application bundle.
