# Resource exhaustion runbook

Companion to [`../architecture/resource-isolation.md`](../architecture/resource-isolation.md) (what
exists and why) and [`../architecture/resource-isolation-audit.md`](../architecture/resource-isolation-audit.md)
(the "before" state). Read this when something is saturated, degraded, or slow in production.

**"Restart the server" is not the fix for anything in this document.** A restart clears symptoms
(a stuck circuit, a full queue) without touching the cause. Every section below ends with the
permanent remediation, not just the emergency mitigation - do both, in that order, not one instead
of the other.

## How to look

`GET /metrics` (gated by `x-metrics-token: $METRICS_AUTH_TOKEN`) is the source of truth. The
relevant series, all introduced or extended by this pass unless noted:

```
pg_pool_total_connections{pool}       pg_pool_idle_connections{pool}
pg_pool_waiting_requests{pool}        pg_pool_max_connections{pool}     # pre-existing
workload_active{name,workload_class}  workload_queued{name,workload_class}
workload_max_concurrency{...}         workload_max_queue{...}
circuit_breaker_state{name}           # 0=closed, 1=half_open, 2=open
overload_rejection_total{name,workload_class,reason}
circuit_breaker_transitions_total{name,state}
scheduled_job_duration_seconds{job,outcome}  scheduled_job_failure_total{job}
```

`GET /health/ready`, `/health/live`, `/health/db`, `/health/ai` remain the fast triage entry
points (see resource-isolation.md §13) - `/health/ready` is what Render's own health check polls,
so it's usually the first thing worth curling directly.

## DB pool exhaustion

**Symptoms:** `pg_pool_waiting_requests{pool="cp2_primary"}` rising and staying above zero;
`/health/db`'s `persistenceQueue.status` reports `"degraded"`; slow persistence writes in logs
(`[db] slow operation "persist CP2 relational store" took Nms`).

**Diagnose:**

1. Which pool - `cp2_primary` (persistence + health checks), `cp2_realtime` (should only ever show
   `total=1`), or `model_artifact_store` (inference artifact resolution)?
2. Is it saturated (`pg_pool_total_connections` at `pg_pool_max_connections`) or just slow
   (connections available, but `pg_query_duration_seconds` climbing)? Different causes, different
   fixes.
3. Check for a long-running query holding a connection: on Postgres, `select * from pg_stat_activity
where state != 'idle' order by query_start asc limit 20;`.

