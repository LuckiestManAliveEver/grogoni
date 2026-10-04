# Durable Execution Plane — Repository Audit (Phase 0)

Date: 2026-09-21

Read-only audit performed before any implementation in this change. Every claim is anchored to a
file (and line/section, where useful). This complements, and does not replace,
[`grogoni-execution-fabric-audit.md`](grogoni-execution-fabric-audit.md) (the agent/model/device coupling
audit from a prior change) — this document focuses specifically on what already exists for durable,
resumable, fenced task execution, and what this change adds on top of it.

## 1. What already exists (do not rebuild)

Grogoni already has almost every structural piece the "Google AX-inspired durable execution plane"
brief asks for, under repository-native names. The single biggest risk in this change was building
a second, parallel version of something that already exists — this section exists to make that
impossible.

| Spec concept                                         | Existing Grogoni implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task                                                 | `cp2_conversations` (a conversation _is_ the unit of runtime execution; `taskId` throughout the handoff protocol is literally the conversation id — see `packages/shared-types/src/runtime-handoff.ts:10-14`)                                                                                                                                                                                                                                                                                                              |
| Agent / Model / Runtime binding                      | `cp2_native_runtime_agents`, `cp2_native_runtime_models`, `cp2_native_runtime_bindings`, `cp2_native_runtime_binding_models` (migration `063_native_runtime_bindings.sql`), owned by `NativeRuntimeBindingStore`                                                                                                                                                                                                                                                                                                           |
| Execution host                                       | `cp2_native_execution_hosts` (same migration family)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| RuntimeHandoff (transfer of execution authority)     | `cp2_runtime_transfers` (migration `085_runtime_transfers.sql`) + `RuntimeHandoffDomain.beginTransfer/completeTransfer/failTransfer` — a real state machine (`PENDING → CHECKPOINTING → CHECKPOINTED → TARGET_ACTIVATING → RESTORING → VERIFYING → COMPLETED`, or `FAILED` from any nonterminal state)                                                                                                                                                                                                                     |
| Checkpoint (resumable execution snapshot)            | `cp2_runtime_handoffs` (migration `083_runtime_handoff_protocol.sql`) — **confusingly named `RuntimeHandoff` in this codebase's own vocabulary**, but semantically the spec's `RuntimeCheckpoint`: immutable, versioned (`schemaVersion`, `checkpointVersion`), contains goal/currentState/completedActions/decisions/rejectedPaths/pendingActions/nextAction/relevantContext (references, not copies)/artifacts/tests/runtime ref. DB-enforced immutable via an `UPDATE` trigger (`cp2_runtime_handoffs_immutable_guard`) |
| Task head (authoritative current-checkpoint pointer) | `cp2_runtime_task_heads` — one row per task, `activeHandoffId` + `nextCheckpointVersion` monotonic counter, optimistic-concurrency guarded (`expectedHandoffId` on every mutating call)                                                                                                                                                                                                                                                                                                                                    |
| Runtime instance (per-task executor pointer)         | `cp2_runtime_task_instances` — `activeHandoffId`, `status` (`STARTING\|READY\|RUNNING\|DEGRADED\|FAILED\|STOPPED`), used for drift detection (`resolveHandoff().isRuntimeStale`)                                                                                                                                                                                                                                                                                                                                           |
| Idempotency primitive                                | `cp2_runtime_operation_dedup` — generic `(operationType, idempotencyKey)` dedup, used by every mutating `RuntimeHandoffDomain` method via `withIdempotency()`                                                                                                                                                                                                                                                                                                                                                              |
| Capability gateway                                   | `runtimeToolRegistry` (`packages/tool-core/src/index.ts`) + `Cp2Store.createRuntimeTurn`/`executeRuntimeAction` — one canonical registry, one execution pipeline, every surface (chat, MCP, browser, storefront) converges on it (`docs/architecture/governed-tool-runtime.md`, `capability-first-runtime.md`)                                                                                                                                                                                                             |
| Context runtime                                      | `retrieveAgentContext` / `assembleAgentInferenceMessage` (`docs/architecture/context-semantic-runtime.md`) — authorized-before-touched, task-narrowed, model-aware-budgeted, precedence-ordered assembly                                                                                                                                                                                                                                                                                                                   |
| `.grogoni.com` artifact                              | `docs/agents/grogoni-agent.schema.json` — already declares `capabilities`, `tools`, `modelRequirements`, `executionRequirements`, `permissions`, `memory`                                                                                                                                                                                                                                                                                                                                                                  |
| Single-writer execution                              | CP2Store is a single in-memory, synchronously-mutated store (one authoritative API writer by explicit deployment policy — `docs/single-instance-store-ceiling.md`); `RuntimeHandoffDomain.acquireTurn`'s `executingTasks` set gives per-task mutual exclusion between an in-flight turn and a handoff/transfer                                                                                                                                                                                                             |
| Retired Execution Fabric                             | `infra/db/migrations/065_retire_execution_fabric.sql` — archives every legacy selection-preference/host/model row into the native runtime graph as `inactive`/`draft`/`unavailable`, then the source tables are dropped. **No parallel execution engine exists in this codebase today; nothing to remove for that reason.**                                                                                                                                                                                                |

