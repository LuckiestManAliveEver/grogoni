# Durable Execution Plane

This document describes Grogoni's durable, observable, resumable agent execution architecture: how a
request becomes a task, how that task's execution is durably logged, checkpointed, fenced, and
handed off between runtimes, and how none of that requires a second execution engine. It is the
target-state companion to [`durable-execution-audit.md`](durable-execution-audit.md) (what existed
before this change) and extends, rather than replaces, six already-mature documents:
[`runtime-handoff-protocol.md`](runtime-handoff-protocol.md) /
[`../runtime/runtime-handoff.md`](../runtime/runtime-handoff.md) (checkpoint + transfer lifecycle),
[`native-agent-model-runtime.md`](native-agent-model-runtime.md) (binding resolution),
[`capability-first-runtime.md`](capability-first-runtime.md) /
[`governed-tool-runtime.md`](governed-tool-runtime.md) (the capability gateway), and
[`context-semantic-runtime.md`](context-semantic-runtime.md) (context resolution).

## 1. The invariant

> Intelligence, state, resources, and infrastructure remain separate. An agent never receives
> ambient infrastructure access; every resource is reached only through an explicit, authorized
> capability.

Concretely in this codebase: a model never sees a database connection, a filesystem handle, a
credential, or an internal service URL. It sees a prompt (assembled by the context runtime) and,
when policy allows, proposes a `RuntimeToolName` with structured input. Everything downstream of
that proposal - authorization, validation, execution, audit - happens server-side, in
`Cp2Store.createRuntimeTurn` / `executeRuntimeCapability`, never inside the model.

## 2. The execution lifecycle

```
Request (chat message / MCP tools/call / storefront message)
   |
   v
Task (= a conversation; taskId is stable across every step below - runtime-handoff.ts's own note)
   |
   v
Binding Resolution     resolveActiveRuntimeModelId / NativeRuntimeBindingStore
   |
   v
Authorization          requireAuthorizedSession, then enforceAgentPolicy + role check after planning
   |
   v
Context Resolution     retrieveAgentContext (authorized, task-narrowed, model-budgeted)
   |
   v
Capability Resolution  runtimeToolRegistry lookup for the proposed RuntimeToolName
   |
   v
Execution               executeRuntimeCapability -> canonical Cp2Store domain operation
   |
   v
Durable Events           cp2_runtime_execution_events (this change)
   |
   v
Checkpoint                cp2_runtime_handoffs (RuntimeHandoffDomain.checkpointAfterTurn)
   |
   v
RuntimeHandoff            cp2_runtime_transfers (a transfer of execution authority)
   |
   v
Rebind / Resume           performSwap / completeTransfer / resume - mints a new fence token
   |
   v
Result                    RuntimeTurnResult back to the caller
```

Every arrow in this diagram is a real, traceable call in `services/api/src/cp2/domains/`, not an
aspiration - see §7 for the exact file/line seams.

## 3. Data model

```
                          GROGONI DURABLE EXECUTION PLANE

  Task (conversation)
       |
       v
  cp2_runtime_task_heads ----------- activeHandoffId, nextCheckpointVersion
       |                                       |
       |                                       v
       |                          cp2_runtime_handoffs (checkpoint chain, immutable)
       |                                       |
       v                                       v
  cp2_runtime_task_instances ---- fenceToken, executionId, status, activeHandoffId
       |
       v
  cp2_runtime_transfers (mutable handoff-in-progress state machine)
       |
       v
  cp2_runtime_execution_events (append-only, sequence-numbered per task)   <- new in this change
       |
  cp2_runtime_operation_dedup (generic idempotency-key store)
```

