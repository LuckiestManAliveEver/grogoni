# Grogoni Agent Execution Fabric — Repository Audit (Phase 0)

Date: 2026-08-25

This is a read-only audit. No implementation code, migration, or new
abstraction was written or modified to produce this report. Every claim below
is anchored to an exact file (and line, where the point is a specific
statement rather than a whole function/section).

## 1. Current agent/model/device coupling

**Agent ↔ model — explicit, but through two independent mechanisms that can
disagree.**

- `BusinessAgentProfileSummary.modelId: string` is a flat, required field on
  the agent profile itself (`services/api/src/cp2/domains/agent-runtime/shared.ts:145`,
  inherited from `BusinessAgentProfileInput`). It is read/written through the
  ordinary profile save path (`PUT /businesses/:businessId/agent-profile`) and
  is the _legacy_ coupling — a simple "this is the model this agent's owner
  picked," with no verification that the model actually works.
- `AgentModelBindingSummary` (`packages/shared-types/src/index.ts:1050-1070`,
  persisted as `cp2_agent_model_bindings`, migration
  `infra/db/migrations/040_agent_model_runtime_bindings.sql`) is the newer,
  _authoritative_ coupling for server-side execution. It is created only by
  `Cp2Store.activateAgentModel` (`services/api/src/cp2/domains/agent-runtime/store.ts`,
  reached via `POST /api/agents/:agentId/models/:modelId/activate`), which
  first runs a real adapter health check
  (`requireModelRuntimeAdapter(...).healthCheck(...)`) before writing a row. A
  partial unique index enforces at most one `active` binding per agent
  (`cp2_agent_model_bindings_one_active_per_agent_idx`,
  `040_agent_model_runtime_bindings.sql`).
- At runtime-turn time, `Cp2Store.resolveActiveRuntimeModelId`
  (`services/api/src/cp2/domains/agent-runtime/store.ts:3157`) prefers the
  verified `AgentModelBindingSummary` and only falls back to the profile's
  plain `modelId` string, or the cloud-fallback `activeAiModels` selection, if
  no binding exists. So the two coupling mechanisms are not the same fact
  represented twice — one is a resolution _fallback chain_, and the profile's
  `modelId` field can point at a model nobody has verified works.

**Agent ↔ device — implicit, and only for the _local-execution_ case.**

There is no `agent.deviceId` field anywhere. An agent has no device identity
of its own. What exists instead is device-scoped _assignment_ records that
each separately reference both an agent (via `businessId`/`agentId`, which
are the literal same string value in this codebase's current "one agent per
business" model — confirmed at `apps/web/src/AgentModelPanel.tsx:157`,
`const canonicalRuntimeAgentId = business.id;`, and
`services/api/src/cp2/domains/agent-runtime/store.ts:953,1019`,
`agentId: input.businessId`) and a device:

- `AgentModelAssignmentSummary.deviceId`
  (`packages/shared-types/src/index.ts:1128-1144`) — one row per
  (business, device) pair, tracking whether an installed native/GGUF model on
  _this specific device_ has been tested and is ready.
- `BrowserInferenceAssignmentSummary.deviceId`
  (`packages/shared-types/src/index.ts:970-990`) — the parallel record for
  browser-tab (WebGPU/WASM) inference, one per (business, device).

Both are looked up by a composite key function
(`agentModelAssignmentKey(businessId, deviceId)`,
`browserInferenceAssignmentKey(businessId, deviceId)`,
`services/api/src/cp2/domains/agent-runtime/store.ts`), not by a device
foreign key into a `devices` table — because no such table exists (see §3).
The coupling is therefore: _implicit_, expressed only through matching string
keys across otherwise-independent maps/tables, and only ever describes "is
this device ready to run this agent's chosen local model," never "this agent
belongs to this device."

**Model ↔ device — explicit, split across three separate record types with
overlapping but non-identical scope.**

1. `InstalledAgentModelSummary` (`packages/shared-types/src/index.ts:1097-1122`,
   `cp2_installed_agent_models`) — a GGUF file installed on one device
   (`accountId`, `userId`, `deviceId`, `modelId`), independent of any agent.
2. `AgentModelAssignmentSummary` (above) — binds one installed model to one
   agent on one device, plus a readiness verdict.
