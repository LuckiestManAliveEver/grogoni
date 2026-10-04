# Resource isolation and graceful degradation

Status: implemented (2026-09-21). Companion to
[`resource-isolation-audit.md`](./resource-isolation-audit.md) (the "before" picture) and
[`../adr/ADR-resource-isolation.md`](../adr/ADR-resource-isolation.md) (the decision record).
Operational response to an incident belongs in
[`../runbooks/resource-exhaustion.md`](../runbooks/resource-exhaustion.md).

## The invariant

> No non-critical Grogoni workload may exhaust resources required by the critical commerce path.

Concretely: background workload reaches its budget → backpressure/defer → that background
operation degrades → critical capacity remains protected → commerce stays available. Never:
background workload exhausts a shared resource → API waits indefinitely → 502/504.

## 0. Why this looks different from a typical stateless API

Read [`../single-instance-store-ceiling.md`](../single-instance-store-ceiling.md) first if you
haven't. Grogoni's business store (`Cp2Store`) is loaded entirely into one process's memory at boot;
auth, conversations, catalogue, and orders are synchronous in-memory operations, not per-request
Postgres queries. That single documented fact changes where DB-connection isolation actually
matters here: not "every request competes for a DB connection," but "the async persistence path,
the inference artifact path, and the health-check path do." The controls below target the real
contention points in _this_ architecture, not a generic template.

## 1. Workload classification

`WorkloadClass` (`packages/shared-types/src/workload.ts`): `"critical" | "important" | "background"`.
Used as a label on every bulkhead, every resource-control event, and every metric, so nothing
duplicates these as string literals.

| Class      | Examples in Grogoni                                                                                                                           | Bounded today?                                                                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| critical   | auth, session restore, conversation persistence, catalogue reads, order/payment state                                                         | No dedicated bulkhead - it runs against the in-memory store (§0), which isn't the contended resource; protected by _not sharing_ the resources below with anything else |
| important  | an agent turn's inference call                                                                                                                | Yes - `inferenceBulkhead` + `inferenceBreaker` (§3)                                                                                                                     |
| background | OCR (even when triggered by a live user action - see resource-isolation-audit.md §11), scheduled retention/cooldown sweeps, nightly cron jobs | Yes - `ocrBulkhead`/`ocrBreaker` (§3), single-flight guard on every scheduled runner (§11)                                                                              |

## 2. Database connection isolation

Three pools, one shared config source (`services/api/src/db-pool-config.ts`, `buildPgPoolConfig()`),
replacing three previously-independent, partially-inconsistent implementations
(`postgres-store.ts`'s private `poolConfig()`, `database-connection.mjs`'s `databasePoolConfig()`
for one-off scripts, and index.ts's bare `{ max: 2 }` artifact pool with no timeouts at all):

| Pool                   | Budget env var         | Default | Purpose                                                                                                                    |
| ---------------------- | ---------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| `cp2_primary`          | `DB_POOL_MAX`          | 5       | Boot snapshot load, async persistence, health checks                                                                       |
| `cp2_realtime`         | (fixed `max: 1`)       | 1       | `LISTEN grogoni_sync_changes`                                                                                              |
| `model_artifact_store` | `DB_ARTIFACT_POOL_MAX` | 2       | Inference artifact resolution - now has real `connectionTimeoutMillis`/`query_timeout`/`statement_timeout` instead of none |

`DB_CONNECTION_TIMEOUT_MS` / `DB_IDLE_TIMEOUT_MS` / `DB_QUERY_TIMEOUT_MS` / `DB_STATEMENT_TIMEOUT_MS`
apply to every pool identically. One-off scripts (`db:health`, `db:purge-shops`, ...) keep their own
`databasePoolConfig()` in `services/api/scripts/database-connection.mjs` - each runs as an isolated
Render cron process with its own pool, so it never contends with the API's pools regardless.

**The expensive-query fix.** `/health/ready` → `cp2Store.health()` used to run a 12-full-table-scan
Phase 1 relational/compatibility parity check (`count(*)` + `md5(string_agg(...))` across 6 table
pairs) _inline, on every call_ - and Render polls that exact endpoint as its `healthCheckPath`. Now
(`postgres-store.ts`, `refreshParityCache`): that check runs on a background interval
(`DB_HEALTH_PARITY_CHECK_INTERVAL_MS`, default 60s), cached, never awaited by a request. A failed
refresh keeps the last-known-good cached result rather than flipping readiness - the same
"transient failure must not revert good state" principle the persistence-retry logic already uses
elsewhere in this file. The interval is deliberately **not awaited at store creation**: the first
version of this fix blocked every store boot (and every test that creates one) on that same
expensive query, which is exactly the mistake this fix exists to prevent moving to a different hot
path. `cachedParity` starts empty and fills in on the first background tick instead.

## 3. Bounded concurrency

`@grogoni/resource-control`'s `createBulkhead()` (bounded concurrency + bounded wait queue,
`packages/resource-control/src/bulkhead.ts`) is the one reusable primitive, replacing OCR's
previously private, unexported semaphore. Two live instances:

| Bulkhead    | Class      | `maxConcurrency` env            | `maxQueue` env            | Notes                                                                                                                                                                                                                                                                                                                                                             |
| ----------- | ---------- | ------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inference` | important  | `INFERENCE_MAX_CONCURRENCY` (4) | `INFERENCE_QUEUE_MAX` (8) | One instance shared across every model on the `vercel` execution target - `ai-runtime` itself enforces one global "single generation at a time" budget (`services/ai-runtime/src/http-server.ts`'s `busy` flag) regardless of which model is asked for, so per-model budgets here would just let one model starve another's share of the same underlying capacity |
| `ocr`       | background | `OCR_CONCURRENCY` (1)           | `OCR_QUEUE_MAX` (10)      | Created per `OcrExtractionProcessor` instance (`ocr-provider.ts`)                                                                                                                                                                                                                                                                                                 |

Before this, `services/api`'s inference client had **no concurrency bound at all** - it relied
entirely on `ai-runtime`'s single `busy` flag to reject overload, with no client-side queuing, no
bounded wait, and no protection against repeatedly hammering an `ai-runtime` instance that was
clearly down. This was the highest-priority gap found in the audit; §7 below is the other half of
the fix.

## 4. Backpressure

A bulkhead beyond `maxConcurrency` queues up to `maxQueue`, then rejects immediately with
`BulkheadRejectedError` - never an unbounded wait. Both call sites turn that into the correct HTTP
shape:

- OCR: `Cp2Error(503, "ocr_worker_busy", ...)` (`ocr-provider.ts`).
- Inference: `ModelRuntimeError("INFERENCE_BUSY", ..., retryable: true)` (`model-runtime.ts`), which
  flows through the existing `runtimeProviderFromAdapter` degradation path unchanged (§9).

Every queue has a maximum depth (above), event-driven observability (§8), and - for OCR - a wait
timeout is available via `queueTimeoutMs` on `BulkheadOptions` (not set by either current caller,
since both already bound total latency via the underlying HTTP/model timeout - see the doc comment
on `BulkheadOptions.queueTimeoutMs` for when to use it).

## 5. Timeouts

Unchanged from the audit (§5 there) - every network boundary already had an explicit timeout with
`AbortController`/`AbortSignal` propagation before this pass, and that was correct. The one gap
(the artifact pool having no query/connection timeout) is closed by §2's pool-config
consolidation.

## 6. Retry policy

`retryWithBackoff()` (`packages/resource-control/src/retry.ts`) - bounded attempts, exponential
backoff with full jitter (AWS's "Exponential Backoff And Jitter" strategy: each delay drawn
uniformly from `[0, min(maxDelayMs, initialDelayMs * 2^(attempt-1))]`). OCR now uses it
(`OCR_RETRY_INITIAL_DELAY_MS`/`OCR_RETRY_MAX_DELAY_MS`) instead of the immediate, no-delay retry
loop it had before - the exact "immediate retry loop" pattern this task's rules call out to
eliminate. `isRetryable` distinguishes a non-retryable 4xx worker response (thrown as a `Cp2Error`
immediately, no retry) from a retryable 5xx/network failure.

Inference is still single-attempt per client call, by design - retrying a request against the same
failing target isn't the right response; falling back to a different agent/model/execution-host
target is (`INFERENCE_MAX_FALLBACKS`, unrelated to this pass, already correct).

## 7. Circuit breakers

`createCircuitBreaker()` (`packages/resource-control/src/circuit-breaker.ts`) - standard
CLOSED → OPEN → HALF_OPEN, one probe at a time by default. Two live instances, `inference` and
`ocr`, both wired the same way as their bulkheads (§3 table, same env-var-driven thresholds:
`*_CIRCUIT_BREAKER_FAILURE_THRESHOLD`, `*_CIRCUIT_BREAKER_RESET_TIMEOUT_MS`). Before this pass,
**no circuit breaker existed anywhere in the codebase** - repeated failures against `ai-runtime` or
the OCR worker just kept retrying/timing out at whatever rate callers arrived, with no fail-fast
state. Now, once open, `CircuitOpenError` short-circuits before any network call:

- OCR: `Cp2Error(503, "ocr_worker_unavailable", "OCR worker is temporarily disabled after repeated failures.")`.
- Inference: `ModelRuntimeError("INFERENCE_CIRCUIT_OPEN", ..., retryable: true)`.

## 8. Observability

`@grogoni/observability`'s `Metrics` interface gained, on top of the pre-existing HTTP/DB/model
histograms and pool gauges:

- `instrumentBulkhead(bulkhead)` → live-sampled `workload_active` / `workload_queued` /
  `workload_max_concurrency` / `workload_max_queue` gauges, labeled `{name, workload_class}`.
- `instrumentCircuitBreaker(breaker)` → live-sampled `circuit_breaker_state` gauge (0=closed,
  1=half_open, 2=open), labeled `{name}`.
- `recordResourceEvent(event)` → `overload_rejection_total{name, workload_class, reason}` and
  `circuit_breaker_transitions_total{name, state}` counters, fed by every bulkhead's/breaker's
  `onEvent` callback.
- `timeScheduledJob(job, fn)` → `scheduled_job_duration_seconds{job, outcome}` histogram and
  `scheduled_job_failure_total{job}` counter.

`services/api/src/index.ts`'s `onResourceControlEvent` is the one place every bulkhead/breaker
event lands: it calls `metrics.recordResourceEvent` and logs a structured line
(`services/api/src/resource-control-events.ts`'s `resourceControlEventName` maps each event to the
`resource.*`/`dependency.*` names in §9 below). `console.error` for rejections/circuit-opens,
`console.log` otherwise - this runs at module-init time, before Fastify's `app.log` exists, so it
can't be a child logger the way the rest of the codebase's runtime logging is.

OCR is deliberately instrumented with **events only**, not the live-sampled gauges: its
bulkhead/breaker instances are private to `createHttpOcrExtractionProcessor` and not exposed
outside `ocr-provider.ts` (unlike inference's, which `index.ts` constructs directly and can hand to
`instrumentBulkhead`/`instrumentCircuitBreaker`). Exposing them would mean widening
`OcrExtractionProcessor`'s public shape for a second, lower-priority workload; not done in this
pass - `overload_rejection_total`/`circuit_breaker_transitions_total` for OCR still work via events,
just not the point-in-time active/queued/state gauges.

## 9. Structured events

| Event                                | Emitted when                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `resource.capacity_reached`          | A bulkhead's `maxConcurrency` is saturated and a new operation must queue (or is about to be rejected because the queue is also full) |
| `resource.operation_rejected`        | A bulkhead rejects: `reason: "queue_full"` or `"queue_timeout"`                                                                       |
| `dependency.circuit_opened`          | A circuit breaker trips (`failureThreshold` consecutive failures, or a half-open probe fails)                                         |
| `dependency.circuit_closed`          | A circuit breaker recovers (a call - including a half-open probe - succeeds)                                                          |
| `dependency.circuit_half_open_probe` | A circuit breaker allows one probe attempt after `resetTimeoutMs`                                                                     |

Scheduled-job events already existed before this pass in the six background runners' own
structured logs (`mailbox_background_sync_completed`, `conversation_recycle_bin_purged`, etc., each
already emitted via `app.log.info`/`app.log.error` in `index.ts`) - not renamed here, since they
predate and are unrelated to this resource-control event vocabulary.

## 10. Graceful degradation

Unchanged in _shape_ from the audit (§8 there) - this was already correct. What changed is that
degradation is now **faster and protected** under sustained overload/outage instead of retrying or
timing out into every single request:

- Inference unavailable (busy, circuit open, or a genuine failure): `runtimeProviderFromAdapter`
  already catches every failure shape and returns `status: "unavailable" | "timeout"` rather than
  throwing into the conversation turn - conversation state is preserved, nothing is corrupted.
- OCR unavailable: `Cp2Error` (503, one of `ocr_worker_busy` / `ocr_worker_unavailable` /
  `ocr_worker_failed`) surfaces to the route handler; manual catalogue/product entry remains
  available since OCR is enrichment, not a blocking dependency of catalogue writes.
- Analytics/telemetry: this pass's own metrics recording (`metrics.recordResourceEvent`) never
  blocks or fails a request - it's synchronous, in-process, and has no failure mode that can
  propagate back to the caller.

Never fabricate a model result to avoid an error - `boundModelRuntimeAdapter` never does; every
rejection is a typed error the existing degradation path already knows how to render as
"unavailable," not a fake success.

## 11. RuntimeHandoff integration

`RuntimeHandoff` (`packages/shared-types/src/runtime-handoff.ts`,
`services/api/src/cp2/domains/runtime-handoff/store.ts`) was already extremely mature before this
pass - immutable, DB-enforced-immutable checkpoints, a generic idempotency-key primitive
(`cp2_runtime_operation_dedup`), `performSwap`/`rollback`/`resume` with legacy bootstrap, and
`acquireTurn`'s per-task mutual exclusion. This pass did not add a second checkpoint/task-state
mechanism - that would violate the same "don't build a second parallel store for the same concept"
principle this repo already applies to `Cp2Store` itself.

What this pass adds is the trigger shape RuntimeHandoff already knows how to consume: when the
inference bulkhead rejects or the inference circuit is open, `boundModelRuntimeAdapter` raises a
`ModelRuntimeError` with `retryable: true` (`INFERENCE_BUSY` / `INFERENCE_CIRCUIT_OPEN`) - the same
error shape `runtimeProviderFromAdapter` already converts into `status: "unavailable"`,
`errorCode: "INFERENCE_BUSY" | "INFERENCE_CIRCUIT_OPEN"`. Anywhere the agent-runtime turn handler
already checkpoints/swaps on an unavailable model (the existing `performSwap` fallback chain,
`INFERENCE_MAX_FALLBACKS`), a saturated bulkhead or an open circuit now participates in exactly the
same decision an ordinary inference failure already triggers - no new integration surface, because
the existing one already generalizes to "the current target can't run this," regardless of why.

## 12. Scheduled job safety

Render cron jobs (`db-backup`, `shop-purge`, `account-purge`, `db-health`) each run as an isolated,
one-shot process with its own pool - they cannot overlap with the API's pools or each other by
construction (different OS processes per Render's cron semantics), unchanged by this pass.

The six in-process `setInterval` runners were independently hand-rolling the identical
"timer + single-flight guard" shape (`docs/architecture/resource-isolation-audit.md` §11: "six
runners, identical shape"). Extracted into one shared factory,
`services/api/src/cp2/interval-runner.ts`'s `createIntervalRunner()` - every runner
(`notification-delivery-runner.ts`, `connected-mailbox-sync-runner.ts`,
`conversation-recycle-bin-runner.ts`, `agent-owner-correction-retention-runner.ts`,
`grogoniid-cooldown-runner.ts`, `account-deletion-runner.ts`) is now a thin wrapper supplying its own
interval validation and store call; the timer/overlap-prevention/timing plumbing lives once. This
is also how `scheduled_job_duration_seconds`/`scheduled_job_failure_total` (§8) get wired in without
touching each runner's internals a second time - `index.ts` passes `metrics.timeScheduledJob` into
all six.

**Deliberately not added**: cross-instance locking (`pg_advisory_lock`) for these six runners.
`render.yaml` deploys exactly one `grogoni` instance and
`docs/single-instance-store-ceiling.md` explicitly says not to add a second one until that
document's ceiling is resolved - adding advisory-lock machinery to defend against a deployment
topology that doesn't exist yet, and that the repo's own architecture doc says not to introduce,
would be exactly the over-engineering §28 of the task spec warns against. Documented as a known
follow-up in the runbook, not fixed here.

## 13. Health and readiness

Unchanged in shape (already correct - see resource-isolation-audit.md §13): liveness never depends
on a dependency, readiness depends on DB + (only if `INFERENCE_REQUIRED`) inference. The one change
is cost, not shape: §2's parity-cache fix.

## 14. Graceful shutdown

Unchanged - already correct (`services/api/src/index.ts:309-333`, most recently touched by this
branch's own prior commit `a4ce5fa feat(api): gracefully drain during rolling deploys`). The new
`parityCheckTimer` (§2) is `.unref()`'d, same as every other background interval in this file, so
it never blocks process exit, and is explicitly cleared in `close()`.

## 15. Bulkhead architecture (current diagram)

```
                       ┌─────────────────┐
                       │   Grogoni API      │
                       └────────┬────────┘
                                │
              ┌─────────────────┼─────────────────────────┐
              │                 │                          │
              ▼                 ▼                          ▼
     Critical (in-memory   Agent Runtime              Background
      Cp2Store, §0 -           │                          │
      not resource-      ┌─────┴─────┐         ┌──────────┼──────────┐
      bounded here;            │                │          │
      protected by        Inference        OCR (bulkhead   6 setInterval
      not sharing         (bulkhead +      + breaker,       runners (single-
      the pools/          breaker,          background)     flight guard,
      bulkheads           important)             │           createIntervalRunner)
      below with               │                │                │
      anything else)           │                │                │
              │                 │                │                │
              └─────────────────┼────────────────┼────────────────┘
                                ▼                ▼
                     ai-runtime (busy flag)  OCR worker (own semaphore)
                                │
                                ▼
                           PostgreSQL
                (cp2_primary / cp2_realtime / model_artifact_store,
                 each independently budgeted - §2)
