# Inference runtime architecture

## Ownership boundary

```text
Neon
    PostgreSQL: application state, native runtime graph, model-artifact metadata
    Object storage: GGUF model artifact bytes

Render (services/api)
    control plane: auth, business/conversation state, agent/model/host resolution,
    tool authorization, MCP, persistence, response streaming to the client

Vercel (services/ai-runtime)
    inference execution only: download/verify a model artifact, load it, generate,
    stream tokens back to Render
```

Render never loads or runs a model. Vercel never touches Postgres, business data, or tool
credentials, and is never given a permanent storage secret - Render mints a short-lived signed URL
per request. This boundary is enforced by `pnpm check:inference-boundaries`
(`scripts/check-inference-boundaries.mjs`), part of `pnpm build:production`.

## Runtime flow

```text
Chat client
    |
    v
POST /v1/messages or /businesses/:id/runtime/turns  (Render)
    |
    +-- authenticate, resolve conversation/business context
    +-- resolve agent + model + runtime binding (native runtime graph, Neon)
    +-- resolve execution target (isModelExecutionTarget-driven; no hardcoded target)
    +-- build an InferenceExecutionRequest
            |
            v
      Vercel inference (services/ai-runtime)
            |
            +-- download + verify the signed model artifact (SSRF-guarded, sha256/size/format)
            +-- load via node-llama-cpp (bounded LRU cache, per warm instance)
            +-- generate, stream NDJSON delta/result events
                    |
                    v
              Render
                    |
                    +-- process tool calls (never Vercel's authority)
                    +-- persist the conversation
                    +-- stream the response to the client
```

## Swappable primitives

Four independently swappable concepts, matching the shapes in `packages/shared-types/src/index.ts`
and `services/api/src/inference/model-runtime.ts`:

- **Agent** - `agentRuntimeAdapterId` (e.g. `"pi"`), resolved via `agentRuntimeAdapterResolver`.
- **Model** - a catalog entry (`AiModelSummary`) plus its `NativeRuntimeModelSummary` row.
- **Model artifact** - a `ModelArtifact` row (`cp2_runtime_model_artifacts`): storage location, format,
  quantization, size, hash. A model can have zero, one, or (over time) several artifact rows; only
  one is `status: "available"` at a time per the DB's partial unique index.
- **Execution host** - a `ModelExecutionTarget` (`"vercel" | "backend" | "remote-shop-device"`) plus
  a concrete `NativeExecutionHostSummary` row. `"vercel"` is the platform default; `"backend"`
  remains available for a future self-hosted server adapter under the same interface;
  `"remote-shop-device"` is a merchant-owned device, brokered separately by `OwnerNodeBroker`
  (`services/api/src/inference/owner-node-broker.ts`) rather than through the `ModelRuntimeAdapter`
  map, since it needs a WebSocket-registered, HMAC-signed job protocol instead of a synchronous HTTP
  call.

`ModelRuntimeAdapter` (`canRun` / `healthCheck` / `generate`) is the one interface every execution
host implements. `createVercelModelAdapter` is Vercel's implementation; nothing about the resolver,
the routing (`native-runtime-routing.ts`), or the chat pipeline branches on `"vercel"` specifically -
`services/api/src/index.ts` builds a `Map<string, ModelRuntimeAdapter>` keyed
`` `${executionTarget}:${modelId}` `` and every caller does a single map lookup.

## Runtime binding resolution

`resolveExecutionTarget()` (`services/api/src/cp2/domains/agent-runtime/native-runtime-routing.ts`)
is the single authoritative resolver: it prefers the selected native execution host's `type`, falls
back to the model's declared `configuration.executionTarget`, and throws
`NO_COMPATIBLE_EXECUTION_TARGET` rather than silently defaulting to any specific target. This
function does not need to change when a new execution host type is added.

`resolveNativeRuntimeModelProvider()` wraps that resolution with adapter lookup, fallback-candidate
iteration, and per-attempt telemetry (`runtimeCandidateKey`, `attemptedRuntimeKeys`). Its
`eligibleExecutionTargets` parameter is what actually gates which targets a given call site may
route to - callers must pass every target they intend to support, not just the one they tested
against; a stale hardcoded `Set(["backend"])` here silently excludes every other live target
(see `docs/runtime/vercel-inference-audit.md`'s "Bugs found and fixed" section for the real
incident this caused).

## Swap flows

**Swap the model** (same agent, same execution host): change
`PLATFORM_DEFAULT_MODEL_ID`/`platformDefaultRuntime.modelId`, or activate a different model through
`POST /api/agents/:agentId/models/:modelId/activate`. `index.ts` already builds a
`createVercelModelAdapter` per enabled catalog model, so no code change is needed as long as the
new model has an available `cp2_runtime_model_artifacts` row.

**Swap the execution host** (same agent/model): change `PLATFORM_DEFAULT_EXECUTION_TARGET`, or pass
`executionTarget` explicitly to the activation endpoint. Registering a new host type means adding an
entry to `modelExecutionTargets` (`packages/shared-types/src/index.ts`), a
`ModelRuntimeAdapter` implementation for it, and registering that adapter into the same
`modelRuntimeAdapters` map in `index.ts` under `` `${newTarget}:${modelId}` `` - the routing,
resolver, and chat pipeline require no changes.

**Swap the engine**: which `AgentRuntimeAdapter` runs a shop's turns is a property of their chosen
agent definition (`AgentDefinition.runtimeAdapterId` - see
`docs/architecture/swappable-agent-model-runtime.md`), not an independent activation input. Pick a
different built-in agent definition (or import one that declares a different adapter) to change
engines; `PLATFORM_DEFAULT_AGENT_ADAPTER_ID` still controls the deployment-wide zero-setup default
for untouched shops. Model and execution-host selection remain independent of which engine runs.

## Failure semantics

Runtime errors are typed on both sides: `ModelRuntimeError` (Render,
`services/api/src/inference/model-runtime.ts`, `code` + `retryable`) and `InferenceServiceError`
(Vercel, `services/ai-runtime/src/service-error.ts`, `code` + `retryable` + HTTP `status`), and they
round-trip cleanly over the wire as the NDJSON `{type: "error"}` event. Health states surfaced by
`ModelRuntimeAdapter.healthCheck()`: `available` (bool), plus a `status` derived by callers into
`"ready" | "unavailable"` for `/health/ready` and `/health/ai`. Vercel's own `/health` reports a
simpler `state: "READY"` liveness check with no model context - see
[../deployment/vercel-inference.md](../deployment/vercel-inference.md) for what each health surface
actually proves.

## Related documentation

- [../runtime/vercel-inference-audit.md](../runtime/vercel-inference-audit.md) - what existed before
  this migration, what changed, and why.
- [../deployment/vercel-inference.md](../deployment/vercel-inference.md) - Vercel deployment.
- [../deployment/render-retirement.md](../deployment/render-retirement.md) - Render is retired; where the API and jobs run now.
- [../storage/model-artifacts.md](../storage/model-artifacts.md) - artifact storage contract.
- [provider-neutral-runtime.md](./provider-neutral-runtime.md) - the original provider-neutrality
  design this migration preserves.
- [native-runtime-bindings.md](./native-runtime-bindings.md) - the native runtime graph schema.
- [multi-provider-inference-implementation.md](./multi-provider-inference-implementation.md) - the
  provider router (OpenAI, Anthropic, Z.ai, OpenAI-compatible/llama.cpp) served on the `backend`
  target through the same `ModelRuntimeAdapter` seam.