Read in full before this change: `docs/architecture/runtime-handoff-protocol.md`,
`docs/runtime/runtime-handoff.md`, `docs/architecture/native-agent-model-runtime.md`,
`docs/architecture/capability-first-runtime.md`, `docs/architecture/governed-tool-runtime.md`,
`docs/architecture/context-semantic-runtime.md`, `docs/architecture/resource-isolation.md`, and the
full implementation of `services/api/src/cp2/domains/runtime-handoff/store.ts` (1715 lines) and
`services/api/src/cp2/domains/agent-runtime/store.ts`'s `createRuntimeTurn`/`executeRuntimeTurn`/
`confirmRuntimeAction` pipeline.

## 2. Current chat execution path (traced)

`POST /businesses/:id/runtime/turns` → `Cp2Store.createRuntimeTurn` →
`RuntimeHandoffDomain.acquireTurn` (per-task mutual exclusion against a concurrent turn or an
in-progress handoff) → `AgentRuntimeDomain.executeRuntimeTurn`:

1. `requireAuthorizedSession` (auth)
2. `resolveActiveRuntimeModelId` (binding resolution: verified `AgentModelBindingSummary` → legacy
   profile `modelId` → cloud fallback, in that order — `services/api/src/cp2/domains/agent-runtime/store.ts:2037`)
3. `retrieveAgentContext` (context resolution: authorized, task-narrowed, budgeted —
   `context-semantic-runtime.md`)
4. Deterministic proposal builders (document import / messaging / network / commerce / context
   scripts) or `createRuntimeModelRoute` (model invocation) produce a `RuntimeToolProposal`
5. `enforceAgentPolicy` + role check (authorization) — server-side, the model never authorizes
   itself
6. Confirmation gate for risky/mutating tools (mints a token, execution pauses)
7. `executeRuntimeAction` → `executeRuntimeCapability` → the canonical domain operation (capability
   gateway; same method every REST endpoint uses)
8. `storeRuntimeTurn` persists the turn (plan, verification, model trace, telemetry)
9. Back in the outer wrapper: `RuntimeHandoffDomain.checkpointAfterTurn` writes a new promoted
   checkpoint, `acquireTurn`'s release runs in `finally`

Telemetry today (`RuntimeTelemetryEvent`, in-memory on the turn, not a separate durable table) fires
at exactly 9 distinct lifecycle points: `turn.received`, `turn.rate_limited`, `context.built`,
`intent.routed`, `plan.created`, `verification.completed`, `confirmation.required`, `tool.executed`,
`response.generated`. This is the instrumentation seam this change extends (§3 below).

## 3. Agent/model binding path

Fully documented in `docs/architecture/native-agent-model-runtime.md` and
`docs/architecture/grogoni-execution-fabric-audit.md`. Summary: `resolveActiveRuntimeModelId` prefers
a server-verified `AgentModelBindingSummary` (health-checked at activation time), falls back to the
agent profile's legacy `modelId` field, then to the cloud-fallback `ActiveAiModelSummary`. The
native runtime graph (`cp2_native_runtime_bindings` etc.) is the authoritative execution-chain
resolver for anything that goes through `RuntimeHandoffDomain`/handoffs; `resolveActiveRuntimeModelId`
is the (older, still-load-bearing) resolver for plain chat turns. Both converge at
`createRuntimeModelRoute` → `ModelRuntimeAdapter`.

## 4. Runtime host resolution

