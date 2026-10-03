# ADR: Resource Isolation and Graceful Degradation

## Context

Grogoni had real, working resilience mechanisms scattered across the codebase - `@fastify/rate-limit`
backed by Redis, per-boundary timeouts with `AbortController` propagation, a coalesced/retried
async persistence queue, graceful shutdown, and correctly-separated liveness/readiness endpoints.
What it did not have: any circuit breaker anywhere in the repository, a concurrency bound on
inference calls from `services/api` to `ai-runtime` (relying entirely on `ai-runtime`'s own single
`busy` flag to reject overload), a reusable bounded-concurrency primitive (OCR's semaphore was
private and unexported), an immediate no-delay retry loop in OCR (the exact "retry storm" pattern
resilience engineering exists to avoid), three independently-written Postgres pool-config
implementations with inconsistent timeout coverage (the inference artifact pool had none at all),
and a production readiness probe (`/health/ready`) that ran a 12-full-table-scan parity check
inline on every poll against the same pool serving live traffic.

Grogoni's business store is also architecturally unusual for this kind of audit: `Cp2Store` loads the
entire dataset into one process's memory at boot (`docs/single-instance-store-ceiling.md`), so the
classic "a background query holds every DB connection, blocking a critical request" failure mode
mostly doesn't apply to the request-handling critical path here - it applies to the async
persistence path, the inference artifact path, and the health-check path instead. Any resource
isolation work had to target Grogoni's actual contention points, not a generic template.

## Decision

Grogoni uses bulkhead isolation, bounded concurrency, explicit backpressure, timeouts, and circuit
breakers to prevent secondary workloads (inference, OCR, scheduled background jobs) from
exhausting resources the critical commerce path depends on, and graceful degradation to keep that
path available when a secondary workload is degraded or down.

Concretely:

- **One reusable bulkhead primitive** (`@grogoni/resource-control`'s `createBulkhead`: bounded
  concurrency + bounded wait queue, rejects instead of hanging), applied to inference (shared
  across every model on a given execution target, since `ai-runtime` enforces one shared budget
  regardless of model) and OCR (replacing its previously private semaphore).
- **One reusable circuit breaker primitive** (`createCircuitBreaker`: CLOSED → OPEN → HALF_OPEN),
  applied to the same two dependencies - the first circuit breakers to exist in this codebase.
- **One reusable bounded-backoff-with-jitter retry helper** (`retryWithBackoff`), replacing OCR's
  immediate retry loop.
- **One shared Postgres pool-config function** (`services/api/src/db-pool-config.ts`), replacing
  three inconsistent implementations and giving the previously-untimed inference artifact pool
  real connection/query/statement timeouts.
- **One shared workload-classification type** (`WorkloadClass`: critical/important/background,
  `packages/shared-types/src/workload.ts`), labeling every bulkhead and every resource-control
  event/metric.
- **The expensive `/health/ready` parity check moved off the request path**, refreshed on a
  background interval and cached, instead of computed inline on every poll.
- **One shared interval-runner factory** (`createIntervalRunner`), replacing six independently
  hand-rolled "timer + single-flight guard" implementations and giving every scheduled background
  runner `scheduled_job_duration_seconds`/`scheduled_job_failure_total` telemetry in one place.
- **Existing degradation and RuntimeHandoff mechanisms reused, not duplicated**: a saturated
  bulkhead or an open circuit produces the same `ModelRuntimeError`/`Cp2Error` shapes the codebase
  already knew how to degrade gracefully from - no second checkpoint/task-state mechanism was
  built alongside the already-mature `RuntimeHandoff` protocol.

## Alternatives considered

