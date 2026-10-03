# ADR: Durable Agent Execution Plane

## Context

Grogoni was asked to implement a "durable execution plane," explicitly inspired by Google AX's
architectural patterns: durable checkpointing, capability isolation, declarative workload
requirements, explicit runtime lifecycle, and fencing against stale execution authority.

The audit performed before this change
([`durable-execution-audit.md`](../architecture/durable-execution-audit.md)) found that Grogoni
already had almost every one of these concepts, built independently and under repository-native
names, well before this task: an immutable checkpoint chain
(`cp2_runtime_handoffs`/`RuntimeHandoff`), a mutable transfer-of-authority state machine
(`cp2_runtime_transfers`), a generic idempotency primitive (`cp2_runtime_operation_dedup`), a
capability gateway with deny-by-default MCP exposure (`runtimeToolRegistry`), a provider-neutral
runtime resolver (`NativeRuntimeBindingStore`), and an authorized, task-narrowed context assembly
pipeline (`retrieveAgentContext`). What was missing, confirmed by full-file reads and repo-wide
grep rather than assumed: a durable, sequence-numbered, typed execution event log distinct from the
checkpoint chain; an explicit numeric fencing token protecting the one checkpoint-commit path
(`checkpointAfterTurn`) that had no staleness check of its own; a runtime inspection API beyond
resolve/capabilities; and a durable idempotency key on the one order-creating capability reachable
from chat (`commerce.checkout`).

## Decision

Grogoni adopts durable execution, checkpointing, capability isolation, declarative workload
requirements, and explicit runtime lifecycle concepts - validated against Google AX's architecture
as a reference for which concepts matter and why - while retaining its lightweight, provider-neutral
native runtime, deployed without Kubernetes and without a second control plane.

Concretely, this change:

1. Adds `cp2_runtime_execution_events` (migration `087_runtime_execution_events.sql`): an
   append-only, per-task sequence-numbered event log covering the spec's full required taxonomy
   (`TASK_CREATED` through `EXECUTION_CANCELLED`), emitted from the _existing_ instrumentation seams
   (`RuntimeTelemetryEvent` call sites, `RuntimeHandoffDomain`'s audit-event call sites) rather than
   a parallel instrumentation mechanism.
2. Adds explicit fencing: `RuntimeTaskInstance.fenceToken`/`executionId`, minted on every rebind
   (`performSwap`, `completeTransfer`, `resume`), checked by `checkpointAfterTurn` before promoting
   a checkpoint. A stale commit is rejected (`STALE_EXECUTION_FENCE`, 409) and durably recorded
   (`EXECUTION_FENCE_REJECTED`).
3. Adds a runtime inspection surface (`GET /v1/runtime/:taskId/{events,inspect}`,
   `POST /v1/runtime/:taskId/cancel`) reusing the existing REST convention and session/business
   authorization already enforced by every other route in that file.
4. Adds a durable idempotency key to `commerce.checkout` (`CommerceDomain.createUnifiedCheckout`),
   matching the pattern `messaging.send` already used, closing the one non-idempotent, order-
   creating capability gap found in the audit.
5. Extends the `.grogoni.com` artifact schema additively (`runtime.resumable`/`runtime.portable`/
   `context.recipe`) without breaking any existing artifact or bumping `schemaVersion`.

Every addition is either a new Postgres table following the exact generic-entity shape every other
`RuntimeHandoffDomain` table already uses, or an in-process Map plus a handful of call sites in
already-existing pipelines. Nothing here is a second checkpoint mechanism, a second tool registry, a
second runtime resolver, or a second control plane.

## Explicitly rejected

- **Google AX runtime dependency.** Studied for architectural patterns only (per this task's own
  scope); never integrated as a library, service, or protocol dependency. Grogoni's runtime resolver,
  capability gateway, and checkpoint format are all native.
- **Kubernetes requirement.** `render.yaml` deploys a single `grogoni` instance
  (`docs/single-instance-store-ceiling.md`); this change adds no orchestration requirement and
  changes nothing about that deployment model.
- **Agent Substrate requirement.** No such abstraction is introduced; agents, models, and hosts
  remain the existing `cp2_native_runtime_*` graph.
- **A second control plane.** `Cp2Store` remains the single authoritative in-memory writer; the new
  event log and fencing fields are additive state inside the same store, not a separate service.
- **A second backend.** No new service was created; every change lives inside `services/api`.
- **A new Execution Fabric.** The old one was already permanently retired
  (`infra/db/migrations/065_retire_execution_fabric.sql`); this change does not touch its archived
  tables and does not reintroduce anything resembling it - no broker, no job-dispatch layer, no
  provider-specific routing table.
- **Provider-specific core abstractions.** `ModelRuntimeAdapter`/`RuntimeModelProvider` remain the
  only provider boundary; the event log and fencing mechanism are provider-agnostic by
  construction (they key on `taskId`/`executionId`/`runtimeInstanceId`, never on a provider name).

## Alternatives considered

- **A separate `task_execution_events` service/table owned by a new domain module**, independent of
  `RuntimeHandoffDomain`. Rejected: the event log's only consumers (checkpoint creation, transfer
  transitions, rebind, turn telemetry) are all already owned by `RuntimeHandoffDomain` and
  `AgentRuntimeDomain`; a third domain would need to import both anyway, and this repository's
  domain-isolation boundary check (`scripts/check-boundaries.mjs`) forbids one domain deep-importing
  another's private store. Keeping the event log inside `RuntimeHandoffDomain` (which already owns
  the checkpoint/transfer/dedup tables it is a durable companion to) avoids a needless third import
  boundary.
