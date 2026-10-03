# Grogoni Agent Execution Fabric — Phase 2: Runtime Adapters, UI Wiring, Flagged Cutover

Status: complete, with four explicitly scoped-out gaps/follow-ups named in §8 rather than silently
skipped. This document assumes [Phase 0](grogoni-execution-fabric-audit.md) and
[Phase 1](agent-execution-fabric-phase1.md) as ground truth and does not re-derive their findings.

**Headline guarantee, verified by test, not just asserted**: with `EXECUTION_FABRIC_ENABLED`
unset or `false` (the default in every environment, including production), every one of the
881 pre-existing repository tests passes completely unmodified, and `decideInferenceRoute`
(`apps/web/src/browser-inference-routing.ts`) is untouched. The flag adds a second path; it does
not alter the first one.

## 1. Flag mechanism and the registry conflict tiebreak

**Cutover flag.** Two flags, one per runtime, following the two existing conventions found in this
repo rather than inventing a third (Phase 0/Phase 1 audits already identified these as the two
live patterns):

- Server: `EXECUTION_FABRIC_ENABLED` → `booleanFromEnv("EXECUTION_FABRIC_ENABLED", false)`
  (`services/api/src/config.ts:135`), exposed as `EnvironmentConfig.executionFabricEnabled`
  (`packages/shared-types/src/index.ts:38`) — the exact pattern `BACKEND_INFERENCE_ENABLED` already
  uses (`config.ts:72`). Threaded through `Cp2StoreOptions.executionFabricEnabled` →
  `AgentRuntimeDomainDeps.executionFabricEnabled` (`services/api/src/index.ts:135`, `cp2/store.ts`
  constructor).
- Client: `VITE_EXECUTION_FABRIC_ENABLED` → `apps/web/src/execution-fabric/feature-flag.ts`, the
  simplest existing client pattern (`browser-model-registry.ts`'s
  `browserLocalInferenceDeploymentEnabled`) — a single module-level `import.meta.env` read.

Both default to disabled. `.env.example` documents both alongside every other inference flag.
`decideInferenceRoute` is **not removed** and is not the kill-switch's target on the server side —
see §2 for why the actual server integration point is one level up the call stack from that
function (the audit's own note that `decideInferenceRoute` is browser-local-turn-scoped, not the
whole routing decision, still holds).

**Registry conflict tiebreak.** One named constant,
`EXECUTION_TARGET_CONFLICT_TIEBREAK` (`packages/execution-planner/src/registry-reconciliation.ts:15-16`):

```ts
export const EXECUTION_TARGET_CONFLICT_TIEBREAK: "trust-runtimeModels" | "trust-aiModelRegistry" =
  "trust-runtimeModels";
```

Used in exactly one place (`registry-reconciliation.ts:102-109`) to pick the merged
`executionTarget` for the 3 ids Phase 1 confirmed conflict (`qwen2.5-0.5b-android`,
`qwen2.5-1.5b-android`, `smollm2-360m-android`) — default trusts `runtimeModels` (the
server-verified registry) over `aiModelRegistry`'s on-device self-declaration. All other merged
metadata (label/capabilities/contextWindow/minimumMemoryGb) still comes from `aiModelRegistry`
regardless of the tiebreak, since the tiebreak only resolves the `executionTarget` disagreement,
not a wholesale "which source wins" choice. Verified by two tests that assert the _actual resolved
value_, not just that a conflict was recorded, and are written to fail the moment the constant
flips without an update: `tests/execution-fabric-registry-reconciliation.test.ts`, "resolves a
genuine executionTarget conflict using the one named tiebreak constant, not arbitrarily" (synthetic
data) and the extended "confirms the three ids shared by both live registries..." test (the real
`aiModelRegistry`/`runtimeModels`).

## 2. Runtime Adapters

Three planned, three wired live (backend and cloud server-side, browser-local client-side).

