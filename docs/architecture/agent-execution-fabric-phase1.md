# Grogoni Agent Execution Fabric — Phase 1: Core Entities + Execution Planner

Status: complete. Nothing in this phase is wired into any live call site — `decideInferenceRoute`
(`apps/web/src/browser-inference-routing.ts`) is unchanged and continues to serve all production
chat/inference traffic exactly as it did before this phase. This document is the required Phase 1
deliverable; it assumes the reader has [`docs/architecture/grogoni-execution-fabric-audit.md`](grogoni-execution-fabric-audit.md)
(Phase 0) as ground truth and does not re-derive its findings.

## 1. What was built

A pure, standalone Execution Planner library plus a minimal set of additive, in-memory-first
entities that sit next to the current routing path — not in front of it.

**New package: `packages/execution-planner`** (694 lines across 6 files, `@grogoni/execution-planner`,
zero runtime dependencies besides `@grogoni/shared-types`). Contains no network calls, no DB access,
and no reference to any Express route, `Cp2Store`, or `OwnerNodeBroker` — every exported function
takes already-fetched plain data and returns a plain result.

| File                                                                                            | Purpose                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`types.ts`](../../packages/execution-planner/src/types.ts)                                     | All planner types: `ModelPreferenceCandidate`, `PrecedenceInput`, `ReconciledModel`, `ModelRegistryConflict`, `RuntimeHostCandidateInput`, `CandidateRejectionReason`, `ExecutionCandidate`, `PlannerWeights` (+ `defaultPlannerWeights`), `ExecutionPlan`, `PlannerConstraints`, `PlannerInput`. |
| [`precedence.ts`](../../packages/execution-planner/src/precedence.ts)                           | `resolveModelPreference()` — the one, central implementation of request > conversation > agent > user > system.                                                                                                                                                                                   |
| [`registry-reconciliation.ts`](../../packages/execution-planner/src/registry-reconciliation.ts) | `reconcileModelRegistries()` — read-only merge of the two disagreeing model registries into one `ModelRegistry` view (§2 below).                                                                                                                                                                  |
| [`scoring.ts`](../../packages/execution-planner/src/scoring.ts)                                 | `scoreCandidate()` — pure function of `(candidate, preference, weights, host)`; no magic numbers, every baseline table named.                                                                                                                                                                     |
| [`planner.ts`](../../packages/execution-planner/src/planner.ts)                                 | `planExecution()` and each of its 8 named stages, individually exported.                                                                                                                                                                                                                          |
| [`index.ts`](../../packages/execution-planner/src/index.ts)                                     | Public re-exports.                                                                                                                                                                                                                                                                                |

**New shared types** appended to `packages/shared-types/src/index.ts` (lines 3793–3872, after
`AgentRuntimeReadiness`): `ModelExecutionPreference`, `ModelQualityPreference`,
`ModelPreferenceScope`, `ModelPreferenceSummary`, `RuntimeHostTrustLevel`, `RuntimeHostSummary`,
`RuntimeModelInstallationStatus`, `RuntimeModelInstallationSummary`.

**New server-side domain (not a `Cp2Store` slice): `services/api/src/cp2/domains/execution-fabric/`**
(280 lines across 3 files) — the only place that touches real data sources on the server:

| File                                                                                             | Purpose                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`registry-adapter.ts`](../../services/api/src/cp2/domains/execution-fabric/registry-adapter.ts) | `reconcileLiveModelRegistries()` — feeds the real `aiModelRegistry` and `runtimeModels` into the pure reconciliation function. The only file that imports both real registries for this purpose.                                    |
| [`store.ts`](../../services/api/src/cp2/domains/execution-fabric/store.ts)                       | `ExecutionFabricStore` — in-memory CRUD for `ModelPreferenceSummary`, `RuntimeHostSummary`, `RuntimeModelInstallationSummary`. Not imported by `cp2/store.ts`, `postgres-store.ts`, or `routes.ts` anywhere (verified by test, §4). |
| [`host-presence.ts`](../../services/api/src/cp2/domains/execution-fabric/host-presence.ts)       | `runtimeHostCandidateInput()` — bridges a durable `RuntimeHostSummary` with `OwnerNodeBroker.listPresence()` to produce the planner's `RuntimeHostCandidateInput`, computing `online` at call time and never persisting it.         |