`NativeRuntimeBindingStore` ranks compatible models then execution hosts
(`docs/architecture/native-agent-model-runtime.md`'s "Runtime graph" diagram). Execution targets are
`backend | remote-shop-device` today (`browser-local`/`installed-app` retired per
`ADR-device-independent-runtime-and-registry-discovery.md` — `native-agent-model-runtime.md`'s own
header notes this). `RuntimeHandoffDomain.hostAvailability` re-derives per-host capability
(supported/configured/healthy/reachable/active) at handoff-decision time rather than trusting a
cached flag.

## 5. Existing handoff implementation

See §1's table. `RuntimeHandoffDomain` (`services/api/src/cp2/domains/runtime-handoff/store.ts`) is
mature: idempotent swap/rollback/resume/offline-sync/merge, optimistic concurrency
(`requireMatchingHead`/`expectedHandoffId`), an immutable checkpoint chain with causal ancestry
(`parentHandoffId`, `mergedFromHandoffIds` for merges), and a separate mutable transfer-progress
table for cross-host handoffs. **What it does not have**, confirmed by full-file read and repo-wide
grep, and what this change adds:

- No durable, append-only, fine-grained execution _event log_ distinct from the checkpoint chain —
  `recordAuditEvent` calls exist (`runtime.handoff_requested`, `.checkpoint_created`, etc.) but are
  a generic cross-domain audit sink, not a per-task, sequence-numbered, typed event table queryable
  for recovery/diagnosis. Zero hits repo-wide for `task_execution_events`, `execution_events`, or
  `task_events` (SQL, TS, or docs).
- No explicit numeric fencing token. Safety today comes from (a) single-writer-process synchronous
  mutation (no interleaving is possible _within_ one process — see the class docstring at
  `runtime-handoff/store.ts:11-20`) and (b) optimistic concurrency via `expectedHandoffId`/
  `checkpointVersion` on every _handoff-domain_ mutation. **One real, concrete gap**:
  `checkpointAfterTurn` (called after literally every ordinary chat turn, `runtime-handoff/store.ts:206`)
  performs **no** staleness check at all before promoting its checkpoint — it unconditionally trusts
  that the task head it read at the start of the (possibly long, `await`-laden) turn is still the
  right parent. Since `acquireTurn`'s mutual-exclusion lock is held for the _entire_ async turn
  duration today, this is not currently exploitable by another turn or transfer in the same process
  — but it is exactly the seam a genuinely distributed/local executor (a `LocalHandoffHost`, not yet
  shipped per `runtime-handoff.md`: _"This checkout does not ship a full LocalHandoffHost executor or
  installer"_) would need, and it is exactly what the spec's mandatory fencing test requires being
  able to demonstrate explicitly rather than by argument. This change adds an explicit fence token.
- No runtime inspection API beyond `GET /v1/runtime/:taskId` (resolve) and `GET /capabilities`. No
  `events`/`inspect`/`cancel` endpoints.

## 6. Existing context authorization

`retrieveAgentContext` filters by `status`/`deletedAt`/`accessRules.audiences`/`customerVisible`
_before_ any content is read, narrows by recognized intent, and re-derives caller audience from the
authenticated session's real business-membership role on every call (not cached). This already
satisfies "never assume authorization valid before suspension remains valid forever" for the
_ordinary chat_ path, since every turn re-resolves context from scratch. The still-open gap is
narrower than the spec implies: a _resumed_ task (post-handoff) re-enters through
`resolveHandoff`/`createRuntimeTurn` exactly the same way a fresh turn does — there is no cached,
unauthorized context object anywhere on a checkpoint (`relevantContext` is references only, per
`RuntimeContextReference`, never content).

## 7. Existing MCP/tool execution

`services/api/src/mcp/routes.ts` — `grogoni.runtime_turn`/`grogoni.confirm_runtime_action` call
`store.createRuntimeTurn` with the same arguments a REST caller would use; no parallel context or
tool-resolution path. `RuntimeToolDefinition` (`packages/tool-core/src/index.ts`) carries
`description`/`inputSchema`/`mcpExposable` (all `false` today) per `governed-tool-runtime.md`.
Deny-by-default is real: `mcpExposable: false` on all 20 registry entries means MCP cannot invoke any
of them directly today; it can only drive the same governed `createRuntimeTurn` pipeline chat uses.

## 8. Duplicated / dead abstractions found

None beyond what migration `065_retire_execution_fabric.sql` already retired. No second tool
registry, no second checkpoint mechanism, no second runtime resolver. `resolveExecutionChain()` (a
name referenced in some historical task briefs) does not exist under this or any similar name
anywhere in the repository — confirmed by repo-wide grep, consistent with the prior
`grogoni-execution-fabric-audit.md`'s same finding. This is not a gap to fill; it is a name that was
never real in this codebase, and no new abstraction was invented to match it.

## 9. Confirmed gaps this change fills

1. **No durable, sequence-numbered, typed execution event log.** Added:
   `cp2_runtime_execution_events` (migration `087_runtime_execution_events.sql`), append-only,
   `(task_id, sequence_number)` uniquely constrained, `event_type` checked against the spec's
   taxonomy plus one addition (`EXECUTION_FENCE_REJECTED`, for the stale-commit case below).
2. **No explicit fencing token protecting `checkpointAfterTurn`.** Added: `fenceToken`/`executionId`
   on `RuntimeTaskInstance` (additive JSON fields, no migration needed — same jsonb `record` column
   every other optional field already lives in), minted on every rebind (`performSwap`,
   `completeTransfer`, `resume`); `acquireTurn` now returns the fence token in effect at turn start,
   `checkpointAfterTurn` now rejects (`STALE_EXECUTION_FENCE`, 409) a checkpoint promotion whose
   fence token no longer matches the task's current one, instead of silently overwriting newer state.
3. **No runtime inspection surface beyond resolve/capabilities.** Added:
   `GET /v1/runtime/:taskId/events`, `GET /v1/runtime/:taskId/inspect`,
   `POST /v1/runtime/:taskId/cancel`. `suspend`/`resume`/`retry`/`rollback` reuse the existing
   `confirmation.required` telemetry state (already a real suspend point) and the existing
   `POST /v1/runtime/:taskId/resume` route — no redundant endpoints were added for concepts the
   protocol already names.
4. **`commerce.checkout` (the one non-idempotent, order-creating runtime capability reachable from
   chat) has no idempotency key wired through it**, unlike `messaging.send`
   (`capabilities.ts:447`, `idempotencyKey: \`runtime-message:${input.action.id}\``, which
`MessagingDomain`already deduplicates on`(conversationId, idempotencyKey)`). Added: an optional
`idempotencyKey`on`CommerceDomain.createUnifiedCheckout`, durable (stored on the already-persisted
`UnifiedCheckoutSummary`row, no new table), wired from`commerce-capabilities.ts`using the same`action.id`-based key messaging already uses. This directly satisfies the mandatory "side-effect
   test" (an order must not be created twice because execution resumed).
5. **`.grogoni.com` artifacts cannot declare `runtime.resumable`/`runtime.portable`/`context.recipe`.**
   Added as additive, optional, non-breaking schema properties (schema stays `schemaVersion: "1"`;
   `additionalProperties: false` objects only ever reject genuinely unknown keys, and no existing
   required field changed).

## 10. What this change deliberately does not do

- Does not introduce a second checkpoint, handoff, or tool-registry mechanism.
- Does not touch the retired-Execution-Fabric migration or resurrect any of its tables.
- Does not add Kubernetes, a queue broker, Redis, or any new infrastructure dependency — every
  addition is an in-process Map plus a Postgres table, matching every existing `RuntimeHandoffDomain`
  table exactly (`entity_id`/`business_id`/`account_id`/`user_id`/`parent_id`/`record jsonb`/
  `updated_at` generic-entity shape, generated columns for hot lookups, `if not exists`/additive DDL).
- Does not change `browser-local`/`installed-app` execution target semantics (already retired,
  out of scope).
- Does not add a second model-invocation instrumentation point: `runtime-model-routing.ts` already
  calls the passed-in `appendTelemetry` closure with `model.inference_started`/`model.completed`
  once per fallback attempt (with real `fallbackIndex` metadata) — piggybacking the durable event
  mapping onto the existing `appendTelemetry` closure (rather than adding a second, cruder call at
  `createRuntimeModelRoute`'s call site, which was tried and reverted after it broke
  `tests/zero-setup-native-runtime.test.ts`'s per-attempt fallback assertion) means MODEL_INVOCATION_*
  events are emitted with the same per-attempt fidelity as the pre-existing telemetry, for free.
  `TOOL_STARTED` events are emitted from the existing call sites in
  `executeRuntimeTurn`/`confirmRuntimeAction` instead, since no existing telemetry state
  distinguished "about to execute" from "executed."