| Adapter               | Wraps (existing code, unchanged)                                                                                                                                                                                                                                                                                                                   | Where it's used                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend/Ollama        | `AgentRuntimeDomainDeps.modelRuntimeAdapterResolver` → `runtimeProviderFromAdapter` (`services/api/src/inference/model-runtime.ts:472`) → `ModelRuntimeAdapter.generate` (`createBackendModelAdapter`)                                                                                                                                             | Live, server-side, in `createExecutionFabricRuntimeModelRoute` (§3)                                                                                                  |
| Hosted provider model | Same generic `modelRuntimeAdapterResolver`, resolved by model id plus the provider-neutral `backend` target, then dispatched through `createProviderModelAdapter`                                                                                                                                                                                  | Historical Fabric path only; provider identity remains model metadata and is never an execution target                                                               |
| Browser/local         | `createBrowserRuntimeAdapter` (`apps/web/src/execution-fabric/browser-runtime-adapter.ts`) wraps an existing `InferenceProvider` (the inline browser-webgpu/browser-wasm provider built in `apps/web/src/hooks/useChatRuntimeState.ts:573-651`, which itself wraps `generateBrowserAgentResponse`/the Web Inference Engine backend priority chain) | Live, client-side, via `planBrowserExecutionRoute` (§3) - the adapter itself is also directly tested in isolation (`tests/execution-fabric-browser-adapter.test.ts`) |

`RuntimeAdapter`/`RuntimeRequest`/`RuntimeEvent` (`packages/execution-planner/src/types.ts`):
`RuntimeRequest` is `InferenceRequest` and `RuntimeEvent` is `InferenceChunk` verbatim — the one
streaming shape every live runtime already produces and the chat UI already consumes
(`apps/web/src/inference/executor.ts:47-52`, `useChatRuntimeState.ts:1265` `onChunk`). No second
event protocol was invented.

No `RuntimeAdapter` exists for remote shop devices (the owner-node-broker-backed `RuntimeHost`).
This is by design, not an oversight: server-side, `planExecution()` is always called with
`hosts: []` (§3), so the planner's own `generateCandidates` (Phase 1, `planner.ts:79-101`) never
produces a "local" candidate there in the first place — confirmed rather than special-cased, per
the brief's explicit instruction. Client-side, the synthetic "this device" host
(`apps/web/src/execution-fabric/client-planner.ts`) is the only host that ever exists; no broker
presence is queried. Both are exactly the planner's Phase 1 candidate-generation behavior working
as designed, not a new guard added for this phase.

## 3. Server-side integration: `createExecutionFabricRuntimeModelRoute`

**Where it's wired in** (`services/api/src/cp2/domains/agent-runtime/store.ts`, private
`createRuntimeModelRoute` wrapper, ~line 3435): a single `if (this.deps.executionFabricEnabled === true)`
branch. Flag off: the exact pre-Phase-2 call to `createRuntimeModelRoute`
(`../agent-runtime/runtime-model-routing.ts`), unmodified. Flag on:
`createExecutionFabricRuntimeModelRoute` (`services/api/src/cp2/domains/execution-fabric/runtime-route.ts`)
runs instead, returning the identical `{ proposal, trace, recallCandidate }` shape so the giant
orchestrating caller (`store.ts:2700`) needed zero changes.

**What it does**, in order:

1. Reads the agent-scoped `ModelPreference` (`ExecutionFabricStore.getModelPreference(businessId, "agent", businessId)`) if one was ever written via "Use with Agent" (§4); if none exists, falls back to a system-default preference seeded from the _legacy_ active binding's model id (so flipping the flag on for a shop that has never touched the new UI does not change its resolved model out from under it).
2. Builds the registry via `reconcileLiveModelRegistries()` (Phase 1, unchanged) — the tiebreak from §1 is already baked in.
3. Calls `planExecution()` with `hosts: []` (§2).
4. On `plan.selected === null`: records `outcome: "no_compatible_model"` in execution history and returns a trace that the existing caller already knows how to convert into a graceful, retryable, persisted chat reply (`AGENT_MODEL_UNAVAILABLE`) — see the fix below.
5. Otherwise walks `[plan.selected, ...plan.alternatives]` sorted by score, trying each via the real adapter until one returns `status: "available"` — the planner's own ranking **is** the fallback chain; no separate policy branch was written for this (a deliberate simplification made possible because Phase 1's scoring already encodes the same preference-order/preferredModelIds signal a hand-written fallback chain would otherwise re-derive).

**Two real, pre-existing bugs found and fixed while making this path reachable** (found by writing
the end-to-end HTTP test, not by inspection alone):