```

## 16. Configuration reference

All new env vars, fail-closed at the point of use (a malformed value throws at startup, matching
the existing `numberFromEnv`/`positiveIntegerFromEnv` convention throughout this codebase - never a
silently-ignored bad value):

| Variable                                      | Default | Validated by                         |
| --------------------------------------------- | ------- | ------------------------------------ |
| `INFERENCE_MAX_CONCURRENCY`                   | 4       | `createBulkhead` (must be ≥ 1)       |
| `INFERENCE_QUEUE_MAX`                         | 8       | `createBulkhead` (must be ≥ 0)       |
| `INFERENCE_CIRCUIT_BREAKER_FAILURE_THRESHOLD` | 5       | `createCircuitBreaker` (must be ≥ 1) |
| `INFERENCE_CIRCUIT_BREAKER_RESET_TIMEOUT_MS`  | 30000   | `createCircuitBreaker` (must be > 0) |
| `DB_ARTIFACT_POOL_MAX`                        | 2       | `positiveIntegerFromEnv`             |
| `DB_HEALTH_PARITY_CHECK_INTERVAL_MS`          | 60000   | `positiveIntegerFromEnv`             |
| `OCR_QUEUE_MAX`                               | 10      | `createBulkhead`                     |
| `OCR_RETRY_INITIAL_DELAY_MS`                  | 200     | `readPositiveInteger`                |
| `OCR_RETRY_MAX_DELAY_MS`                      | 5000    | `readPositiveInteger`                |
| `OCR_CIRCUIT_BREAKER_FAILURE_THRESHOLD`       | 5       | `createCircuitBreaker`               |
| `OCR_CIRCUIT_BREAKER_RESET_TIMEOUT_MS`        | 30000   | `createCircuitBreaker`               |

Pre-existing, unchanged: `DB_POOL_MAX`, `DB_CONNECTION_TIMEOUT_MS`, `DB_IDLE_TIMEOUT_MS`,
`DB_QUERY_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS`, `OCR_CONCURRENCY`, `OCR_MAX_RETRIES`,
`OCR_JOB_TIMEOUT_SECONDS`, `INFERENCE_JOB_TIMEOUT_MS`, `VERCEL_INFERENCE_TIMEOUT_MS`.

## What this pass deliberately did not do

- **Multi-instance DB pool separation / cross-instance job locking.** `render.yaml` deploys one
  instance; `docs/single-instance-store-ceiling.md` says don't add a second until that document's
  ceiling is resolved. Building elaborate cross-instance coordination for a topology that doesn't
  exist is the over-engineering §28 of the task spec warns against - documented as a follow-up in
  the runbook, not implemented.
- **A second checkpoint/task-state mechanism for degraded inference.** `RuntimeHandoff` already
  does this; §11 wires the new failure shapes into its existing consumption path instead.
- **Live-sampled Prometheus gauges for OCR's bulkhead/breaker.** Only event-driven counters -
  see §8's reasoning.
- **Redis, a queue broker, or any new infrastructure dependency.** Every mechanism in this pass is
  in-process (bulkhead, circuit breaker, retry) or reuses infrastructure that already existed
  (Postgres pools, the existing Redis-backed `@fastify/rate-limit`).
