# CP11 Local Model Setup

CP11 supports a llama.cpp-compatible local model adapter behind the CP10 runtime contract.

The browser model library can predownload curated GGUF weights into Android origin-private storage.
API operators still place the model served by their llama.cpp endpoint outside this repository.
The browser download is storage preparation only; the current PWA does not execute the GGUF file
itself.

## Android 2GB Profile

Use a predownloaded small open-source GGUF model outside this repository. The
default Grogoni local profile is:

```text
tinyllama-1.1b-chat-q4-k-m-android
```

Recommended artifact shape:

```text
TinyLlama-1.1B-Chat-v1.0 Q4_K_M GGUF
```

This profile is intended for constrained Android devices around 2GB RAM. Keep
context and output short so the operating system, app shell, llama.cpp runtime,
and model weights can coexist.

Suggested llama.cpp server flags:

```bash
llama-server \
  --model /path/to/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf \
  --host 127.0.0.1 \
  --port 8080 \
  --ctx-size 1024 \
  --threads 2
```

For local development, the recommended path is the self-contained `ai-runtime` gateway (Ollama plus
the authenticated `@grogoni/ai-runtime` service in one container), not a bare `ollama serve`. Start it
alongside the rest of local dev infra:

```bash
docker compose up -d ai-runtime
```

This builds `services/ai-runtime/Dockerfile` (the same image production runs as the private
`grogoni-inference` Render service), pulls the configured model into a persistent Docker
volume on first boot, and serves it on `http://127.0.0.1:4002`. `.env.example` already points
`BACKEND_INFERENCE_*` at that gateway with the default `smollm2-360m` model - `pnpm dev`/`pnpm
dev:api` load `.env` automatically (via `--env-file-if-exists`), so no other setup is needed.
To swap the active model, either activate a different enabled canonical model for an agent
through the existing model-activation API/UI (`services/api/src/cp2/domains/agent-runtime`), or
change `BACKEND_INFERENCE_MODEL_ID`/`GROGONI_PRIMARY_MODEL_ID` and `GROGONI_PRIMARY_PROVIDER_MODEL_ID`
to another entry in `runtimeModels` (`packages/shared-types/src/index.ts`) and pull it into the
running container: `docker compose exec ai-runtime ollama pull <providerModelId>`.

`GET /health/ready` on the API (`services/api`) checks reachability and model installation without
running inference; the gateway's own `GET /health/ready` additionally reports installed/available
status per canonical model. See [render-inference.md](../docs/deployment/render-inference.md) and
[runtime-resolution.md](../docs/architecture/runtime-resolution.md) for the full architecture; the
`LOCAL_MODEL_*` env vars and the standalone `ollama serve` flow shown in older revisions of this
document no longer exist in the current codebase.

## Alternative llama.cpp Server

Run a llama.cpp-compatible HTTP server that exposes `/completion`.

Example shape:

```bash
llama-server --model /path/to/model.gguf --host 127.0.0.1 --port 8080
```

Then configure the runtime adapter with:

```text
LOCAL_MODEL_ENABLED=true
LOCAL_MODEL_PROVIDER=llama.cpp
LOCAL_MODEL_ENDPOINT=http://127.0.0.1:8080
LOCAL_MODEL_PROFILE=/path/to/model.gguf
LOCAL_MODEL_TIMEOUT_MS=90000
LOCAL_MODEL_MAX_TOKENS=128
LOCAL_MODEL_TEMPERATURE=0
```

The adapter normalizes the endpoint to `/completion`.

A loopback endpoint is shown as a built-in llama.cpp option. A non-loopback endpoint is shown as
hosted. Both use the same bounded runtime contract, and the option remains disabled unless
`LOCAL_MODEL_ENABLED=true`.

## Hosted OpenAI Models

The `openai-fast` and `openai-reasoning` agent profiles use the OpenAI Responses API. Enable them
on the API service with:

```text
OPENAI_API_KEY=...
OPENAI_FAST_MODEL=gpt-5-mini
OPENAI_REASONING_MODEL=gpt-5.2
```

The API key remains server-side. `OPENAI_FAST_MODEL` and `OPENAI_REASONING_MODEL` are optional and
allow operators to change the concrete model behind each stable Grogoni profile.

## Output Contract

The local model must return only one JSON object in `content`.

Tool proposal:

```json
{ "type": "tool", "toolName": "products.list", "input": {}, "reason": "List products." }
```

Clarification:

```json
{ "type": "clarification", "message": "Which product should I draft?" }
```

Read-only response:

```json
{ "type": "response", "message": "I can help with products, invoices, payments, and imports." }
```

Unsupported tools, malformed JSON, timeouts, unavailable adapters, and empty completions fall back
to deterministic CP10 runtime behavior. The runtime response includes the selected provider status
and an error code; the messaging interface surfaces that fallback instead of implying that the
model processed the message.

## Safety Boundaries

- Prompt context uses business-scoped counts and role metadata, not full product, customer, supplier, invoice, payment, or import records.
- Model output is parsed into bounded runtime shapes before verification.
- Business mutations still route only through deterministic validators and tool adapters.
- High and critical risk tools still require explicit confirmation.
- Runtime telemetry records adapter status, latency, error codes, and fallback decisions without raw prompt or output text.