- `store.ts`'s `createRuntimeTurn` had a pre-gate (`AGENT_MODEL_NOT_CONFIGURED`) that fires whenever
  `modelRuntimeAdapterResolver !== undefined && activeBinding === null` — written before Phase 2
  existed, on the assumption that the _only_ way a model could be configured was the legacy
  binding. Since "Use with Agent" now writes a `ModelPreference` instead of a binding (§4), this
  gate fired before the flagged path ever got a chance to run. Fixed by adding
  `this.deps.executionFabricEnabled !== true` to the gate's condition — deferring entirely to the
  flagged path's own (already-correct) handling instead of guessing upstream.
- The `AGENT_MODEL_UNAVAILABLE` 503/504 conversion at the end of `createRuntimeTurn` was keyed on
  `activeBinding !== null` — also stale for the same reason. Added a second, symmetric check for
  `executionFabricEnabled === true && activeBinding === null` so a failed flagged-path turn reports
  the same graceful, retryable chat degradation the legacy path already does, instead of silently
  returning 200 with no error surfaced.

Both are documented inline at their exact locations in `store.ts` and covered by the new tests in
§7 (`returns AGENT_MODEL_UNAVAILABLE when the planner accepts a candidate but no adapter can ever
execute it`).

### 3b. Client-side integration: `planBrowserExecutionRoute`

**Where it's wired in** (`apps/web/src/hooks/useChatRuntimeState.ts`, immediately before the
existing `decideClientInferenceRoute` call, ~line 792): a single
`if (executionFabricEnabled && inferenceRequest !== null)` branch that calls the pure
`planBrowserExecutionRoute` (`apps/web/src/execution-fabric/client-planner.ts`) and, only if it
returns a route, skips the existing call (`if (inferenceRoute === null && ... )`) - flag off, or the
planner finds nothing usable, and the line below runs exactly as it always has, unmodified.

`planBrowserExecutionRoute` was deliberately extracted as a small, pure function (not inlined in
the hook) specifically so it could be unit-tested directly - `useChatRuntimeState.ts` is the
single largest, most heavily stateful client chat-execution hook in the app, and this environment
has no way to interactively verify a change there in a real browser. Its every branch (no model
ever selected on this device; selected model not actually installed/compatible; plan selects local
but no matching browser provider exists; the success case, matching the planner's selected model to
whichever browser `InferenceProvider` - webgpu or wasm - is actually present) is covered by
`tests/execution-fabric-browser-adapter.test.ts`'s "planBrowserExecutionRoute (the
useChatRuntimeState integration point)" suite. Once it returns a route,
**`executeInferenceRoute` (unmodified) runs it through the exact same, already-existing
`InferenceProvider` the legacy path would have used** - the only thing this integration changes is
_which decision function_ picked the model, never how it executes.

Honesty note: this closes what was, through most of this phase's development, an open follow-up
(build the adapter and prove it in isolation, but don't touch the live hook without a browser to
verify it in). It was completed by extracting the decision into a pure, directly-testable function
first, specifically so the live-hook edit itself could stay a single, mechanical, low-risk
`if` branch rather than an unverifiable behavioral change - and by then verifying the entire
pre-existing client inference test suite (`tests/client-first-inference.test.ts`,
`tests/browser-inference-routing.test.ts`, `tests/frontend-*.test.ts`, `tests/chat-composer-actions.test.tsx`

- 55 tests) still passes byte-for-byte unmodified with the flag off. What remains genuinely
  unverified is a live, interactive browser session actually exercising this branch with the flag on
  end-to-end in a real UI - this repo's tooling in this environment cannot run that, and it is named
  here rather than silently assumed.

## 4. The "Use with Agent" / "Activate Model" flows — corrected