- **Distributed lease/lock service (e.g. a Redis-backed distributed lock) for fencing**, instead of
  a monotonic counter on the existing `RuntimeTaskInstance` row. Rejected for the same reason
  `resource-isolation.md` rejected cross-instance locking for scheduled jobs: `render.yaml` deploys
  exactly one API instance, and `docs/single-instance-store-ceiling.md` explicitly says not to add a
  second one until that document's ceiling is resolved. Building distributed-lock infrastructure to
  defend against a deployment topology that does not exist would be the over-engineering this
  codebase's own conventions consistently reject.
- **A full multi-step agent loop / streaming protocol**, since Google AX's execution model supports
  both. Rejected as out of scope: `governed-tool-runtime.md` already made this exact call
  ("no current streaming consumer... building a streaming protocol... would be exactly the kind of
  speculative, unrequested architecture" this codebase avoids) and nothing in this task's scope
  changed that reasoning.

## Consequences

- A resumed or handed-off task's late-arriving commit is now provably rejected (see the critical
  fencing test in `tests/runtime-handoff-domain-unit.test.ts`), closing a real (if
  currently-latent, single-process-protected) correctness gap ahead of any future distributed
  local-execution host (`LocalHandoffHost`) shipping.
- Every runtime turn and handoff transition now leaves a durable, queryable trace, usable for
  recovery diagnosis and audit without reconstructing state from scattered audit-event rows.
- A duplicate `commerce.checkout` call for the same confirmed action can no longer create a second
  order.
- Three new/changed migrations (`087_runtime_execution_events.sql` plus its rollback) and one
  additive JSON-schema change ship with this release; all are backward-compatible (`if not exists`
  DDL, optional new fields, a restore-time default for pre-existing `RuntimeTaskInstance` rows
  missing `fenceToken`/`executionId`).

## Security implications

See `durable-execution-audit.md` and `durable-execution-plane.md` §9/§12 for the full analysis.
Stale-runtime takeover is now explicitly fenced and logged rather than merely relying on
single-process mutual exclusion. Cross-business task access, capability escalation, and checkpoint
tampering protections are unchanged (this work adds no new cross-tenant surface); the new REST
routes (`/events`, `/inspect`, `/cancel`) reuse the exact same session/business authorization every
other `runtime-handoff/routes.ts` route already enforces and never expose secrets.

## Migration impact

Additive only. `087_runtime_execution_events.sql` creates one new table; no existing table's schema
changes. `RuntimeTaskInstance.fenceToken`/`executionId` are new JSON fields inside the existing
`record` column (no ALTER TABLE required), defaulted on restore for any snapshot predating this
change. The `.grogoni.com` schema's `required` list is unchanged.
