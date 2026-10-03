# Grogoni Web Inference Engine

## Implemented scope

The Grogoni Web Inference Engine is a resource-management, compatibility, routing, and logical
recovery layer over dedicated Transformers.js/ONNX Runtime Web and WebLLM workers. It is not a new
tensor runtime and does not make an incompatible or oversized model runnable.

The first production phase implements:

- explicit, versioned browser model profiles;
- versioned runtime and checkpoint portability contracts;
- a pinned WebLLM 0.2.84 WebGPU adapter loaded only when selected;
- per-model repository revision, architecture, quantization, backend, context, output, wall-time,
  memory, task-class, and readiness metadata;
- capability filtering before model download;
- device-tier task budgets;
- model selection in the Agent settings UI;
- a tokenizer/allocation/readiness generation before a model is marked ready;
- coarse, account-scoped device/backend outcome history in IndexedDB;
- model ranking that prefers compatible and previously successful combinations;
- a dedicated worker with generation deadlines and bounded output;
- structured task-state checkpoints in IndexedDB;
- lightweight `visibilitychange` and `pagehide` checkpoint attempts;
- recovery of an interrupted partial output only for the same account-scoped request and
  objective;
- 24-hour checkpoint expiry and deletion after successful task completion.

Model weights continue to be downloaded directly from the approved Hugging Face
`onnx-community` and `mlc-ai` namespaces. The Grogoni API does not proxy or persist browser model
weights.

## Browser model catalogue

| Model                 | Adapter         | Revision                                   | Download | Working memory | Tier    | Backends    |
| --------------------- | --------------- | ------------------------------------------ | -------: | -------------: | ------- | ----------- |
| SmolLM2 135M Lite     | Transformers.js | `b8a5c0f`                                  |  ~190 MB |        ~500 MB | low+    | WebGPU/WASM |
| SmolLM2 360M          | Transformers.js | `9bc69bf`                                  |  ~400 MB |        ~850 MB | low+    | WebGPU/WASM |
| SmolLM2 360M · WebLLM | WebLLM 0.2.84   | `3a622fd89e0216e8bb10c410c007c786baa8a033` |  ~260 MB |        ~450 MB | medium+ | WebGPU only |
| Qwen2.5 0.5B Instruct | Transformers.js | `4b32b4541cf2de9d0c0a85125e8fe8d9943f7982` |  ~800 MB |      ~1,500 MB | high    | WebGPU only |
| Qwen2.5 0.5B · WebLLM | WebLLM 0.2.84   | `32ff081fe7e4dfe4ffb167b94c66fdf11e02b8ad` |  ~600 MB |      ~1,100 MB | high    | WebGPU only |

The byte values are admission-control estimates, not guarantees of browser process or GPU memory.
The actual runtime combination must pass a real load and readiness generation on each coarse
device profile.

The low tier recommends SmolLM2 135M. On compatible WebGPU devices, medium and high tiers prefer
the WebLLM profile for their model family. WASM continues to use Transformers.js. The user still
chooses and explicitly downloads a model.

## Runtime and portability contracts

Every initialized engine publishes `grogoni.browser-runtime.v1` metadata containing the adapter,
adapter version, pinned model-library revision, browser runtime, backend, token-counting mode,
cancellation/streaming support, supported checkpoint kinds, and native-state format.

Task checkpoints publish `grogoni.browser-task-state.v2` compatibility metadata. They store bounded
role/content messages, objective, and partial output. This representation can move between
Transformers.js and WebLLM only when both profiles use the same Grogoni model family.

Native KV buffers and raw token replay are not marked portable. Both adapters currently publish:

```text
checkpointKinds: ["task-state"]
nativeStateFormat: null
```

See [WebLLM runtime contract](./webllm-runtime-contract.md) for the exact compatibility and
artifact-pinning rules.

## Resource budgets

Every model profile defines recommended input, output, and wall-time limits for low, medium, and
high tiers. The session uses the strictest of the model profile, device capability, and current
context budget.

The initial low-tier SmolLM2 135M limits are:

```text
context budget: 768 tokens
output budget: 64 tokens
wall time: 45 seconds
estimated working memory: 500 MB
concurrent generations: one
```

The worker rejects output limits above the selected model profile and interrupts a generation
when its wall-time deadline expires. Tasks requiring server tools or complex reasoning continue to
route away from browser-local inference.

## Device outcomes