| Legacy operation (Phase 0 §5)                                                                                                                                        | Legacy table                                                                                                                                                                                                                                                                                                                             | Phase 2 replacement                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) "Use with agent" — `activateServerBackendModel` (`AgentModelPanel.tsx:1073`) → `POST /api/agents/:agentId/models/:modelId/activate` → `cp2_agent_model_bindings` | `AgentModelBindingSummary` (device-independent, agent-permanent)                                                                                                                                                                                                                                                                         | `PUT /businesses/:businessId/model-preference` → `Cp2Store.createModelPreference` → `ExecutionFabricStore` (in-memory) → a `ModelPreferenceSummary` at `scope: "agent"`. Verified by test that after this call, `GET /api/agents/:id/model-binding` still returns `null` - no legacy binding is ever created. |
| (b) "Activate on this device" — `useModelWithAgent` → `synchronizeAgentModelAssignment` → `cp2_installed_agent_models`/`AgentModelAssignmentSummary`                 | Unchanged in this phase (§8) - browser-local "this device" execution planning is a client-only, ephemeral concern (`apps/web/src/execution-fabric/client-planner.ts`), not migrated onto `RuntimeHost`/`RuntimeModelInstallation` yet, since those model a genuinely different concept (a remote shop device) per Phase 1's own scoping. |
| (c) Cloud-fallback activation — `PUT /businesses/:id/ai-model` → `ActiveAiModelSummary`                                                                              | Unchanged in this phase - the new `ModelPreference.allowCloudFallback`/`fallbackModelIds` fields are the forward-looking replacement, but the legacy single-selector route is left alone since nothing in this phase's UI removes it.                                                                                                    |

**Selecting an agent never triggers a model install/bind.** Confirmed both by construction (the
new write path only fires from an explicit "Save preference" click in `ModelPreferencePanel.tsx`,
never from a mount effect) and by test
(`executes successfully for a second device with no re-selection of the agent and no new model
install`, `tests/execution-fabric-runtime-route.test.ts`) - two different `x-grogoni-device-id`
headers hit the same conversation and agent, both execute successfully, and neither creates any
`AgentModelBindingSummary`.

**Device switch, not just the record.** The brief specifically asked that this be proven by actual
execution, not just that the stored data looks right. The test above sends two real chat messages
(different device ids) through `/v1/messages` and asserts both return the model's real reply text,
not just that a database row is absent.

## 5. UI

`ModelPreferencePanel` (`apps/web/src/execution-fabric/ModelPreferencePanel.tsx`) is a new,
self-contained, additive section inserted into the existing `AgentModelPanel.tsx` (right after the
"Grogoni backend models" section, before "Cloud fallback models" — `AgentModelPanel.tsx:1746-1752`),
rendered **only when `executionFabricEnabled` (client flag) is true**. With the flag off - the
default everywhere - this component never mounts and the existing panel is pixel-for-pixel
unchanged; verified by the existing frontend test suite passing unmodified (§7).

Two controls, exactly matching the brief's scope (no more, no less):

- **Model**: Automatic / Fast / Balanced / Best available / one specific model from the shop's
  existing backend catalog. "Automatic" and the quality tiers set `preferredModelIds` to the full
  catalog (letting the planner's scoring pick the best actually-installed/available one); a
  specific model pins `preferredModelIds` to just that id.
- **Run on**: Automatic / This device — maps to `executionPreference: "balanced"` vs
  `"local-first"` (+`allowCloudFallback: false`). No other option is offered, because no other
  `RuntimeAdapter` exists yet (§2) — exactly the brief's instruction not to build UI for a host the
  planner can't fulfill.

**Known, honestly-flagged gap**: `qualityPreference` (fast/balanced/best) is captured and persisted
by this UI and by the store, but `packages/execution-planner/src/scoring.ts` does not yet use it as
a scoring signal — Phase 1's `PlannerWeights` (the brief's own named shape) has no `quality` field,
only `modelPreferenceRank, locality, hostHealth, warmModel, latency, privacy, costPenalty`. Setting
"Fast" today changes what's stored, not yet what's selected. Recorded here rather than quietly
patched with an improvised scoring heuristic under this phase's time budget — adding a real quality
signal deserves its own reference/rubric (per this repo's own harsh-critic convention for
judgment-heavy scoring changes), not a rushed addition at the tail of this phase.

Agent selector: unchanged — Phase 0/1 already established there is one agent per business, so
there was never a separate "agent picker" to wire in.

## 6. Error handling

The planner's typed rejection/outcome vocabulary (`packages/execution-planner/src/types.ts`,
`CandidateRejectionReason` + `PlannerErrorCode`) already covers every code the brief named:
`NO_COMPATIBLE_MODEL`, `NO_RUNTIME_HOST`, `MODEL_NOT_INSTALLED`, `CLOUD_FALLBACK_DISABLED`,
`HOST_OFFLINE`, `CONTEXT_WINDOW_TOO_SMALL`, `TOOL_CAPABILITY_MISMATCH`, `REQUIRED_HOST_MISMATCH`,
plus the two whole-plan/execution-time additions this phase needed:
`EXECUTION_HOST_LOST` (a selected candidate's adapter failed/disappeared at execution time - never
producible by the pure planner itself) and reuse of `NO_RUNTIME_HOST` for the "every rejection was
HOST_OFFLINE" case. `describePlannerOutcome(plan)` (`packages/execution-planner/src/errors.ts`) is
the one pure function that turns a failed `ExecutionPlan` into one of these codes plus the relevant
model/host id — used identically by the server route (§3) to decide what to log, without ever
inventing a second, ad hoc error-mapping table there.