3. `BrowserInferenceAssignmentSummary` (above) — the browser-tab analog of
   (2), for models that are never "installed" as a file (WebGPU/WASM
   in-browser weights) but are still device-scoped and readiness-tracked.

None of these three tables/types reference each other by foreign key; they
share only the `(businessId, deviceId)` string pair as an implicit join key.

**Conversation ↔ runtime — advisory, not permanent, and not even stored on
the conversation.**

`ConversationMessageSummary` (`packages/shared-types/src/index.ts:764-799`)
has no `modelId`, `provider`, or `runtime` field of any kind — its `provider`
field is a _messaging channel_ (SMS/email/WhatsApp), unrelated to AI model
identity. The record of which model actually answered a turn lives entirely
on a separate, parallel object: `RuntimeTurnSummary.model: RuntimeModelTrace | null`
(`packages/shared-types/src/index.ts:3372-3391`), persisted in the
`runtimeTurns` map, not in `conversationMessages`. `RuntimeSessionSummary`
(`packages/shared-types/src/index.ts:3360-3370`) itself has **no
`conversationId` field at all** — a `conversationId` is only ever passed as a
transient input parameter to `createRuntimeTurn`
(`services/api/src/cp2/domains/agent-runtime/store.ts:2451`), used to route
the reply into that conversation at write time, and then not retained as a
queryable fact linking that conversation to that runtime turn going forward.
Concretely: there is no query path today that answers "which model most
recently answered conversation X" without re-deriving it from the newest
`RuntimeTurnSummary` for that session and hoping the caller also recorded
which session mapped to which conversation. This binding should be treated as
**advisory/reconstructable, not permanent**.

## 2. Existing registries and routers

**Agent registry.** `cp2_agent_profiles`, one row per business
(`Cp2Store.agentProfiles` map,
`services/api/src/cp2/domains/agent-runtime/store.ts`). Read via
`currentAgentProfile(businessId, now)`; written via
`PUT /businesses/:businessId/agent-profile`. A companion append-only
`cp2_agent_runtime_versions` table (same migration 039) records immutable
snapshots on every material change (`recordAgentRuntimeVersion`), giving the
agent profile a version history — but the _model binding_ is versioned
separately (see below), not as part of this same version record.

**Model registry — two, not one, and they disagree on at least one field
until reconciled by a workaround.**

1. `aiModelRegistry` (`services/api/src/cp2/domains/agent-runtime/store.ts`,
   code-defined constant) — the richer, canonical catalogue: provider
   adapters, execution targets, license, download size, and (per
   `docs/architecture/context-semantic-runtime-audit.md`, a prior audit in
   this same repo) a `contextWindow` field added specifically because this
   registry originally lacked one.
2. `runtimeModels` (`packages/shared-types/src/index.ts:606` per the
   cross-referenced prior audit) — a second, independently-declared catalogue
   used by parts of the browser/local-inference path.
   `contextCharacterBudgetForModel` (`services/api/src/cp2/domains/agent-runtime/store.ts`)
   checks `runtimeModels` _first_, then falls back to `aiModelRegistry` — an
   explicit acknowledgment in the code itself that these are two registries
   requiring a resolution order, not one source of truth.

Capability fields already tracked per entry (from `AiModelSummary`,
`InstalledAgentModelSummary`, and `RuntimeModelDefinition` combined):
`contextWindow` (required, `number | null`, `packages/shared-types/src/index.ts`),
`format` (`"GGUF"`), `quantization`, `architecture`, `parameterCount`,
`fileSizeBytes`, `license`/`commercialUseAllowed`, `runtimeBackend`
(`AgentModelRuntimeBackend`: `LLAMA_CPP_ANDROID | LLAMA_CPP_BROWSER | OLLAMA | CLOUD`).
There is **no explicit "supports tool calling" capability field anywhere** in
either registry — confirmed by grep across the whole repo for
`supportsToolCalling`/`toolCallingSupported`/similar identifiers (zero hits).
Tool-call capability is not modeled as model metadata at all today; it is
handled structurally instead, by routing tool-shaped requests to
server-mediated chat regardless of which model is chosen (see
`docs/architecture/chat-tool-execution-boundary.md` and §8 below on
`resolveExecutionChain`).

**Routing/selection logic.**

- Model _identity_ resolution: `Cp2Store.resolveActiveRuntimeModelId`
  (`services/api/src/cp2/domains/agent-runtime/store.ts:3157`) — binding, then
  profile `modelId`, then cloud fallback, in that order.