Grogoni stores a coarse profile key derived from:

```text
browser family
browser major version
mobile/desktop class
Grogoni device tier
backend
bounded logical processor count
```

It does not store a raw user-agent string, GPU vendor identifier, prompt, or generated response in
the outcome record. The record contains model/backend identity, load duration, readiness duration,
readiness throughput, success state, and a bounded failure code.

A previous success increases selection priority. A previous out-of-memory, worker, or task-budget
failure demotes that exact runtime-model combination. Manual selection remains possible for
compatible models so browser upgrades and changed device conditions can be retested.

## Structured task-state checkpoints

The authoritative recovery state is logical task state, not a KV cache. Before browser generation,
Grogoni stores a local checkpoint containing:

- account, shop, conversation, request, and model scope;
- the bounded task objective;
- up to 24 bounded relevant messages;
- partial generated output;
- a continuation instruction;
- status, reason, timestamps, and expiry.

Output tokens update the in-memory checkpoint. IndexedDB writes occur at task start, page
backgrounding, page hide/freeze, or generation failure—not for every token. Successful completion
deletes the checkpoint.

Recovery occurs only when the checkpoint:

1. belongs to the current account;
2. has the same request ID;
3. has the same bounded objective;
4. is interrupted rather than running;
5. has not expired.

The recovered partial output is treated as derived conversational context. It may produce a
semantically equivalent continuation rather than an identical token stream.

Checkpoint data can contain user context and is therefore cleared with the account's browser
inference data. The service worker does not cache or upload it.

## Deliberately deferred

### Token replay

The current Transformers.js worker does not expose stable generated token IDs and complete sampler
state through Grogoni's engine interface. Token replay remains a future adapter and must be tested for
each tokenizer, prompt template, model revision, and runtime version.

### Native KV checkpoints

Transformers.js/ONNX Runtime Web does not currently provide Grogoni with a stable portable KV
export/import contract. Native KV checkpointing is not implemented or claimed. A future adapter
must bind checkpoints to exact model, tokenizer, template, backend, runtime, dtype, layout, RoPE,
and format versions.

### Cross-device checkpoint storage

Task checkpoints remain local in IndexedDB. They are not uploaded to PostgreSQL or object storage.
Cross-device recovery requires separate encryption, tenant authorization, retention, deletion,
and object-storage work.

## Adding another browser model

Add a reviewed entry to `apps/web/src/browser-model-registry.ts`.

The profile must include:

1. an HTTPS URL below `huggingface.co/onnx-community/` for Transformers.js or
   `huggingface.co/mlc-ai/` for WebLLM;
2. a reviewed immutable repository revision;
3. an architecture supported by the installed Transformers.js version;
4. a `text-generation` pipeline and backend-specific dtype;
5. tokenizer/prompt-template compatibility metadata;
6. measured download and peak working-memory estimates;
7. conservative context, output, and wall-time budgets per tier;
8. supported backends and minimum tier;
9. task classes;
10. license and source;
11. a short readiness prompt and output budget.

A WebLLM profile additionally requires a model ID present in the pinned package's
`prebuiltAppConfig`, an immutable MLC weight revision, and the approved immutable
`binary-mlc-llm-libs` revision. WebLLM and Transformers.js profiles remain separate even when they
share a Grogoni model family.

Before enabling the entry in production, test:

- a clean download;
- a cached reload;
- tokenizer counting;
- readiness generation;
- cancellation;
- the generation deadline;
- WebGPU device loss where testable;
- WASM with and without cross-origin isolation where supported;
- browser restart and task recovery;
- cache deletion and account-data deletion;
- representative low-memory Android devices.

Do not add arbitrary user-supplied repository IDs to the browser registry.

## Operational verification

```bash
pnpm exec vitest run \
  tests/browser-model-registry.test.ts \
  tests/browser-inference-contracts.test.ts \
  tests/webllm-model-engine.test.ts \
  tests/browser-inference-checkpoints.test.ts \
  tests/browser-inference-storage.test.ts \
  tests/browser-model-engine.test.ts \
  tests/browser-inference-capability.test.ts

pnpm --filter @grogoni/web typecheck
pnpm --filter @grogoni/web build
```

Automated tests mock the heavy model boundary. A production release still requires real-device
tests because browser memory, GPU allocation, thermal throttling, storage eviction, and page
suspension cannot be certified in CI.
