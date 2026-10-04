# Provider-neutral native runtime

## Incident this document exists because of

Render crashed at startup with:

```
Error: The global generative runtime openai-fast is not configured.
Enable the OpenAI provider, allow the model, and configure OPENAI_API_KEY.
```

**Root architectural cause:** the native runtime graph (`services/api/src/cp2/domains/
native-runtime/store.ts`) hard-coded OpenAI as Grogoni's built-in model. `builtinRuntimeModelId =
"openai-fast"` was a mandatory constant, `ensureGlobalDefault()` unconditionally seeded an
`openai-fast` model, an `env:OPENAI_API_KEY`-credentialed execution host, and an installation for
it, and `services/api/src/index.ts` synchronously health-checked that specific adapter and threw
before ever calling `app.listen` if it wasn't configured and healthy. `infra/db/migrations/
065_retire_execution_fabric.sql` seeded the same dependency into the database: the repository
global default binding's primary role pointed at `openai-fast` from the moment that migration ran.
None of this matched the stated architecture - "agents, models, and execution hosts are
independent, swappable slots; no model vendor is required for Grogoni to boot" - it was a real
regression against that goal, not a deliberate design choice.

## Permanent architecture

```
Agent
  │
  ▼
Runtime Binding (stable identity - conversations reference this id, never a model directly)
  │
  ├── Primary Model Slot    (zero or one assigned model)
  ├── Fallback Model Slots  (zero or more, ordered by priority)
  └── Auxiliary Model Slots (reasoning, verifier, coding, ...)
        │
        ▼
    Runtime Model → Model Installation → Execution Host → Runtime Adapter