- Provider/adapter resolution: `Cp2Store.resolveRuntimeModelProvider` and
  `createRuntimeModelRoute` (`services/api/src/cp2/domains/agent-runtime/store.ts:3412`,
  called from `createRuntimeTurn` at line 2700) — turns a resolved model ID
  into a live `ModelRuntimeAdapter`
  (`services/api/src/inference/model-runtime.ts:46`) via
  `requireModelRuntimeAdapter`.
- Client-side browser-vs-server routing: `decideInferenceRoute`
  (`apps/web/src/browser-inference-routing.ts:7-59`) — a deterministic
  decision tree (deployment flag → tool-keyword heuristic
  `requestRequiresServerTool` → complexity/tab-visibility → device capability
  → context-window fit → model-loaded state → default to browser-local).

**`resolveExecutionChain()` — not found.** A repo-wide, case-insensitive grep
for `resolveExecutionChain`, `ExecutionChain` (any casing), `hybrid rout*`, and
`piano` returned **zero results** anywhere in the repository (source, tests,
docs, or `dist/` build output). A related search for "SmolLM2" combined with
"tool"/"hybrid"/"chain"/"calling" also returned zero results, despite SmolLM2
itself being a real, present model option in over 20 files. **This function
and the "hybrid routing layer built for SmolLM2's lack of tool-calling
support" it is said to implement do not exist in this codebase today**, under
this name or any variant I could find. This is surfaced as an open question in
§8 rather than resolved, per this task's scope — it may exist in a branch not
present here, may have been reverted, or may be a mischaracterization of the
deterministic keyword-heuristic routing in `decideInferenceRoute` /
`requestRequiresServerTool` described above, which achieves a similar
practical effect (routing tool-shaped requests away from models/paths that
can't safely execute one) through a different, simpler mechanism with a
different name.

**Chat/context pipeline — model identity resolved _before_ context retrieval;
context _sizing_ depends on the already-resolved model; actual model
invocation happens _after_ context assembly.** Traced precisely in
`Cp2Store.createRuntimeTurn` (`services/api/src/cp2/domains/agent-runtime/store.ts`):

1. Line 2488 — `resolveActiveRuntimeModelId` (which model/binding will
   answer this turn — decided first).
2. Line 2671 — `retrieveAgentContext` is called, with `characterBudget` at
   line 2677 computed via `contextCharacterBudgetForModel(runtimeModelId)` —
   i.e. _how much_ context to pack is parameterized by the model chosen in
   step 1, even though context selection itself (which sources, by
   relevance/audience) doesn't depend on the model.
3. Line 2700 — `createRuntimeModelRoute` (the actual provider call) runs
   after context has been retrieved and packed.

So the three concerns are **interleaved, in this fixed order**: model
identity → context retrieval (sized by that model) → context assembly →
model invocation. There is no point in the pipeline where model selection is
revisited after context is known (e.g. no "this context is too rich, pick a
larger-window model instead").

## 3. Device / runtime host concepts

**No `devices` table (or equivalent first-class device entity) exists for
the model-execution domain.** Repo-wide search of `infra/db/migrations/*.sql`
for "device" surfaces only auth/security- and messaging-scoped tables:
`device_trust` (`016_device_trust_actor_type.sql`, `014_cp2_phase1_auth_security_relational.sql:14-24`
— device identity is part of a composite primary key
`(business_id, user_id, device_id)`, not a row of its own),
`cp2_e2ee_devices` (`021_messaging_push_e2ee.sql`),
`native_sms_devices` (`054_android_native_sms_channel.sql`), and
`cp2_device_account_bootstraps`/`cp2_device_recovery_credentials`
(`050_progressive_device_identity.sql` — first-device account-creation
retry-safety, unrelated to inference). None of these store runtime/model
execution capability. Every model-execution-domain record
(`InstalledAgentModelSummary`, `AgentModelAssignmentSummary`,
`BrowserInferenceAssignmentSummary`) treats `deviceId` as an opaque string
field, never a foreign key into a device registry.

**Heartbeat/presence does exist, but only inside the owner-node broker, and
only in-memory.** `services/api/src/inference/owner-node-broker.ts` implements
`register()`, `heartbeat()`, `unregister()`, and a 90-second
heartbeat-expiry `expire()` — but its presence map
(`InferenceNodePresence`, `packages/shared-types/src/index.ts:149-159`) is a
plain in-process `Map`, not backed by any table. Per its own documentation
(`docs/inference/owner-node.md`): _"Do not create a PostgreSQL heartbeat
row"_ — this is a deliberate, stated design choice, not an oversight, and it
means this presence concept does not survive a restart or scale across
multiple API instances today.

**Web Inference Engine backend priority chain — confirmed single-browser,
single-session scope. Not cross-device aware, and this is explicit, stated
project policy, not an accidental gap.**

Per `docs/inference/grogoni-web-inference-engine.md`:

- Model/backend selection prioritizes WebLLM on WebGPU-capable medium/high
  device tiers and falls back to Transformers.js on WASM (§"Browser model
  catalogue", same doc) — this does **not** match the exact chain named in
  this task's brief (llama.cpp-WebGPU → Transformer.js → WebGPU → WASM →
  remote fallback). I could not find that exact five-stage chain, under that
  exact ordering, anywhere in the repository; flagging this discrepancy
  rather than forcing a match (see §8).
- "Device outcomes" (coarse success/failure history used to rank model
  choices) are stored in **IndexedDB**, keyed by a coarse profile (browser
  family/version, mobile/desktop class, device tier, backend, logical
  processor count) — explicitly local to that browser.
- The doc's own "Deliberately deferred" section states outright: _"Cross-device
  checkpoint storage... Task checkpoints remain local in IndexedDB. They are
  not uploaded to PostgreSQL or object storage. Cross-device recovery
  requires separate encryption, tenant authorization, retention, deletion,
  and object-storage work."_

**Direct answer for the deliverable checklist: the Web Inference Engine chain
is a single-browser, single-session concept today, with zero cross-device
awareness, and the project's own documentation already names this as future,
unbuilt scope rather than treating it as already solved.**

## 4. Realtime / connectivity infrastructure

**Direct answer: YES.** Reusable, authenticated, bidirectional realtime
infrastructure already exists and is the closest available analog for a
future runtime-host presence feature — the owner-node broker described in
§3, reachable at `GET /v1/inference/owner-node`
(`services/api/src/cp2/routes.ts:1341-1410`, WebSocket, session-cookie +
origin-allowlist authenticated, same pattern as the separate `/v1/realtime`
sync channel). It already implements registration, heartbeat-based liveness,
tenant scoping, and signed job dispatch with replay checks
(`services/api/src/inference/owner-node-broker.ts`).

Two caveats that matter for a later phase, not resolved here:

- It is **process-local/in-memory only** (see §3) — not yet safe across
  multiple API instances without a Redis-backed (or similar) redesign.
- It is scoped specifically to _inference job routing_ for one tenant's
  registered nodes. Repurposing it as a general-purpose "any runtime host,
  any purpose" presence channel is a scope change to an existing system, not
  a drop-in reuse of infrastructure built for that purpose.

A second, separate realtime channel exists (`GET /v1/realtime`,
`services/api/src/cp2/routes.ts:1256-1309`, client at
`apps/web/src/sync/realtime-client.ts`) but is a one-way, server→client,
single-account data-sync notification channel (pushes `sync.changes_available`
so the browser's IndexedDB sync client knows to pull) — it does not accept
client registration and is not a plausible host for device/runtime presence.

## 5. The "Use with Agent" / "Activate Model" flows

These labels are used for **three distinct operations** in the current UI,
each writing different persisted state. This is exactly the kind of
"silently doing several things at once" the task asked to check for
precisely, and it is real:

**(a) "Use with agent" (server-backend model binding).**
`activateServerBackendModel` (`apps/web/src/AgentModelPanel.tsx:1073`) →
`POST /api/agents/:agentId/models/:modelId/activate` → `Cp2Store.activateAgentModel`
→ runs a real adapter health check
(`requireModelRuntimeAdapter(...).healthCheck(...)`) → on success, writes one
`AgentModelBindingSummary` row (`cp2_agent_model_bindings`), marking any prior
active binding for that agent inactive (enforced by the partial unique
index, §1) → also revises the agent profile's `runtimeVersion` and records a
new `cp2_agent_runtime_versions` entry. On health-check failure, the prior
active binding is left untouched (confirmed by
`docs/render-neon-model-runtime-audit.md`: _"a persistence failure restored
the last database snapshot"_ / _"preserved the previous active binding on a
failed replacement"_). Removal is the mirror operation:
`removeServerBackendModelFromAgent` (`AgentModelPanel.tsx:1135`) →
`DELETE /api/agents/:agentId/model-binding` → marks the binding row inactive
(does not delete it).

**(b) "Activate on this device" (device-local GGUF model readiness).**
A composite, multi-step client-driven flow, not one API call: validate the
installed file against the backend
(`validateInstalledModelOnBackend`, `AgentModelPanel.tsx:618`, →
`POST /v1/models/:id/validate`) → run a real local readiness inference in a
worker (client-side, per `docs/android/agent-model-runtime.md`'s
"Reply with exactly: GROGONI_MODEL_READY" contract) → on success, synchronize
the result to the server (`synchronizeAgentModelAssignment`,
`AgentModelPanel.tsx:634`, → `PUT /businesses/:businessId/agent-model` →
`Cp2Store.assignAgentModel`) → writes one `AgentModelAssignmentSummary` row
(device-scoped, not agent-model-binding-scoped). **This single UI action is
simultaneously: validate + load + test + register + select** for that one
device — it does not touch `cp2_agent_model_bindings` at all.

**(c) Cloud-fallback model activation (a third, separate "activate").**
`AgentModelPanel.tsx:1003` — `PUT /businesses/:businessId/ai-model` →
`Cp2Store.activateAiModel` → writes `ActiveAiModelSummary` (a single
per-business cloud-fallback selector, explicitly gated in the UI behind
"Download, connect, and test a GGUF model before selecting an OpenAI
fallback," per `docs/architecture/chat-tool-execution-boundary.md`'s
description of this same code). This is never the primary model source; it
is only consulted by `resolveActiveRuntimeModelId` as a last resort.

None of (a), (b), (c) write to the same table. A shop can have an active
binding (a), zero device assignments (b), and a cloud fallback (c)
simultaneously, and the resolution order in `resolveActiveRuntimeModelId`
(§1/§2) is the only place that reconciles which one actually answers a given
turn.

## 6. Schema mapping table

| Existing entity                                                                                                             | Closest target concept   | Notes                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BusinessAgentProfileSummary` / `cp2_agent_profiles` (`agent-runtime/shared.ts:165`)                                        | Agent                    | One profile per business; carries the legacy plain `modelId` field alongside structured personality/instructions/skills.                                                                                                                                                                                                                          |
| `aiModelRegistry` (`agent-runtime/store.ts`, code-defined) **and** `runtimeModels` (`shared-types/src/index.ts:606`)        | ModelRegistry            | Two independent, only-partially-reconciled registries (§2) — not a single source of truth today.                                                                                                                                                                                                                                                  |
| `BusinessAgentProfileSummary.modelId` (plain field) **and** `ActiveAiModelSummary` (cloud fallback, `cp2_active_ai_models`) | ModelPreference          | Neither is a clean match: the profile field is an unverified legacy pointer; the cloud-fallback record is a single last-resort selector, not a general preference-ranking concept.                                                                                                                                                                |
| —                                                                                                                           | RuntimeHost              | No current equivalent. The owner-node broker's in-memory `InferenceNodePresence` (§3/§4) is the closest _behavior_ (registration + heartbeat), but it is transient, tenant-scoped to inference-job routing, and not a persisted, general-purpose host entity.                                                                                     |
| `InstalledAgentModelSummary` / `cp2_installed_agent_models`                                                                 | RuntimeModelInstallation | Reasonably close match already — one row per (account, user, device, model), tracking file identity, checksum, and installation/compatibility status.                                                                                                                                                                                             |
| `RuntimeSessionSummary` / `runtimeSessions` map (`shared-types/src/index.ts:3360`)                                          | RuntimeSession           | Close match on the surface (session with turn count and status), but scoped only to (business, user) — no device, host, or conversation reference stored on it (§1).                                                                                                                                                                              |
| —                                                                                                                           | ExecutionPlan            | No current equivalent, as expected. `RuntimePlannedAction` (`shared-types/src/index.ts`, part of `RuntimeTurnSummary.plan`) is a same-turn _tool-invocation_ plan (which tool, what input, confirmation state) — a different kind of "plan" than routing a request to a runtime/model, and should not be treated as a precedent for that concept. |

## 7. Known recent regressions relevant to this area — `connectTimeout`

The live, current implementation is in
`services/api/src/inference/model-runtime.ts`. Three distinct timeout
concepts exist in that file, not one unified budget:

- `connectTimeoutMs` (interface fields at lines 74, 287, 600) — a
  **connection-establishment** timeout, implemented at lines 618-621 as a
  plain `setTimeout` that aborts if the TCP/TLS handshake plus initial
  response doesn't begin in time, cleared at lines 642/686 once the response
  starts streaming.
- The health-check path (`healthCheck`, used by both server-side activation
  and the model-activation regression tests —
  `tests/model-activation-runtime.test.ts:544,580,601,633,686`, all passing
  `connectTimeoutMs: 500` explicitly) uses this same field.
- Configuration source: `config.backendInferenceConnectTimeoutMs`
  (`services/api/src/index.ts:68`, `services/api/scripts/run-ai-eval.ts:46`).

I did not find, in this file or its callers, a _separate_ end-to-end request
timeout distinct from `connectTimeoutMs` that the task's phrasing ("a single
unified timeout budget") implies should exist — meaning I cannot confirm from
the code alone whether "one unified budget" is the current intended state or
a target not yet reached. This is a specific, narrow, but real gap in what I
can confirm from static reading alone (see §8) — the two unrelated
`connectTimeout` hits in `services/api/src/redis-client.ts:15` (ioredis
connection pool) and `tests/cp2-postgres-store.test.ts:427` (Postgres pool)
are unrelated to model inference and are noted only to rule them out
explicitly.

## 8. Open questions

- **`resolveExecutionChain()` does not exist in this repository under this or
  any similar name** (§2). Before any target design assumes it as an
  existing building block, its status needs to be confirmed with whoever
  described it — is it planned-but-unbuilt, built in a branch not present in
  this checkout, or a mischaracterization of the existing
  `decideInferenceRoute`/`requestRequiresServerTool` heuristic routing?
- **Two model registries (`aiModelRegistry`, `runtimeModels`) disagree in
  scope** and are reconciled only by a fallback-check order in
  `contextCharacterBudgetForModel`, not a shared source of truth. A target
  design needs to decide whether unifying them is in scope, since a
  `ModelRegistry` concept built against only one would silently miss models
  the other one knows about.
- **The exact "llama.cpp-WebGPU → Transformer.js → WebGPU → WASM → remote
  fallback" priority chain named in this task's brief does not match what
  `docs/inference/grogoni-web-inference-engine.md` currently describes**
  (WebLLM-on-WebGPU vs. Transformers.js-on-WASM, tier-gated). Confirm which
  document is authoritative before a target design assumes a specific
  ordering.
- **`agent.modelId` (the legacy plain field) can point at a model with no
  verified working binding**, while `AgentModelBindingSummary` is the
  verified source of truth. A target design needs to decide whether the
  legacy field is read-only/display-only going forward or still an active
  write path that needs migrating.
- **No conversation-to-runtime-turn persisted link exists** (§1). If a target
  design needs "which runtime answered this conversation" as a queryable,
  durable fact (not reconstructed after the fact), that is net-new work, not
  a gap in an existing field.
- **The owner-node broker's presence state is in-memory only** (§3/§4),
  by explicit design choice documented in `docs/inference/owner-node.md`. Any
  reuse of this channel for a persisted or multi-instance-safe "runtime host"
  concept is a change to that stated design, not a transparent extension.
- **No capability field for "supports tool calling" exists in either model
  registry.** Tool-shaped requests are routed away from models/paths
  structurally (via `decideInferenceRoute`'s keyword heuristic and the
  server-mediated/browser-local pipeline split in
  `docs/architecture/chat-tool-execution-boundary.md`), not via a declared
  per-model capability flag. Confirm whether a target `ModelRegistry` is
  expected to add this as new metadata, since nothing today reads a
  tool-calling flag to make a routing decision.
- **`connectTimeoutMs` could not be confirmed as "one unified timeout
  budget"** from static reading alone (§7) — only as one specific,
  well-defined connection-phase timeout. Whether a broader unified budget
  (covering the full request lifecycle, not just connection) already exists
  elsewhere in the call chain, or is itself a still-open regression, needs
  confirmation from whoever flagged this as a recent regression area, since
  I could not locate the described unification in `model-runtime.ts` or its
  direct callers.