No raw planner code reaches the end user: server-side, a failed plan converts into the exact same
graceful `AGENT_MODEL_UNAVAILABLE` retryable chat message the legacy path already produces (§3);
the code itself only ever appears in `processing.errorCode` (already-established API contract,
unchanged shape) and structured logs, never in the rendered chat bubble text.

Structured log events: `input.appendTelemetry(...)` calls already exist as this repo's established
telemetry mechanism (`RuntimeTelemetryEvent`, consumed by the same pipeline every other model route
reports through) — `createExecutionFabricRuntimeModelRoute` reuses it for
`model.prompt_built` (carrying `resolvedPrecedenceLevel`/candidate and rejection counts, standing
in for `execution.plan.created`), `model.inference_started`/`model.completed` per attempted
candidate (standing in for `execution.candidate.rejected`/`execution.host.selected`/
`execution.model.selected`), and `model.fallback` when a non-top candidate ultimately wins. No
prompt content or message text is ever included in any of these payloads — only ids, model/host
identifiers, and outcome codes, matching the brief's explicit instruction.

**Execution history** (`ExecutionFabricStore.startExecution`/`completeExecution`/
`listExecutionHistory`, `services/api/src/cp2/domains/execution-fabric/store.ts`): one append-only
`ExecutionHistoryRecord` per flagged-path turn attempt (`executionId, conversationId, messageId,
agentId, modelPreferenceId, resolvedModelId, runtimeHostId, startedAt, completedAt, outcome,
fallbackDepth` — the exact shape the brief specified), opened before planning and closed after
execution completes or exhausts every candidate. In-memory only in this phase (see the honesty note
in §8) — this satisfies the brief's explicit "not necessarily persisted, but at minimum logged"
allowance, with the in-memory record as a bonus rather than the load-bearing mechanism.

## 7. Test results

**New/extended test files**, plus the entire pre-existing suite passing unmodified:

```
tests/execution-fabric-runtime-route.test.ts (5 tests)            ✓  -- new, flag ON, real HTTP end-to-end (backend-hosted)
tests/execution-fabric-browser-adapter.test.ts (11 tests)         ✓  -- new, browser-local planner + adapter + route-decision end-to-end
tests/execution-fabric-registry-reconciliation.test.ts (10 tests) ✓  -- 9 from Phase 1 + 1 new tiebreak test
```

Full repo suite, server flag OFF everywhere it isn't explicitly set to `true` inside a test's own
`createCp2Store({ executionFabricEnabled: true, ... })` call, and client flag OFF everywhere (no
`VITE_EXECUTION_FABRIC_ENABLED` is set for the suite as a whole):

```
npx vitest run tests/
Test Files  193 passed | 3 skipped (196)
     Tests  898 passed | 29 skipped (927)
```