```

No layer assumes OpenAI, or any other vendor. A model assignment resolves purely through
`NativeRuntimeModelSummary.capabilities` / `configuration.executionTarget` -
`NativeExecutionHostSummary` never has special-cased vendor logic beyond the metadata a user's own
choice of execution target implies.

Models and providers are independently swappable runtime slots. Provider names must never appear
in `ModelExecutionTarget`. The dimensions are intentionally separate:

- NeonDB is the configuration/control plane for bindings, models, targets, hosts, and devices.
- A model is the swappable inference identity selected by a binding.
- A provider is the swappable adapter used to access that model.
- An execution target is the provider-neutral compute location or dispatch path.
- An execution host/device is the concrete destination that satisfies the selected target.

`ModelProviderId` and `RuntimeModelProviderName` are extensible string registry keys, not closed
vendor unions. Adding a provider registers metadata and an adapter; it does not require editing a
platform provider enum. The web application imports `ModelExecutionTarget`, `ModelProviderId`, and
`RuntimeModelProviderName` from `@grogoni/shared-types` rather than maintaining parallel unions.

The native execution targets are (as of ADR-device-independent-runtime-and-registry-discovery.md,
`browser-local` and `installed-app` were retired — a client device never needs a private model copy
to chat; as of docs/runtime/vercel-inference-audit.md, `vercel` became the platform default hosted
target):

| Target               | Meaning                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vercel`             | Inference runs on Grogoni's Vercel deployment (`services/ai-runtime`) - the platform default. Render mints a signed model-artifact URL; Vercel downloads, verifies, and executes it.  |
| `backend`            | Reserved for a future self-hosted server-side execution path, dispatched through the same `ModelRuntimeAdapter` interface - not currently registered by any adapter in production.    |
| `remote-shop-device` | Inference runs on a shop-owned machine registered as an execution host in the shop runtime graph (e.g. a merchant's laptop running Ollama) — never the currently-open browser/device. |

`vercel`/`backend` do not mean any specific model vendor. Multiple model/provider bindings can use
the same target, and a compatible model can use a different target without changing model identity.
The invariant is: execution target = where, model = what, provider = how the model is accessed, and
host/device = the concrete compute destination.

## Empty-slot semantics

`ensureGlobalDefault()` (`services/api/src/cp2/domains/native-runtime/store.ts`) now creates only
the two concepts genuinely built into Grogoni: the built-in agent (`builtin:grogoni-agent:v1`) and a
global default runtime **binding** (`builtin:grogoni-default-runtime:v1`) with `status: "draft"` and
zero model assignments. `builtinRuntimeModelId` no longer exists.

A `"draft"` binding is a first-class, valid, resolvable state - not an error:

- `assignConversationBinding`/`requireGlobalDefault`/`requireAssignableBinding` treat `"draft"`
  exactly like `"active"` for the purpose of attaching a conversation to it. Creating or reading a
  conversation never depends on a model already being chosen.
- `validateBindingStructure`, which runs at actual turn-time resolution, is split into two
  concerns (`services/api/src/cp2/domains/native-runtime/store.ts` §5 comments):
  - **Structural validity** (`requireActiveAgent`): does the binding exist, is its agent active,
    do the contract versions line up. Never touches model assignment.
  - **Execution readiness**: is a primary model actually assigned. Zero enabled primary roles on a
    `"draft"` binding reports `RUNTIME_MODEL_NOT_CONFIGURED` (503) - a clean, expected,
    non-crashing outcome - while the same zero-roles condition on an `"active"` binding (which
    should never happen given `validateActiveTopology`'s write-time invariant) reports
    `RUNTIME_PRIMARY_INVALID`, a genuine corruption signal.
- No fake model is ever invented (`modelId: "none"`, `"placeholder"`, etc.) - the empty slot is
  represented purely as the absence of an enabled primary `cp2_native_runtime_binding_models` row.

## Runtime errors

| Code                                | Meaning                                                                                     | Where                                                                                                                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RUNTIME_MODEL_NOT_CONFIGURED`      | Binding is draft/active but has no model assigned                                           | `resolveBinding` via `validateBindingStructure`                                                                                                                                                                                 |
| `RUNTIME_MODELS_UNAVAILABLE`        | A model is assigned but installation/host isn't currently available                         | `resolveBinding`                                                                                                                                                                                                                |
| `RUNTIME_UNAVAILABLE`               | No runtime adapter is registered for the resolved model/target (the "adapter missing" case) | `requireModelRuntimeAdapter` (`agent-runtime/store.ts`) - kept under its existing, already-tested name rather than introduced as a new `RUNTIME_ADAPTER_UNAVAILABLE` code, to avoid an unrelated rename across a live call path |
| `RUNTIME_MODEL_CAPABILITY_MISMATCH` | Model doesn't declare a capability the agent requires                                       | `validateCapabilityMatch`, used by `resolveRole` and `activateGlobalDefaultModel`                                                                                                                                               |
| `RUNTIME_CONTRACT_INCOMPATIBLE`     | Agent/model/binding runtime **contract version** mismatch (distinct from a capability gap)  | `validateCompatibility`, `validateBindingStructure`                                                                                                                                                                             |
| `RUNTIME_DEFAULT_MISSING`           | No unique global default binding exists at all (deeper corruption than "unconfigured")      | `requireGlobalDefault`                                                                                                                                                                                                          |
| `NO_COMPATIBLE_EXECUTION_TARGET`    | Neither the native resolution nor a legacy binding declares where the model runs            | `resolveExecutionTarget` (`agent-runtime/native-runtime-routing.ts`)                                                                                                                                                            |

None of these fail application startup. `services/api/src/index.ts` no longer health-checks any
model provider before calling `app.listen` - see the acceptance-criteria boot proof below.

**Graceful degradation on the live chat path.** `resolveRuntimeBinding` (the internal resolver) can
throw any of the codes above; two call sites in `services/api/src/cp2/domains/agent-runtime/
store.ts` (`resolveActiveRuntimeModelId`, `resolveRuntimeModelProvider`) call it unguarded while
resolving a chat turn. `services/api/src/cp2/store.ts`'s `resolveNativeRuntimeBinding` dependency
wrapper now catches any `Cp2Error` from that call and returns `null` instead of letting it
propagate - both call sites already treat a `null` native resolution as "fall back to the legacy
`cp2_agent_model_bindings` path" (they did before this change too, for the `conversationId ===
undefined` case), so an unconfigured or unavailable native binding degrades to that same existing,
already-tested fallback instead of throwing an uncaught 500 out of a chat request.

**No implicit `"backend"` default.** `resolveNativeRuntimeModelProvider` (same file) used to fall
back a missing execution target to `"backend"` when neither the native resolution nor a legacy
binding declared one - manufacturing a dependency on a backend inference host that may not even be
configured in this deployment, and surfacing as a confusing adapter-unreachable error instead of a
clear "nothing is configured" one. It now calls `resolveExecutionTarget`, which resolves a target
from, in order: the native resolution's declared `configuration.executionTarget`; failing that, the
`type` of the concrete, already-available execution host backing the native resolution's selected
model (still a genuine explicit signal recovered from durable state, not a guess, since a _selected_
candidate is only ever the one that resolved `available: true`); failing that, the legacy binding's
`executionTarget`. If none of those exist, it throws `NO_COMPATIBLE_EXECUTION_TARGET` rather than
guessing. `services/api/src/cp2/store.ts`'s `attemptPublicAgentReply` (the anonymous storefront
reply path, which is documented to always degrade to `null` rather than throw) now also catches any
`Cp2Error` from `resolveRuntimeModelProvider`, since that call can throw before ever returning
`provider: undefined` whenever `modelRuntimeAdapterResolver` is configured (the production case).

The strict resolve-or-throw behavior only applies when `modelRuntimeAdapterResolver` is configured
(`adapterResolverConfigured: true`, always true in production per `services/api/src/index.ts`) -
that's the only case where the resolved target is actually used to route to a real adapter. When it
is not configured (a handful of tests that drive `runtimeModelProvider`/`runtimeModelProviderResolver`
directly, bypassing the adapter system entirely), the target is resolved best-effort for
observability only and never blocks routing - there is nothing to protect against manufacturing a
network dependency over, since no adapter lookup happens in that shape at all.

## Model swap

`Cp2Store.activateGlobalDefaultModel(input)` → `NativeRuntimeBindingStore.activateGlobalDefaultModel`
assigns (or swaps) the primary model for the global default slot: it upserts the catalog model,
upserts a verified execution host and installation for the given `executionTarget` (`backend` or
`remote-shop-device`), validates the
model's capabilities against the built-in agent's requirements, replaces the existing primary role
if any, and promotes the binding from `"draft"` to `"active"`. Calling it again with a different
model replaces the primary role in place - **the binding's id never changes**, so every
conversation whose `runtime_binding_id` points at the global default keeps pointing at the same
binding across the swap.

The pre-existing tenant-scoped path, `NativeRuntimeBindingStore.activateVerifiedModel` (the "Use
with agent" HTTP flow), was already provider-neutral - it accepts any `AiModelSummary` +
`ModelExecutionTarget` and already reuses the same binding id when reactivating a business+agent
pair - and needed no changes for this task. `activateGlobalDefaultModel` was added as a small,
separate, clearly-named method rather than folding it into `activateVerifiedModel`, to avoid
touching that method's existing, live, heavily-tested tenant-activation behavior.

## Conversation behavior with no model

`MessagingDomain.createConversation` calls `assignConversationBinding`, which is purely structural
(binding lookup + tenant ownership + `requireActiveAgent`) and never requires a model to be
assigned. A conversation bound to the unconfigured global default is created and readable
normally; only an actual inference turn against it surfaces `RUNTIME_MODEL_NOT_CONFIGURED`.

## OpenAI's role now (removed)

> **Update:** OpenAI, Anthropic, Z.ai and any OpenAI-compatible server (including Grogoni-hosted
> llama.cpp) are now reachable again as _optional_ providers through the multi-provider inference
> router, exposed to agents as ordinary `ModelRuntimeAdapter`s on the `backend` target. None is
> required to boot and none is a default. See
> [multi-provider-inference-implementation.md](./multi-provider-inference-implementation.md).

`services/api/src/inference/openai-provider.ts`, `createOpenAiProvider`, and the `openai-fast` /
`openai-reasoning` catalog entries were removed entirely as part of the Vercel inference migration
(`docs/runtime/vercel-inference-audit.md`) - not because OpenAI-as-one-optional-provider was ever
wrong in principle (the paragraph below is preserved as the historical rationale for _why_ it was
never required infrastructure), but because no code in this repository constructs an OpenAI adapter
any more. Re-introducing an OpenAI-backed model means writing a new `ModelRuntimeAdapter`
implementation and registering it under a chosen `ModelExecutionTarget` key, the same way
`createVercelModelAdapter` is registered today - not restoring the deleted file.

Historical rationale (accurate for the OpenAI-provider era, kept for context): OpenAI was exactly
one optional cloud provider. `render.yaml`'s `OPENAI_API_KEY` / `OPENAI_FAST_MODEL` /
`OPENAI_REASONING_MODEL` / `INFERENCE_CLOUD_PROVIDER` / `INFERENCE_CLOUD_MODEL_ALLOWLIST` were
already not required by Render itself (`OPENAI_API_KEY` was `sync: false`, safe to leave blank);
the only place that ever turned an absent key into a hard failure was the startup health check
removed earlier in this document's history. With the key blank, the adapter simply never
registered - the same optional-registration pattern `BACKEND_INFERENCE_ENABLED=false` used for the
old backend adapter, applied uniformly. The runtime resolved the model and target first, then that
model's provider adapter; it never branched on `executionTarget === "openai"`.

## Forward migration

`infra/db/migrations/065_retire_execution_fabric.sql` is applied and immutable; it is not edited.
`infra/db/migrations/067_provider_agnostic_runtime_default.sql` converts its seed forward: it
disables (`enabled: false`) the one repository-seeded primary role
(`fa44cb93-7206-4265-88b9-d8493db05f21`, `modelId: "openai-fast"`) on the global default binding
and sets that binding's `status` to `"draft"`, using the exact deterministic ids 065 created. It
does not delete the `openai-fast` catalog model, its execution host
(`6672a55f-8ef8-46b1-8b11-9b1d92af8c78`), or its installation
(`a45acff5-3cfd-4041-84c1-6a3f665f7726`) - those stay as an optional, still-selectable model. It
does not touch any user-created binding, role, model, host, or installation - every statement is
scoped to those exact repository-seeded entity ids. A working rollback
(`infra/db/rollbacks/067_provider_agnostic_runtime_default.down.sql`) restores the pre-067 state
exactly, since this migration is fully reversible (unlike 065's table drops).

`infra/db/migrations/069_provider_neutral_execution_targets.sql` then converts every persisted
`executionTarget: "openai"` value in the active binding/native graph to `"backend"`, replaces the
legacy binding check constraint with the four-target contract, and neutralizes matching execution
hosts. Existing model `provider` and `providerModelId` fields are deliberately untouched. Provider
credential references formerly stored on provider-named hosts are preserved in model configuration
before host credentials are cleared. Before transforming anything, migration 069 snapshots the
exact affected model, host, and binding envelopes. Its paired rollback restores those snapshots
and the pre-069 constraint for a coordinated downgrade to the older application, then removes the
backup table. The current application and forward schema still expose only the four neutral targets.

Migration 067 was verified live against a local Postgres already migrated through 066; `pnpm db:verify-schema`
passes with `globalDefaultRuntimeStatus: "draft"`, and `createPostgresCp2Store` boots against it
without error.

## Schema verifier

`services/api/scripts/verify-db-schema.mjs`'s global-runtime check no longer asserts a specific
model id, provider, or execution host. It asserts the structural invariant the domain layer itself
enforces: exactly one global default binding exists, its agent is active, its status is `"active"`
or `"draft"`, and - only when `"active"` - it has exactly one enabled primary role (mirroring the
`check_native_runtime_binding_primary` database trigger). An unconfigured (`"draft"`) global
default is accepted as a valid production state, not a failure.

## Boot proof

Ran the real compiled artifact directly, in production mode, with `OPENAI_API_KEY` unset,
`INFERENCE_CLOUD_FALLBACK_ENABLED` unset (default at the time; this env var was later removed
entirely along with the automatic local-to-cloud escalation feature - see "No implicit `"backend"`
default" above), no local model, no owner node:

```
$ NODE_ENV=production DATABASE_URL=... REDIS_URL=... node services/api/dist/index.js
{"event":"runtime_schema_boot","runtimeArchitecture":"native","store":"postgres","schemaCompatibility":"verified","redisConfigured":true,...}
{"msg":"Server listening at http://127.0.0.1:4477"}

$ curl http://127.0.0.1:4477/health/ready
{"service":"api","status":"ready",...,"inference":{"enabled":false,"required":false,"ok":null,"model":null},"model":null}
HTTP 200
```