**Emergency mitigation:** none that doesn't also fix the cause here - there's no separate "shed
load" lever for this pool today (see resource-isolation.md's "what this pass deliberately did not
do"). If a specific query is clearly hung, terminate it: `select pg_terminate_backend(pid) from
pg_stat_activity where pid = <pid>;` - only the identified query, never a blanket kill.

**Permanent remediation:**

- If it's genuinely more traffic than `DB_POOL_MAX=5` can serve: raise it (render.yaml + a
  matching Neon connection-limit check), don't just restart.
- If it's the Phase 1 parity check regressing (it shouldn't - that moved to a background interval
  in this pass, see resource-isolation.md §2): check `DB_HEALTH_PARITY_CHECK_INTERVAL_MS` hasn't
  been set unreasonably low, and confirm `refreshParityCache`'s errors in logs aren't silently
  piling up.
- If it's a genuinely slow query: `EXPLAIN ANALYZE` it in a non-production environment, add the
  index it's missing (resource-isolation-audit.md §5 already covers the parity-check case; if a
  _new_ slow query shows up, treat it the same way - diagnose before indexing).

## Inference saturation

**Symptoms:** `workload_active{name="inference"}` pinned at `workload_max_concurrency`;
`overload_rejection_total{name="inference"}` climbing; users see `INFERENCE_BUSY` errors
(retryable) or agent turns come back "unavailable."

**Diagnose:**

1. Is `ai-runtime` itself actually saturated (its own single `busy` flag returning 503), or is
   `services/api`'s bulkhead the bottleneck (requests queuing/rejecting before even reaching
   `ai-runtime`)? `workload_queued{name="inference"}` > 0 with `ai-runtime` healthy means the
   bulkhead's `INFERENCE_MAX_CONCURRENCY`/`INFERENCE_QUEUE_MAX` may be tuned too low for real
   traffic, not a real dependency problem.
2. Check `circuit_breaker_state{name="inference"}` - if it's `2` (open), calls are failing fast
   without even reaching `ai-runtime`; that's the circuit doing its job, not a new problem. Look at
   _why_ it opened (the failures that tripped it), not just that it's open.

**Emergency mitigation:** conversations degrade gracefully already (resource-isolation.md §10) -
users see "unavailable," not a hang. If `ai-runtime` is confirmed down and the circuit hasn't
opened yet, that's expected until `INFERENCE_CIRCUIT_BREAKER_FAILURE_THRESHOLD` consecutive
failures accumulate; it will open on its own.

**Permanent remediation:**

- `ai-runtime` genuinely under-provisioned: scale its instance (it enforces one generation at a
  time by design - `services/ai-runtime/src/http-server.ts`'s `busy` flag - so this may mean more
  instances, not a bigger one, once the single-instance-store-ceiling work (see
  `docs/single-instance-store-ceiling.md`) makes a second API instance safe; until then, this is a
  hard ceiling worth knowing about, not something to fix by raising `INFERENCE_MAX_CONCURRENCY`
  past what one `ai-runtime` instance can actually do).
- Bulkhead genuinely too tight for real traffic: raise `INFERENCE_MAX_CONCURRENCY`/
  `INFERENCE_QUEUE_MAX`, redeploy, don't just restart.

## OCR saturation

**Symptoms:** `workload_active{name="ocr"}` at `workload_max_concurrency` (default 1);
`overload_rejection_total{name="ocr",reason="queue_full"}` climbing; users see
`ocr_worker_busy` (503, retryable).

**Diagnose:**

1. Is the OCR worker container (`grogoni-ocr-worker` on Render) itself slow/unhealthy? It has
   its own `OCR_CONCURRENCY` (default 1) semaphore independent of `services/api`'s - check the
   worker's own Render metrics (comment in render.yaml flags PaddleOCR's CPU inference as
   memory-hungry).
2. `circuit_breaker_state{name="ocr"}` - if open, `ocr_worker_unavailable` is expected until
   `OCR_CIRCUIT_BREAKER_RESET_TIMEOUT_MS` elapses and a probe succeeds.

**Emergency mitigation:** none needed beyond what already happens - OCR degrading never blocks
catalogue/product management (resource-isolation.md §10); manual entry stays available.

**Permanent remediation:**

- Worker under-provisioned: raise its Render plan/instance size, or raise
  `OCR_CONCURRENCY`/worker-side concurrency together (raising one without the other just moves the
  bottleneck).
- If retries are exhausting fast and tripping the circuit on transient blips: check
  `OCR_MAX_RETRIES`/`OCR_RETRY_INITIAL_DELAY_MS`/`OCR_RETRY_MAX_DELAY_MS` are reasonable for the
  worker's real latency distribution.

## Queue saturation (general)

Any bulkhead rejecting with `reason="queue_full"` in `overload_rejection_total` means real demand
exceeded `maxConcurrency + maxQueue` for that workload at that moment. This is intentional
backpressure working correctly, not itself a bug - the question is whether the budget matches real
traffic.

**Permanent remediation:** raise the relevant `*_MAX_CONCURRENCY`/`*_QUEUE_MAX` env var only after
confirming the _downstream_ dependency (ai-runtime, the OCR worker, the DB) can actually sustain
the higher concurrency - raising a bulkhead's budget without raising the capacity behind it just
moves the failure from "clean 503" to "everything times out instead," which is worse.

## Runaway cron job

**Symptoms:** a Render cron job (`db-backup`, `shop-purge`, `account-purge`, `db-health`) running
far longer than its schedule interval, or `scheduled_job_duration_seconds{job}` (for the six
in-process runners) showing an outlier duration.

**Diagnose:** Render cron jobs are isolated one-shot processes per trigger - they cannot overlap
with each other or with the API's pools by construction (see resource-isolation.md §12), so a slow
cron run degrades only itself, not the API. For the six in-process runners
(`services/api/src/cp2/*-runner.ts`, all built on the shared `createIntervalRunner` factory in
`interval-runner.ts`): each has a single-flight guard, so an overlapping tick collapses into the
already-running one rather than starting a second copy - check `scheduled_job_duration_seconds`
for which job is actually slow, not which one "seems to run often."

**Emergency mitigation:** for a Render cron job that's clearly hung, cancel that specific run from
the Render dashboard - do not touch the API service.

**Permanent remediation:** find what changed (data volume, a new slow query inside the job, a
downstream dependency) and fix that; do not "fix" a slow cron job by shortening its schedule, which
only makes overlap risk worse.

**Known limitation, not fixed in this pass:** none of the six in-process runners use
`pg_advisory_lock` or any cross-instance coordination. This is safe today only because
`render.yaml` deploys exactly one `grogoni` instance - see
`docs/single-instance-store-ceiling.md`. Do not add a second instance without first adding
cross-instance locking to these six runners (or resolving the single-instance-store ceiling, which
would let them move to a real worker process instead).

## External dependency outage (ai-runtime / OCR worker / Vercel / Neon)

The circuit breaker for that dependency (`circuit_breaker_state{name="inference"|"ocr"}`) should
open within `*_CIRCUIT_BREAKER_FAILURE_THRESHOLD` consecutive failures and stay open for
`*_CIRCUIT_BREAKER_RESET_TIMEOUT_MS`, at which point one probe is allowed through automatically.
No manual intervention is required for the circuit itself to recover once the dependency does.

**What to actually check:** is the dependency really down, or is Grogoni's own config wrong (a
rotated `GROGONI_INFERENCE_SERVICE_TOKEN`, an expired `OCR_WORKER_URL`)? A circuit that never closes
even after the dependency reports healthy elsewhere is a config problem, not a capacity problem.

## High CPU / memory symptoms

Given [`../single-instance-store-ceiling.md`](../single-instance-store-ceiling.md), the entire
business dataset lives in this one process's memory - watch `process_resident_memory_bytes`
(already exposed via prom-client's default metrics) as the primary signal, not CPU. A memory climb
that doesn't plateau is the single-instance ceiling being approached, not something the bulkheads
in this document can fix - see that document's "recommended path" for the real remediation
(it is a multi-week project, not a config change).

## Emergency mitigation vs. permanent remediation - the difference

Every section above separates these on purpose. An emergency mitigation buys time during an
incident (terminate one query, cancel one cron run, wait for a circuit's reset timeout). It never
addresses why the incident happened. If you only ever do the mitigation, the same page fires again
at the next traffic spike - the permanent remediation is not optional follow-up, it's the actual
fix.