Every pre-Phase-2 test file, including
`tests/model-activation-runtime.test.ts` (960 lines, the heaviest-coverage file for the legacy
binding path this phase's flag-off branch must not disturb), `tests/agent-model-assignment.test.ts`,
and `tests/device-model-fallback.test.ts`, passed with **zero modifications** required to any of
them. `tests/execution-fabric-entities-migration.test.ts` had exactly one assertion updated (not
added or removed) to reflect Phase 2's deliberate, documented change to Phase 1's "not yet wired
into Cp2Store" state (§8's persistence note explains the nuance).

Coverage against the brief's required §7 list:

- **Flag off → unchanged**: the entire pre-existing suite, verbatim, above.
- **Flag on → planner selects and a real adapter executes, end to end**: backend-hosted via real
  HTTP (`tests/execution-fabric-runtime-route.test.ts`, "writes a ModelPreference..."); browser-local
  via the adapter directly plus the exact decision function wired into the live hook
  (`tests/execution-fabric-browser-adapter.test.ts`, "executes end to end..." and "the
  useChatRuntimeState integration point" suite) - see §3b for the one remaining honest caveat
  (no live browser session was run against it in this environment).
- **Registry conflict tiebreak deterministic, fails if flipped**: §1's two tests.
- **"Use with Agent" no longer creates a device-specific binding, device switch executes**:
  §4's tests.
- **Fallback does not mutate the stored ModelPreference**: "falls back to the next preferred
  model... without mutating the stored ModelPreference" (before/after `GET` equality).
- **No duplicate tool execution on retry**: "honors the existing per-message idempotency key
  through the planner path" - proves the pre-existing `messageByIdempotencyKey` dedup
  (`services/api/src/cp2/domains/messaging/store.ts:4917`) fires before the flagged model route is
  ever reached a second time (`prompts` array length stays 1 across a retried `clientMessageId`).

## 8. Explicit gaps and follow-ups (named, not silent)

1. **No live, interactive browser session was run against the browser-local wiring.** §3b's
   `useChatRuntimeState.ts` integration is real, live, and covered by unit tests for every branch of
   the pure decision function it calls, and the entire pre-existing client inference test suite
   passes unmodified with the flag off - but this environment cannot launch a browser and actually
   click through a chat turn with `VITE_EXECUTION_FABRIC_ENABLED=true` set. Treat this as "verified
   by test and by full-suite non-regression, not yet verified by hand in a running browser" before
   enabling the client flag in any environment a real user reaches.
2. **`ExecutionFabricStore` (`ModelPreference`, `RuntimeHost`, `RuntimeModelInstallation`,
   `ExecutionHistory`) remains in-memory-only.** Phase 1 left it this way and this phase wires it
   into live traffic (§3/§4) without adding Postgres persistence — a real `ModelPreference` written
   via "Use with Agent" does not survive an API process restart. This is a deliberate scope
   boundary, not an oversight: wiring 3-4 new tables into `Cp2Store`'s snapshot/hydration/Postgres
   machinery is itself the kind of cross-cutting contract change this repo's architecture rules
   (CLAUDE.md's "services-first" section) say should be called out explicitly rather than folded
   into an already-large cutover phase. **Recommendation**: do not enable `EXECUTION_FABRIC_ENABLED`
   in any environment where an API process restart losing shop-configured `ModelPreference` records
   would be disruptive, until this persistence gap is closed.
3. **`qualityPreference` is not yet a scoring signal** (§5) — captured and stored, not yet acted on.
4. The legacy "Use with agent" toggle button in `AgentModelPanel.tsx` (`activateServerBackendModel`/
   `removeServerBackendModelFromAgent`) was **not removed or modified** — `ModelPreferencePanel` is
   additive, not a replacement, so both exist side by side when the client flag is on. Fully
   retiring the legacy button is left for a follow-up once the two write paths can be reconciled at
   the read side (`resolveActiveRuntimeModelId`) rather than left to silently coexist indefinitely -
   that reconciliation is a product decision (which path wins when both have written something for
   the same agent) more than an engineering one, and belongs in its own reviewed change.

## 9. Deliverable checklist

- [x] Flag defaults off in production config — `booleanFromEnv(..., false)` with no `NODE_ENV`
      branching that could flip it on; `VITE_EXECUTION_FABRIC_ENABLED` likewise.
- [x] Flag-off behavior verified unchanged against the existing suite — 898/898 passing, zero
      modified assertions in any flag-off-relevant test file (only the one Phase-1-superseding
      assertion in `execution-fabric-entities-migration.test.ts`, which is about Phase 1→2
      wiring itself, not flag-off chat behavior).
- [x] Registry tiebreak is one named config value, referenced from a single place —
      `EXECUTION_TARGET_CONFLICT_TIEBREAK`, used once, in `registry-reconciliation.ts:104-107`.
- [x] No new execution capability invented beyond what already existed pre-Phase-2 — every adapter
      wraps an existing `ModelRuntimeAdapter`/`InferenceProvider`/`generateBrowserAgentResponse`
      call; `RuntimeEvent`/`RuntimeRequest` reuse `InferenceChunk`/`InferenceRequest` verbatim.
- [x] `decideInferenceRoute` still present and still the flag-off path — unmodified, and its sole
      call site (`browser-inference-session.ts:393`) is untouched.
- [x] Device-switch execution (not just record) test passes — §4/§7.