**New additive migration:** [`infra/db/migrations/060_execution_fabric_entities.sql`](../../infra/db/migrations/060_execution_fabric_entities.sql)
(87 lines) creates `cp2_model_preferences`, `cp2_runtime_hosts`, `cp2_runtime_model_installations`
following the repo's existing normalized envelope-table convention (`entity_id`/`business_id`/
`account_id`/`user_id`/`parent_id`/`record jsonb`/`updated_at`). Paired scoped rollback at
[`infra/db/rollbacks/060_execution_fabric_entities.down.sql`](../../infra/db/rollbacks/060_execution_fabric_entities.down.sql).
Neither table is referenced anywhere outside this new domain — the migration exists so the schema
is ready, not because anything reads or writes it yet.

**Tests:** 46 new tests across 4 files (full results in §5).

## 2. Model registry reconciliation

The Phase 0 audit (§2/§6) found two model registries that genuinely disagree:
`aiModelRegistry` (`services/api/src/cp2/domains/agent-runtime/model-catalog.ts:102`, an array) and
`runtimeModels` (`packages/shared-types/src/index.ts:1003`, a keyed object). `reconcileModelRegistries()`
does **not** merge or migrate either underlying source — it is a read-only view built fresh on every
call, for the planner only.

**Resolution logic** (`registry-reconciliation.ts:30-93`):

- A model id present in only one source resolves with `sources: ["aiModelRegistry"]` or
  `sources: ["runtimeModels"]` and no conflict — a gap is not a conflict.
- A model id present in **both** sources is checked on three fields — `executionTarget`,
  `contextWindow`, `availability` — and any actual disagreement is pushed to `conflicts`. The model
  still resolves (as `sources: ["aiModelRegistry", "runtimeModels"]`, preferring the richer
  `aiModelRegistry` metadata) — a conflict is surfaced for an operator to review, never silently
  picked for the caller.
- `contextWindow` is only flagged when `aiModelRegistry`'s value is non-null; a null value there
  (a genuinely unknowable context window, e.g. `grogoniclaw-local`) is a gap, not a disagreement.