| Table                              | Role                                                            | Added by                            |
| ---------------------------------- | --------------------------------------------------------------- | ----------------------------------- |
| `cp2_runtime_handoffs`             | Checkpoint (spec's `RuntimeCheckpoint`) - immutable             | migration 083                       |
| `cp2_runtime_task_heads`           | Authoritative current-checkpoint pointer + version counter      | migration 083                       |
| `cp2_runtime_task_instances`       | Per-task executor identity: status, `fenceToken`, `executionId` | migration 083 (+fields this change) |
| `cp2_runtime_transfers`            | Mutable RuntimeHandoff (transfer-of-authority) state machine    | migration 085                       |
| `cp2_runtime_operation_dedup`      | Generic `(operationType, idempotencyKey)` dedup                 | migration 083                       |
| `cp2_runtime_execution_events`     | Append-only, sequence-numbered execution event log              | migration 087 (this change)         |
| `cp2_native_runtime_*`             | Agent/model/host/binding graph (native runtime bindings)        | migration 063                       |
| `unified_checkouts.idempotencyKey` | Durable dedup for the one order-creating capability             | this change                         |

Naming note, carried over from the audit: this codebase's `RuntimeHandoff` type is the spec's
_checkpoint_; this codebase's `cp2_runtime_transfers`/`RuntimeTransfer` is the spec's
_RuntimeHandoff_ (transfer of execution authority). Both concepts exist; only the label differs.
This document uses the repository's own names and calls out the spec's name in parentheses on
first use per section.

## 4. Task identity

A task's identity is its `taskId` (a conversation id). It is never encoded in, or derived from, any
particular agent, model, runtime instance, execution host, or process. Proof: `RuntimeHandoff.taskId`
survives every `performSwap` (agent/model change), every `completeTransfer` (host change), every
`resume` (process restart recovery), and every offline/online sync - the checkpoint chain's
`parentHandoffId` ancestry is the only thing that changes shape; `taskId` on every row in that chain
is identical.

## 5. Runtime bindings are replaceable

```
Task -> Agent -> Model -> Runtime Instance -> Execution Host
```

Lower layers change without destroying task state: `performSwap` replaces the agent or model
dimension; `completeTransfer` replaces the execution host; neither touches `goal`,
`completedActions`, `decisions`, `rejectedPaths`, `pendingActions`, or `relevantContext` on the
checkpoint except by explicit request. Business/task state is never encoded inside a model
identifier, a container, a browser process, or an inference provider - see
`RuntimeHandoffRuntimeRef` (`agentId`/`modelId`/`executionHostId` only).

## 6. Everything external is a capability

```
Agent -> Capability Gateway (runtimeToolRegistry + executeRuntimeCapability) -> Authorized domain operation -> Resource
```

Already true before this change (`capability-first-runtime.md`, `governed-tool-runtime.md`); this
change adds no second gateway. Every capability invocation carries account, business, agent
(binding), task (conversation), capability name, an authorization decision
(`enforceAgentPolicy`/role check), input validation, execution, and - as of this change - a durable
`TOOL_REQUESTED`/`TOOL_AUTHORIZED`/`TOOL_STARTED`/`TOOL_COMPLETED`/`TOOL_DENIED`/`TOOL_FAILED` event
trail. The model never authorizes itself: authorization happens after the model proposes a tool
call, entirely server-side.

## 7. Durable execution event log

`cp2_runtime_execution_events` (migration `087_runtime_execution_events.sql`) is append-only,
uniquely constrained on `(task_id, sequence_number)`, and immutable after insertion (same trigger
pattern as `cp2_runtime_handoffs`). `RuntimeHandoffDomain.appendExecutionEvent` allocates sequence
numbers synchronously (same single-writer-process safety argument as
`allocateNextCheckpointVersion`).

Event emission seams (no new instrumentation mechanism - both piggyback on `RuntimeTelemetryEvent`
call sites that already existed):

- **`RuntimeHandoffDomain`** (`services/api/src/cp2/domains/runtime-handoff/store.ts`):
  `bootstrapLegacyHandoff` → `TASK_CREATED`; `createCheckpoint`/`checkpointAfterTurn` →
  `CHECKPOINT_CREATED`; `performSwap` → `HANDOFF_STARTED`, `HANDOFF_FAILED` (on a caught error),
  `RUNTIME_REBOUND`, `HANDOFF_COMPLETED`; `completeTransfer` → `RUNTIME_REBOUND`; `resume` →
  `EXECUTION_RESUMED`; `cancelExecution` → `EXECUTION_CANCELLED`; the shared `transferEvent` helper
  (used by `beginTransfer`/`completeTransfer`/`failTransferRecord`) maps every existing
  `runtime.handoff_*`/`runtime.checkpoint_*`/`runtime.restore_*`/`runtime.target_activation_*` audit
  event to its taxonomy equivalent.
- **`AgentRuntimeDomain`** (`services/api/src/cp2/domains/agent-runtime/store.ts`):
  `runtimeExecutionEventTypeForTelemetry` maps every `RuntimeTelemetryEvent.state` this domain
  already emits onto the durable taxonomy, inside the existing `appendTelemetry` closures -
  `turn.received`, `context.built`, `intent.routed`, `plan.created`, `verification.completed`,
  `confirmation.required`, `tool.executed`, `response.generated`, and (emitted per fallback attempt,
  with real `fallbackIndex` metadata, by `runtime-model-routing.ts`'s own existing instrumentation,
  which receives and calls the same `appendTelemetry` closure) `model.inference_started`/
  `model.completed` → `MODEL_INVOCATION_STARTED`/`MODEL_INVOCATION_COMPLETED`/
  `MODEL_INVOCATION_FAILED`. `TOOL_STARTED` is emitted explicitly immediately before each
  `executeRuntimeCapability` call (both the auto-execute and confirmed-action paths), since no
  existing telemetry state distinguished "about to execute" from "executed."

Required event taxonomy (spec section 2), all present and all independently emitted:

```
TASK_CREATED
BINDING_RESOLUTION_STARTED, BINDING_RESOLVED
AUTHORIZATION_STARTED, AUTHORIZATION_COMPLETED, AUTHORIZATION_DENIED
CONTEXT_RESOLUTION_STARTED, CONTEXT_RESOLVED
CAPABILITIES_RESOLVED
EXECUTION_STARTED
MODEL_INVOCATION_STARTED, MODEL_INVOCATION_COMPLETED, MODEL_INVOCATION_FAILED
TOOL_REQUESTED, TOOL_AUTHORIZED, TOOL_DENIED, TOOL_STARTED, TOOL_COMPLETED, TOOL_FAILED
CHECKPOINT_CREATED
EXECUTION_SUSPENDED, EXECUTION_RESUMED
HANDOFF_STARTED, HANDOFF_COMPLETED, HANDOFF_FAILED
RUNTIME_REBOUND
EXECUTION_COMPLETED, EXECUTION_FAILED, EXECUTION_CANCELLED
```

Plus one addition: `EXECUTION_FENCE_REJECTED` - an explicit, observable record of a fencing
rejection (§9), for security review and diagnosis. `AUTHORIZATION_STARTED` is emitted right before
policy/role enforcement runs on a proposed tool call; `TOOL_AUTHORIZED` is emitted the moment
`verification.ok` is true (the tool is cleared to run, whether it executes immediately or waits for
confirmation first) - both are explicit `appendRuntimeExecutionEvent` calls in
`executeRuntimeTurn`/`confirmRuntimeAction`, not inferred from `plan.created`/`verification.completed`
alone, so they are independently observable rather than reconstructed after the fact
(`tests/runtime-handoff-protocol.test.ts`'s end-to-end event-log test asserts their relative order).

No secrets, credentials, tokens, or raw customer PII are ever written into an event payload - only
identifiers, counts, and typed status fields, the same discipline `RuntimeTelemetryEvent` already
enforces.

## 8. Checkpoint lifecycle

Unchanged from `runtime-handoff-protocol.md` - this change does not alter checkpoint semantics, only
adds a durable event alongside checkpoint creation. A checkpoint (`RuntimeHandoff` row) contains
`goal`, `currentState`, `completedActions`/`decisions`/`rejectedPaths`,
`pendingActions`/`nextAction`, `relevantContext` (references, never content),
`artifacts` (references), `tests`, `runtime` (agent/model/host triple), `checkpointVersion`,
`schemaVersion`. It never duplicates a full business record - `relevantContext` entries are
`{kind, refId}` pointers re-authorized at read time, not copies.

## 9. Fencing

**The gap this change closes.** Before this change, per-task mutual exclusion
(`RuntimeHandoffDomain.acquireTurn`'s `executingTasks` set) prevented two turns, or a turn and a
transfer, from running concurrently _within one process_ - but `checkpointAfterTurn` (called after
every ordinary chat turn) performed no staleness check of its own before promoting a checkpoint. See
`durable-execution-audit.md` §5 for the full gap analysis.

`RuntimeTaskInstance` now carries `fenceToken: number` and `executionId: string`. Every rebind
(`performSwap`, `completeTransfer`, `resume`) calls the shared `setTaskInstanceHandoff`, which mints
`fenceToken = previous + 1` and a fresh `executionId`. `acquireTurn` returns the fence token in
effect at turn start; the caller (`AgentRuntimeDomain.createRuntimeTurn`) hands that same token back
to `checkpointAfterTurn` when the turn finishes. If the task's current fence token has moved on in
the meantime, the commit is rejected with `STALE_EXECUTION_FENCE` (409) and an
`EXECUTION_FENCE_REJECTED` durable event is recorded - the checkpoint write never happens, and the
task head is left exactly where the newer execution left it.

```
Execution A                          Task
  acquireTurn -> fenceToken=null        |
  ... (long await: model call) ...      |
                                    performSwap (rebind) -> fenceToken=1
  checkpointAfterTurn(fence=null)  <- accepted (nothing to be stale against yet)

Execution C (after the rebind)
  acquireTurn -> fenceToken=1
                                    resume (rebind) -> fenceToken=2
  checkpointAfterTurn(fence=1)     <- REJECTED: current fence is 2
```

A task with no executor identity yet (fresh conversation, never rebound) has nothing to be stale
against, so the check is a no-op until the first rebind - fencing activates exactly when the risk it
guards against begins, not before.

Fencing is not limited to ordinary chat turns. `RuntimeCheckpointCreateInput.expectedFenceToken`
(optional, checked only when `promote: true`) extends the exact same check - via a shared private
`RuntimeHandoffDomain.verifyFence` helper - to `createCheckpoint`, the general checkpoint-creation
API reachable over REST (`POST /v1/runtime/:taskId/checkpoints`) and MCP. This is the concrete write
path a future out-of-process executor (a `LocalHandoffHost`, or any other caller that captured a
fence token from `GET .../inspect`) would use to report progress; it gets the identical
stale-execution protection an ordinary chat turn gets, today, even though no such executor ships in
this checkout yet (`runtime-handoff.md`: _"This checkout does not ship a full LocalHandoffHost
executor or installer"_). A non-promoting checkpoint (a branch, never becoming canonical) is
unaffected by fencing, matching how it is already unaffected by `expectedHandoffId` - only a
promotion can overwrite the task's canonical state.

This is the same mechanism that makes **duplicate resume** safe: two `resume` calls on the same task
each mint a new fence token; the second wins, and the first caller's eventual commit attempt (if any)
is rejected as stale. See `tests/runtime-handoff-domain-unit.test.ts`'s
`"duplicate resume: the later resume wins..."` test.

## 10. RuntimeHandoff (transfer of execution authority) lifecycle

Unchanged state machine (`runtime-handoff-protocol.md`, `../runtime/runtime-handoff.md`):

```
PENDING -> CHECKPOINTING -> CHECKPOINTED -> TARGET_ACTIVATING -> RESTORING -> VERIFYING -> COMPLETED
Any nonterminal state -> FAILED
```

Idempotent: `beginTransfer` deduplicates on `(accountId, taskId, idempotencyKey)`; a repeated
request with the same key and payload returns the existing transfer rather than creating a second
one; a changed payload with the same key returns `HANDOFF_CONFLICT`. The source runtime remains
authoritative until the target has restored and passed verification - a failed target activation
never replaces the source's binding/head.

## 11. Runtime resolver

`NativeRuntimeBindingStore` (native runtime graph) plus `resolveActiveRuntimeModelId`
(legacy/profile-scoped resolution) together resolve agent, model, runtime instance, and execution
host without hardcoding a provider. Execution targets are `backend | remote-shop-device` (see
`native-agent-model-runtime.md`); providers are adapters behind `ModelRuntimeAdapter`, never a core
abstraction dependency. This change adds no second resolver.

## 12. Capability Gateway and resource isolation

```
Agent
   |
   v
Capability Gateway (runtimeToolRegistry + executeRuntimeCapability)
   |-- catalogue.query / inventory.read     (read-only)
   |-- product.create / customer.create      (idempotent-write, business-keyed)
   |-- commerce.checkout                     (non-idempotent-write - see §13)
   |-- messaging.send                        (non-idempotent-write - idempotency-keyed)
   `-- ... (20 registered tools total)
```

**Deny-by-default, proven, not assumed**: `RuntimeToolDefinition.mcpExposable` is `false` on every
one of the 20 registry entries (`governed-tool-runtime.md`) - MCP cannot invoke any of them
directly; it can only drive the same governed `createRuntimeTurn` pipeline every other surface uses.
A product-search agent's model can propose `catalogue.query` or `inventory.read`; if it proposes
`payments.request` or a fabricated `database.rawQuery`, there is no dispatcher case for the latter
(`runtimeToolRegistry` has no such entry) and `enforceAgentPolicy`/role checks gate the former
regardless of what the model claims. Possession of a task never implies possession of its
resources: every capability call re-derives account/business/role from the _authenticated session_,
never from anything the model said.

## 13. Idempotency

| Operation                                          | Class                  | Mechanism                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalogue.query`, `inventory.read`, etc.          | read-only              | No dedup needed - no side effect                                                                                                                                                                                                                                                                           |
| `product.create`, `customer.create`, ...           | idempotent-write       | Re-running with the same input either no-ops or produces the same visible state (existing domain invariants, unchanged by this work)                                                                                                                                                                       |
| `messaging.send`                                   | non-idempotent-write   | `idempotencyKey: \`runtime-message:${action.id}\``(pre-existing), deduped by`MessagingDomain`on`(conversationId, idempotencyKey)`                                                                                                                                                                          |
| `commerce.checkout` (order creation)               | non-idempotent-write   | **New in this change**: `idempotencyKey: \`runtime-checkout:${action.id}\`` (`commerce-capabilities.ts`), deduped by `CommerceDomain.createUnifiedCheckout`on`(buyerAccountId, idempotencyKey)`, durable via the already-persisted `UnifiedCheckoutSummary.idempotencyKey` field - no separate cache table |
| Checkpoint/swap/rollback/resume/offline-sync/merge | control-plane mutation | `RuntimeHandoffDomain.withIdempotency`, `cp2_runtime_operation_dedup` (pre-existing)                                                                                                                                                                                                                       |

A confirmed action's `action.id` is stable across a retried or resumed turn (it is minted once when
the plan is created and reused by every subsequent `confirmRuntimeAction` call using the same
confirmation token), which is what makes `action.id`-derived keys correct: replaying the same
confirmed action never mints a new key.

## 14. Failure recovery

| Failure                               | Behavior                                                                                                                                                                                                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model timeout / provider failure      | `runtimeProviderFromAdapter` returns `status: "unavailable" \| "timeout"`; conversation state untouched; next candidate/fallback tried per `native-agent-model-runtime.md` §"Resolution and fallback"                                                                |
| Host timeout during handoff           | Transfer soft deadline (2 minutes) expires it to `FAILED`; source stays canonical (`runtime-handoff.md`)                                                                                                                                                             |
| Process crash mid-turn                | In-memory `executingTasks` lock vanishes with the process; a fresh process has no stale lock. A _local_ host's async work completing after a handoff is rejected by fencing (§9)                                                                                     |
| Tool failure                          | `executeRuntimeCapability` throws; `tool.executed`/`TOOL_FAILED` recorded; action not marked executed, confirmation token retained if the failure is retryable                                                                                                       |
| Duplicate delivery / duplicate resume | Fencing (§9) + idempotency (§13)                                                                                                                                                                                                                                     |
| Authorization change while suspended  | Every turn (including a resumed one) re-derives audience/authorization from the live session and business membership - `context-semantic-runtime.md`'s per-turn re-resolution, unchanged by this work; nothing caches a stale authorization decision on a checkpoint |
| Stale checkpoint / stale binding      | `requireMatchingHead`/`expectedHandoffId` optimistic concurrency (pre-existing) + fencing (new)                                                                                                                                                                      |

## 15. Observability

Structured logs already carry `taskId`/`turnId`/`sessionId` on every runtime log line
(`AgentRuntimeDomain`'s existing logging). The durable event log adds a queryable, persisted trail
(`GET /v1/runtime/:taskId/events`) carrying `taskId`, `executionId`, `runtimeInstanceId`,
`executionHostId` on every row - never secrets. `GET /v1/runtime/:taskId/inspect` assembles task
head, active checkpoint, runtime instance (with fence/lease status), active transfer, the latest 50
events, and resume eligibility into one diagnostic response, reusing existing telemetry
infrastructure (`resource-isolation.md`'s `Metrics`/resource-event plumbing is unaffected - this is
a new read surface, not a new metrics pipeline).

## 16. Runtime inspection API

| Capability                         | Route                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `runtime.inspect(taskId)`          | `GET /v1/runtime/:taskId/inspect`                                                                                               |
| `runtime.events(taskId)`           | `GET /v1/runtime/:taskId/events`                                                                                                |
| `runtime.suspend`                  | Implicit - a confirmation-required tool proposal already suspends the turn (`EXECUTION_SUSPENDED`); no separate endpoint needed |
| `runtime.resume(taskId)`           | `POST /v1/runtime/:taskId/resume` (pre-existing)                                                                                |
| `runtime.handoff(taskId, target?)` | `POST /v1/runtime/:taskId/handoffs` (pre-existing)                                                                              |
| `runtime.cancel(taskId)`           | `POST /v1/runtime/:taskId/cancel` (new)                                                                                         |
| `runtime.retry(taskId)`            | `POST /v1/runtime/:taskId/resume` (same endpoint - a retry _is_ a resume of the current checkpoint)                             |

No secrets are ever returned by any of these.

## 17. Chat integration

The chat path _is_ this architecture, not a second one beside it: `POST
/businesses/:id/runtime/turns` → `Cp2Store.createRuntimeTurn` → `RuntimeHandoffDomain.acquireTurn`
(fencing/mutual-exclusion) → `AgentRuntimeDomain.executeRuntimeTurn` (binding resolution → context
resolution → capability resolution → execution, each now emitting durable events) →
`RuntimeHandoffDomain.checkpointAfterTurn` (fenced checkpoint commit). MCP (`grogoni.runtime_turn`) and
the storefront/public-agent path call the identical `createRuntimeTurn`. There is exactly one
runtime system for chat and handoffs, as required.

## 18. What this change deliberately did not build

See `durable-execution-audit.md` §10. In short: no second checkpoint/handoff/tool-registry
mechanism, no Kubernetes/queue-broker/Redis dependency, no rewrite of `createRuntimeModelRoute`'s
internals, no change to retired execution-target semantics.