- **Per-model inference bulkheads instead of one shared bulkhead per execution target**: rejected
  because `ai-runtime` itself enforces one global "single generation at a time" budget regardless
  of which model is requested (`services/ai-runtime/src/http-server.ts`'s `busy` flag) - separate
  per-model budgets would only let one model starve another's share of the same underlying
  capacity, not add real isolation.
- **Advisory-lock-based cross-instance coordination for the six scheduled runners**: rejected for
  this pass. `render.yaml` deploys exactly one `grogoni` instance today, and
  `docs/single-instance-store-ceiling.md` explicitly says not to add a second instance until that
  document's ceiling is resolved. Building cross-instance locking against a deployment topology
  that does not exist, and that the repository's own architecture doc says not to introduce yet,
  is the over-engineering the task's own rules warn against - documented as a known follow-up in
  the runbook instead.
- **A new, second task-checkpoint mechanism for degraded inference**: rejected because
  `RuntimeHandoff` already exists, is DB-immutability-enforced, already has a generic
  idempotency-key primitive, and already generalizes "the current execution target can't run
  this" via its existing fallback-chain/swap machinery. The new failure shapes this pass adds
  (`INFERENCE_BUSY`, `INFERENCE_CIRCUIT_OPEN`) flow into that existing machinery unchanged.
- **A hosted rate-limiting or queueing service (Redis Streams, a message broker)**: rejected -
  every mechanism in this pass is in-process. The existing Redis instance
  (`grogoni-rate-limit-cache`) already backs `@fastify/rate-limit` for a different concern
  (HTTP request volume); resource isolation for expensive _workloads_ (not raw request count) does
  not need a second infrastructure dependency.
- **Live-sampled Prometheus gauges for OCR's bulkhead/breaker state, matching inference's**:
  deferred, not rejected outright. OCR's bulkhead/breaker instances are private to
  `createHttpOcrExtractionProcessor`; exposing them would widen `OcrExtractionProcessor`'s public
  shape for what the audit ranked as the lower-priority of the two workloads. Event-driven counters
  (`overload_rejection_total`, `circuit_breaker_transitions_total`) still work for OCR via its
  `onEvent` callback; only the point-in-time active/queued/state gauges are missing.

## Consequences

Inference calls from `services/api` are now bounded and fail fast under sustained `ai-runtime`
outage instead of retrying/timing out into every request - the single highest-priority gap the
audit found. OCR retries no longer create a retry storm against an already-struggling worker. The
inference artifact Postgres pool can no longer hold a connection indefinitely on a hung query.
`/health/ready` no longer competes with live persistence traffic for `cp2_primary` connections on
every poll. Operators get real telemetry (`workload_active`/`workload_queued`/
`circuit_breaker_state`/`overload_rejection_total`/`scheduled_job_duration_seconds`) for exactly
the failure modes this ADR addresses, where none existed before.

The six scheduled runners becoming thin wrappers around `createIntervalRunner` is a refactor, not
just an addition - each runner's existing tests were run unmodified against the new
implementation and pass identically, which is the evidence the refactor preserved behavior exactly
(see docs/architecture/resource-isolation.md §12 and the test suites under `tests/*-runner.test.ts`
plus the new `services/api/src/cp2/interval-runner.test.ts`).

New environment variables (documented in `.env.example` and `render.yaml`, full list in
resource-isolation.md §16) all have defaults matched to today's real traffic/capacity and are
independently fail-closed - misconfiguration is a startup error, not a silent bad default.

Nothing in this pass changes the single-instance-store limitation
(`docs/single-instance-store-ceiling.md`) - a second `grogoni` instance is still unsafe, for
reasons this pass did not attempt to fix, and the runbook says so explicitly.

## Security implications

None of the new bounded-concurrency/circuit-breaker mechanisms change authorization or
authentication - they sit entirely below the existing route-handler/domain-store authorization
checks and never see request identity. `overload_rejection_total`/`circuit_breaker_transitions_total`
and the workload gauges carry only low-cardinality labels (`name`, `workload_class`, `reason`,
`state`) - no accountId, sessionId, or businessId, consistent with the existing `pg_pool_*`/
`http_request_duration_seconds` metrics' cardinality discipline. `GET /metrics` remains gated by
the pre-existing `METRICS_AUTH_TOKEN` check, unchanged by this pass.

## Migration impact

No database migration. `services/api/src/cp2/postgres-store.ts`'s `health()` return shape
(`PostgresStoreHealth`) is unchanged - `phase1Parity` now comes from a background-refreshed cache
instead of being computed inline, but every field and its type are identical, so no consumer of
`/health/ready`/`/health/db` needs to change. Every new env var has a working default; no
deployment configuration is required to adopt this pass, only recommended for production tuning
(see resource-isolation.md §16 and the runbook).