**The confirmed real conflict.** Direct inspection of both live registries found exactly three
shared ids — `qwen2.5-0.5b-android`, `qwen2.5-1.5b-android`, `smollm2-360m-android` — and all three
produce a genuine `executionTarget` conflict: `aiModelRegistry` declares each `provider: "local"`
(a downloadable, on-device GGUF file the shopkeeper installs and runs themselves), while
`runtimeModels` declares the identical id `provider: "ollama"` / `executionTarget: "backend"` (a
model the platform itself hosts and calls over the network). These are not almost-the-same
records — a caller trusting one source over the other would route the exact same model id to a
completely different execution location. This is proven by a live test
(`tests/execution-fabric-registry-reconciliation.test.ts`, _"confirms the three ids shared by both
live registries produce a real executionTarget conflict"_) that calls the real
`reconcileLiveModelRegistries()`, not synthetic fixtures — it fails the moment either registry is
edited to actually agree, which is intentional: it exists to catch silent drift, not just to pass
once.

**Known limitation, flagged not fixed.** A model resolved only from `runtimeModels` always gets
`capabilities: []` (`registry-reconciliation.ts:117`, `reconciledFromRuntimeModel`) because
`RuntimeModelDefinition` carries no capability list today — `aiModelRegistry` is the only source
with real capability data. Practically: a backend-only model can never satisfy
`requiresToolCalling` in the planner's filter stage (§3), since `TOOL_CAPABILITY_MISMATCH` checks
`capabilities.includes("tool-routing")`. This is a genuine data-completeness gap in the source
registries themselves, not something reconciliation should paper over — recording it here rather
than inventing a guessed capability list.

## 3. The Execution Planner

`planExecution()` (`planner.ts:35-55`) runs the 8 named stages in order, each individually exported
so a test can exercise one stage without running the whole pipeline:

```
resolveAgent → resolveModelPreference → discoverHosts → generateCandidates →
filterCandidates → scoreCandidates → selectCandidate → buildExecutionPlan
```

`resolveAgent` has no function body of its own: by the time `PlannerInput` is constructed, the
caller has already resolved which agent this plan is for and used that to select which preference
records and hosts to pass in. There is nothing left for a pure function to "resolve" from an agent
id alone without doing the DB lookups this package deliberately never performs — the same reasoning
applies to `discoverHosts`, which is `input.hosts` passed straight through (`planner.ts:60-62`).

**Precedence** (`precedence.ts`) is centralized in one function, `resolveModelPreference()`: request
overrides conversation, conversation overrides agent, agent overrides user, user overrides system.
`system` is the only mandatory level; every level above it is `| null` ("nothing set here, fall
through"), so the function always returns a result.

**Candidate generation** (`planner.ts:79-101`, `generateCandidates`) enumerates every (host,
installed model) pair from `input.hosts`, plus one host-independent candidate per registry entry
whose `executionTarget` is `"backend"` or `"cloud"` (the platform's own private inference and the
operator-configured cloud fallback, neither tied to a specific device). Nothing is filtered here —
every enumerable pairing becomes a raw candidate so the next stage can reject it with a visible,
specific reason instead of it never having existed.

**Filtering** (`planner.ts:103-170`, `filterCandidates` / `rejectionReasonFor`) rejects with one of
7 machine-readable reasons, checked in this order: `REQUIRED_HOST_MISMATCH` (a hard
`requiredHostId` constraint that doesn't match), `HOST_OFFLINE`, `CLOUD_FALLBACK_DISABLED`,
`TOOL_CAPABILITY_MISMATCH`, `CONTEXT_WINDOW_TOO_SMALL`, `INSUFFICIENT_MEMORY`. (`MODEL_NOT_INSTALLED`
is reserved in the type union for a future caller that wants to say "no local candidate exists at
all" — the current filter never needs it because `generateCandidates` only ever produces candidates
for models a host has actually installed.)

**Scoring** (`scoring.ts`) is a pure function of `(candidate, preference, weights, host)`. Every
weight lives in the named `PlannerWeights` object (`modelPreferenceRank`, `locality`, `hostHealth`,
`warmModel`, `latency`, `privacy`, `costPenalty`) with a documented `defaultPlannerWeights` — no
inline magic numbers anywhere in the scoring path. Fixed per-execution-target baseline tables
(`latencyBaselineByTarget`, `privacyBaselineByTarget`, `costByTarget`) are named and visible in one
place rather than scattered through the function. `scoreCandidate` returns both the total `score`
and a full `scoreBreakdown` per weight, so a caller (or a test) can see exactly which signal moved
the number.

**Selection** (`planner.ts:203-212`, `selectCandidate`) picks the highest score; ties break
deterministically by `hostId` then `modelId`, ascending — the same input always produces the same
selection, never an array-order artifact.

**Output** (`planner.ts:214-229`, `buildExecutionPlan`) — an `ExecutionPlan` carrying the resolved
preference, which precedence level it came from, the selected candidate (or `null` if none
survived filtering), every other scored alternative, and every rejected candidate with its reason.
This `ExecutionPlan` is the full deliverable of this phase — no `RuntimeAdapter`, no streaming, no
actual inference execution exists or was attempted.

## 4. Swappability and the "Use with Agent" / "Activate Model" mapping

The Phase 0 audit (§5) found "Use with agent" / "Activate on this device" / cloud-fallback
activation are three genuinely separate operations writing three separate tables, reconciled only
at read time by `resolveActiveRuntimeModelId`. Phase 1's entities are designed to be the eventual
target shape for those three operations, without changing any of them yet:

| Phase 0 operation                                           | Current table                                               | Phase 1 target entity                                                                                               |
| ----------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| (a) "Use with agent" — server-backend model binding         | `cp2_agent_model_bindings` (`AgentModelBindingSummary`)     | Would become: bind a `ModelPreference` at `scope: "agent"` naming that model as `preferredModelIds[0]`              |
| (b) "Activate on this device" — device-local GGUF readiness | `cp2_installed_agent_models` (`InstalledAgentModelSummary`) | Would become: `RuntimeModelInstallation` on a `RuntimeHost` representing that device                                |
| (c) Cloud-fallback model activation                         | `cp2_active_ai_models` (`ActiveAiModelSummary`)             | Would become: a `ModelPreference` with `allowCloudFallback: true` and the cloud model in `fallbackModelIds`         |
| — (no current equivalent)                                   | —                                                           | `RuntimeHost` — the audit found no `devices` table or equivalent; this is genuinely net-new, not a migration target |

This mapping is documentation only in this phase — none of (a), (b), (c) were touched, and no
migration path between the legacy tables and the new ones was written. That cutover is Phase 2.

The swappability invariants this design is built around — proven by tests, not asserted in prose —
are: changing which agent a request targets does not mutate any `RuntimeModelInstallation`;
changing a `ModelPreference` does not mutate the `Agent`/business profile; registering or changing
a `RuntimeHost` mutates neither the `Agent` nor an existing `ModelPreference`; and a new
device/client accessing an existing agent needs no new agent record and installs no model unless
installation is explicitly requested for that device.

## 5. Test results

All 46 new tests pass, plus the full 881-test pre-existing suite (191 files, 29 pre-existing skips)
with zero regressions:

```
tests/execution-planner.test.ts (24 tests)                          ✓
tests/execution-fabric-registry-reconciliation.test.ts (9 tests)    ✓
tests/execution-fabric-store.test.ts (10 tests)                     ✓
tests/execution-fabric-entities-migration.test.ts (3 tests)         ✓

Test Files  4 passed (4)
     Tests  46 passed (46)
```

```
npx vitest run tests/
Test Files  191 passed | 3 skipped (194)
     Tests  881 passed | 29 skipped (910)
```

Coverage against the brief's required list:

- **Swappability** (4 tests, `execution-fabric-store.test.ts`, "swappability invariants" describe
  block): changing agent doesn't mutate installation; changing model preference doesn't mutate
  agent profile; changing/adding a runtime host mutates neither agent profile nor an existing
  preference; a new device needs no new agent record and installs nothing unless asked.
- **Precedence** (`execution-planner.test.ts`): each of request/conversation/agent/user beats every
  lower level, tested in isolation, plus system-as-fallback.
- **Planner behavior** (`execution-planner.test.ts`): preferred model available → selected;
  preferred unavailable → falls to next preferred; local-first vs. cloud-first changes selection
  (isolated with a dedicated weights fixture, §7 note below); cloud fallback disabled excludes
  cloud candidates even when available; offline host excluded (`HOST_OFFLINE`); insufficient RAM
  excluded (`INSUFFICIENT_MEMORY`); tool-capability mismatch excluded (`TOOL_CAPABILITY_MISMATCH`);
  required-host (hard, empty plan if unmet) vs. preferred-host (soft, a scoring bonus) tested as
  different behaviors; warm-model affinity changes score when quality is otherwise close; a weight
  change alone changes which candidate is selected (determinism requirement).
- **Registry reconciliation** (`execution-fabric-registry-reconciliation.test.ts`): single-source
  resolution (both directions), a genuine `executionTarget`/`contextWindow`/`availability` conflict
  surfaced correctly, a mere gap correctly not treated as a conflict, determinism on repeated calls,
  and the two tests against the real live registries described in §2.

## 6. Deliverable checklist

- **No existing routing behavior changed for live traffic.** `decideInferenceRoute` and
  `apps/web/src/browser-inference-routing.ts` were not modified. `ExecutionFabricStore` is not
  imported by `services/api/src/cp2/store.ts`, `postgres-store.ts`, or `routes.ts` — verified by a
  dedicated test (`execution-fabric-entities-migration.test.ts`, _"is not yet wired into
  Cp2Store/postgres-store.ts"_), not just asserted here.
- **All must-pass §4 tests pass.** Confirmed above (§5) — 46/46, plus the full pre-existing suite
  unaffected (881/881, 29 pre-existing skips untouched).
- **Model registry conflicts listed, not silently resolved.** The 3-id `executionTarget` conflict is
  documented in §2 with exact values and is asserted by a test that reads the real registries, not
  a fixture — it will fail (correctly) if the conflict is ever fixed without updating this doc.
- **No persistent heartbeat/liveness column added anywhere.** `RuntimeHostSummary` and the
  `cp2_runtime_hosts` table carry `brokerNodeId` (an identity pointer) only; `online`/
  `lastHeartbeatAt` exist nowhere in the schema or the type, confirmed by both a unit test
  (`execution-fabric-store.test.ts`, _"no liveness field"_) and a migration-content test
  (`execution-fabric-entities-migration.test.ts`, asserting `last_heartbeat`/`online boolean`/
  `lastHeartbeatAt` are all absent from the SQL). Liveness is computed only in
  `host-presence.ts`'s `runtimeHostCandidateInput()`, from `OwnerNodeBroker.listPresence()`, at call
  time, never written back.
- **Migrations additive only.** No `alter table`, `drop table`, or `drop column` appears in
  `060_execution_fabric_entities.sql` (asserted by test). Honesty note: "runs clean against the
  existing database" was verified using this repository's own established convention — a static
  test asserting exact SQL content (matching `tests/agent-business-runtime-migration.test.ts`'s
  existing pattern) plus a manual parenthesis/quote balance check — not by executing the migration
  against a live Postgres instance, since none was available in this dev environment. The same
  caveat applied to every prior migration added in this session.

## 7. Test-design notes worth recording

Two tests initially failed for reasons worth keeping on record, since both point at real planner
behavior rather than test bugs that happened to be papered over:

- The local-first/cloud-first test originally failed because unrelated signals
  (`modelPreferenceRank` asymmetry, and locality/cost/privacy baselines that already favor local
  execution) drowned out the policy signal itself. It was fixed by isolating the assertion with a
  dedicated weights fixture that zeroes every weight except `locality`, and removing both candidate
  models from any preference list — proving the `executionPreference` signal itself works, without
  requiring it to win against every other realistic signal at once (which it should not always do).
- The weight-changes-selection test originally failed because the "cheap but unpreferred" model
  used `executionTarget: "local"` while the test passed `hosts: []` — local candidates require a
  real host installation, so it was never generated as a candidate at all. Fixed by making it a
  `"backend"` model, which (per `generateCandidates`, §3) is host-independent.

## 8. Explicit non-goals confirmed unattempted

Per the brief: no wiring into the live chat/inference path; no UI changes anywhere; no
`RuntimeAdapter`, streaming, or actual inference execution; no cross-device remote execution,
extended WebSocket protocol, execution leasing, or idempotency keys; no merging or migrating the
two model registry tables themselves (only the read-side reconciliation adapter exists); no removal
or modification of `decideInferenceRoute`; no changes to the `connectTimeout` inference fetch path.
All confirmed by direct diff review — no file outside `packages/execution-planner`,
`services/api/src/cp2/domains/execution-fabric/`, `packages/shared-types/src/index.ts` (additive
only), `services/api/package.json` (one dependency line), the new migration/rollback pair, and the
4 new test files was touched.
