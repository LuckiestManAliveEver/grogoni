# Resource isolation audit (as of 2026-09-21)

Status: audit of the _current_ implementation, written before the resource-isolation changes in
this same pass. See [`resource-isolation.md`](./resource-isolation.md) for what changed and why.

This audit covers every finite shared resource in the repository: Postgres connections, HTTP
connections, inference concurrency, OCR concurrency, scheduled jobs, and rate limiting. It was
produced by reading the actual code, not by assuming a generic architecture.

## 0. The one fact that reframes this whole audit

Grogoni's API is **not** a stateless request/DB-query service. Per
[`docs/single-instance-store-ceiling.md`](../single-instance-store-ceiling.md),
`createPostgresCp2Store` (`services/api/src/cp2/postgres-store.ts`) loads the entire business
dataset into one process's memory at boot (`Cp2Store`, ~20k lines, ~100 collections) and every
read/mutation for auth, conversations, catalogue, and orders runs synchronously against in-process
`Map`/array state. Writes are mirrored to Postgres **asynchronously**, after the response, via a
coalesced, retried persistence queue (`enqueueSave` → `saveNormalizedSnapshot`). This is a
deliberate, documented, accepted limitation: single-instance only, memory-bound, not horizontally
scaled — and `render.yaml` deploys exactly one `grogoni` instance today, with no
`numInstances`/autoscaling block anywhere in the file.

Consequence for this audit: the classic failure mode this task describes — "a background query
holds all the DB connections, so a critical request blocks waiting for one" — mostly does not
apply to the _business-logic critical path_ (auth, chat, catalogue reads, order creation), because
that path does not query Postgres per request at all. It applies instead to:

- the **async persistence path** (all of it, critical and background alike, funnels through the
  same in-memory store and the same `cp2_primary` pool),
- the small set of request paths that **do** hit Postgres directly (model-artifact resolution for
  inference, the `/health/ready` and `/health/db` checks), and
- the **cross-workload contention** between six in-process background runners and the same pools.

The rest of this audit is organized around what's actually true here, not a generic template.

## 1. PostgreSQL connections

Three separate `pg.Pool` instances exist in the `grogoni` process, all created in
`services/api/src/index.ts` / `services/api/src/cp2/postgres-store.ts`:

| Pool                   | File:line                                                          | Max                                     | Timeouts configured?                                                                                           | Purpose                                                             |
| ---------------------- | ------------------------------------------------------------------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `cp2_primary`          | `postgres-store.ts:516` (`poolConfig()`, `postgres-store.ts:1206`) | `DB_POOL_MAX` (default 5)               | Yes — `connectionTimeoutMillis`, `idleTimeoutMillis`, `query_timeout`, `statement_timeout`, all env-driven     | Boot-time snapshot load, async persistence writes, `health()` reads |
| `cp2_realtime`         | `postgres-store.ts:587`                                            | 1 (hardcoded, same `poolConfig()` base) | Yes (inherits `poolConfig()`)                                                                                  | Single dedicated connection holding `LISTEN grogoni_sync_changes`      |
| `model_artifact_store` | `index.ts:63`                                                      | 2 (hardcoded)                           | **No** — only `{ connectionString, max: 2 }`, no `connectionTimeoutMillis`/`query_timeout`/`statement_timeout` | Resolves/verifies model artifacts on the inference path             |

All three are registered with `@grogoni/observability`'s `instrumentPgPool()`
(`packages/observability/src/index.ts:176`), which wraps `pool.query` for per-pool query-duration
histograms and exposes `pg_pool_total_connections` / `pg_pool_idle_connections` /
`pg_pool_waiting_requests` / `pg_pool_max_connections` gauges, sampled live at scrape time. Nothing
currently reads `pg_pool_waiting_requests` to trigger backpressure — it's Prometheus-only.

**Gap found:** `poolConfig()` in `postgres-store.ts:1206` and `databasePoolConfig()` in
`services/api/scripts/database-connection.mjs:70` are two independently-written, near-identical
implementations of the same env-driven pool-config logic (same env var names, same defaults,
same SSL-mode detection) — one for the long-running server, one for one-off scripts
(`db:health`, `db:purge-shops`, etc., each with `poolMaxFallback: 1`). The `model_artifact_store`
pool in `index.ts:63` uses neither and gets no timeout protection at all: a hung artifact-store
query would hold one of only 2 connections indefinitely, no `query_timeout` to kill it.
`services/api/scripts/audit-phone-identities.ts:31` and `services/api/scripts/run-ai-eval.ts:55`
have their own ad hoc `new Pool(...)` calls too.

**Total budget:** with today's defaults, the `grogoni` process opens at most `5 + 1 + 2 = 8`
Postgres connections. Cron jobs (`db:backup`, `db:purge-shops`, `db:purge-accounts`, `db:health`)
each run as a separate one-shot Render process with their own pool (`db:health`'s cron entry in
`render.yaml` explicitly sets `DB_POOL_MAX=2`, the only place in the repo with intentional
per-workload pool sizing today) — they never contend with the API process for connections, because
they are different OS processes entirely, not because of any budget enforcement.

**Neon pooling / serverless multiplication:** not applicable today — `render.yaml` deploys
`grogoni` as a single `type: web`/`runtime: node` Render service (a long-lived container, not
serverless functions), so there is exactly one pool instance per pool per deploy, not one per
invocation. `services/ai-runtime` similarly runs as a container (`http-server.ts`) in production,
with a Vercel edge/serverless handler (`vercel-handler.ts`) as an alternate deployment shape not
used by the current `render.yaml`.

## 2. Query safety

`/health/ready` → `options.databaseHealth()` → `cp2Store.health()`
(`services/api/src/cp2/postgres-store.ts:858`) is a genuine problem, found in this audit:

```sql
select
  (select filename from grogoni_schema_migrations order by filename desc limit 1) as latest_migration,
  (select count(*) from account_sync_changes)::text as sync_change_count,
  (select count(*) from otp_challenges)::text as otp_relational_count,
  (select md5(coalesce(string_agg(id::text, ',' order by id::text), '')) from otp_challenges) as otp_relational_checksum,
  -- ...five more (sessions, user_identities, oauth_sessions, account_pin_hashes, device_trust),
  -- each doing a count(*) AND an md5(string_agg(...)) full-table scan, both sides (relational + compatibility copy)
```

This runs a `count(*)` **and** a `md5(string_agg(...))` full-table scan over both the relational
and legacy-compatibility copies of six tables (`otp_challenges`, `sessions`, `user_identities`,
`oauth_sessions`, `account_pin_hashes`, `device_trust`) — twelve table scans total — on **every
single call to `/health/ready`**. `render.yaml` wires `/health/ready` as the service's
`healthCheckPath`, so Render polls it repeatedly (health checks during every deploy, plus ongoing
liveness monitoring), against the same 5-connection `cp2_primary` pool that also serves live
persistence writes. This was a reasonable one-time migration-parity verification query; used as a
recurring readiness probe, it is a self-inflicted resource-pressure source that gets strictly worse
as these tables grow, with no natural warning before it starts measurably competing with real
traffic for pool capacity. **This is fixed in this pass** — see
[`resource-isolation.md`](./resource-isolation.md) §2.

No other N+1 patterns, missing-`LIMIT` scans, or per-request Postgres queries were found on the
critical commerce path, because — per §0 — that path does not query Postgres per request at all.
`saveNormalizedSnapshot`'s per-mutation full-collection re-persist and its retry/backoff/coalescing
were already found and fixed in a prior pass (documented in
`docs/single-instance-store-ceiling.md`, "A review of database persistence..." section) — not
revisited here since it's already correct and tested (`tests/cp2-postgres-store.test.ts` et al.).

## 3. Bounded concurrency

| Workload                              | Concurrency control                                                                           | File                                                                                                                                                       |
| ------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OCR (services/api → OCR worker)       | Semaphore, `OCR_CONCURRENCY` (default 1)                                                      | `services/api/src/cp2/ocr-provider.ts:47,233-256`                                                                                                          |
| OCR worker itself (Python)            | `threading.BoundedSemaphore(OCR_CONCURRENCY)` (default 1)                                     | `services/receipt-ocr-service/worker.py:169,188`                                                                                                           |
| Inference (services/api → ai-runtime) | **None**                                                                                      | `services/api/src/inference/model-runtime.ts` — every conversation turn needing inference calls `createVercelInferenceClient.infer()` directly, no limiter |
| Inference (ai-runtime itself)         | Single global `busy` boolean — one generation at a time, process-wide                         | `services/ai-runtime/src/http-server.ts:15,48-52`                                                                                                          |
| Inference (owner-node / on-device)    | Per-node cap (`maxConcurrentJobs`, 1-4) + per-user registration cap (default 5)               | `services/api/src/inference/owner-node-broker.ts:59,66-68,218`                                                                                             |
| Scheduled/background runners          | Single-flight guard per runner (`inFlight` promise), not a concurrency _limit_ across runners | `services/api/src/cp2/*-runner.ts` (6 runners, identical shape)                                                                                            |

**Gap found:** `services/api`'s inference client has no concurrency limiter of its own. It relies
entirely on `ai-runtime`'s single `busy` flag to reject overload as an HTTP 503
(`INFERENCE_BUSY`, `retry-after: 1`) — which `services/api` then surfaces as a retryable
`ModelRuntimeError` with **no automatic retry** (`createVercelInferenceClient.infer()` makes a
single attempt; retry across model/host targets is a different mechanism,
`INFERENCE_MAX_FALLBACKS`). A burst of concurrent conversation turns today produces a burst of
user-visible failures rather than smooth, bounded queuing — there is no queue depth, no explicit
overload response shaped for the caller, and no protection against repeatedly hammering an
`ai-runtime` instance that is clearly down. **This is fixed in this pass.**

## 4. Backpressure

- OCR: bounded by its semaphore (concurrency 1 both sides); no explicit _queue_ depth limit beyond
  whatever requests happen to be waiting on the semaphore in memory — an unbounded number of
  callers can await the semaphore simultaneously today (no queue-full rejection).
- Inference: `ai-runtime`'s `busy` flag _is_ backpressure (immediate 503 + `Retry-After: 1`,
  correct HTTP semantics per §7 of the task spec) but only protects `ai-runtime` itself; nothing
  bounds how many `services/api` requests can be in flight toward it at once before that 503 fires.
- HTTP request volume overall: `@fastify/rate-limit` (`services/api/src/app.ts:83-96`), global,
  Redis-backed (`grogoni-rate-limit-cache`), 300 req/min default / 60 req/min for `/auth/*`,
  keyed by IP. This is a real, working, already-correct backstop against request volume — not
  scoped per-workload, and not the mechanism this audit is about (queue/concurrency bounds for
  _expensive_ operations, not raw request counting).
- No unbounded in-memory queues were found anywhere in the repo.

## 5. Timeouts

| Boundary                              | Timeout                                                                  | File                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| DB connection acquisition             | `DB_CONNECTION_TIMEOUT_MS` (default 5000ms)                              | `postgres-store.ts:1215`                                                           |
| DB query execution                    | `DB_QUERY_TIMEOUT_MS` / `DB_STATEMENT_TIMEOUT_MS` (default 15000ms each) | `postgres-store.ts:1218-1219` — **not applied to the `model_artifact_store` pool** |
| Inference (services/api → ai-runtime) | `VERCEL_INFERENCE_TIMEOUT_MS` (default 300000ms), `AbortController`      | `model-runtime.ts:95-134`                                                          |
| Inference (ai-runtime HTTP server)    | `server.requestTimeout=30000`, `server.headersTimeout=10000`             | `services/ai-runtime/src/http-server.ts:22-23`                                     |
| OCR                                   | `OCR_JOB_TIMEOUT_SECONDS` (default 120s), `AbortSignal.timeout()`        | `ocr-provider.ts:46,66`                                                            |
| Owner-node inference job              | `INFERENCE_JOB_TIMEOUT_MS` (default 120000ms)                            | `owner-node-broker.ts:124,138-140`                                                 |

Every network boundary found already has an explicit timeout with cancellation propagation
(`AbortController`/`AbortSignal`). This is already correct and was not a gap.

## 6. Retry policy

- **OCR retries with no backoff** — `ocr-provider.ts:60-87` retries up to `OCR_MAX_RETRIES`
  (default 2) on 5xx/network failure, **immediately**, with no delay or jitter between attempts.
  This is exactly the "immediate retry loop" pattern this task's rules call out to eliminate.
  **Fixed in this pass** (bounded exponential backoff + jitter).
- Inference has no retry within a single client call (`createVercelInferenceClient.infer()` is
  single-attempt) — retry-shaped behavior instead happens as _fallback_ across
  agent/model/execution-host targets (`INFERENCE_MAX_FALLBACKS`), a distinct, already-correct
  mechanism (don't retry a request against the same failing target; try a different one).
- Persistence writes (`postgres-store.ts`) already use bounded exponential backoff, capped at
  `DB_PERSISTENCE_RETRY_MAX_MS` — already correct, not touched.
- No retry loop anywhere retries a non-retryable failure class (auth/validation failures are not
  retried; `ModelRuntimeError.retryable` and `Cp2Error` status codes already distinguish this).

## 7. Circuit breakers

**None exist anywhere in the repository** — confirmed by exhaustive grep across `services/`,
`packages/`, and `packages/observability` (which only does metrics instrumentation, no
breaker/limiter logic). Repeated failures against `ai-runtime` or the OCR worker today just keep
retrying/timing out at whatever rate callers arrive, with no fail-fast state. **Added in this
pass** for inference and OCR.

## 8. Graceful degradation

- Inference failure: `runtimeProviderFromAdapter` (`model-runtime.ts:291-339`) already catches
  every adapter failure and returns a typed `RuntimeModelCompletionResult` with
  `status: "unavailable" | "timeout"` rather than throwing into the conversation turn — this is
  already the correct degradation shape (preserve conversation, return a deterministic
  unavailable state, no corrupted task state).
- OCR failure: raises a typed `Cp2Error` (502/503/422) that the route handler surfaces to the
  client; manual catalogue/product entry remains available since OCR is opt-in enrichment, not a
  blocking dependency of catalogue writes.
- Already correct; not changed in this pass beyond adding the circuit breaker (§7), which makes
  degradation _faster_ under sustained outage instead of retrying into every request.

## 9. RuntimeHandoff

Extremely mature already — this is not a gap area. `packages/shared-types/src/runtime-handoff.ts`
defines the full protocol (`RuntimeHandoff`, `RuntimeTaskHead`, `RuntimeTaskInstance`,
`RuntimeTransfer`), persisted via `infra/db/migrations/083_runtime_handoff_protocol.sql` /
`085_runtime_transfers.sql` with DB-level immutability enforcement (a trigger rejects any `UPDATE`
to a handoff's `record`) and a dedicated generic idempotency table
(`cp2_runtime_operation_dedup`). `services/api/src/cp2/domains/runtime-handoff/store.ts`
(`RuntimeHandoffDomain`) implements `createCheckpoint`, `checkpointAfterTurn`, `performSwap`,
`rollback`, `resume` (with legacy bootstrap), `syncOfflineCheckpoints`, `mergeCheckpoints`, and
cross-host `beginTransfer`/`completeTransfer`/`failTransfer` with a 120s expiry — every mutation
already idempotency-keyed via `withIdempotency`. `acquireTurn` already provides per-task mutual
exclusion so a task can't execute two turns concurrently.

This audit did not find a missing handoff mechanism to build. What it found missing is the
_trigger_: nothing today checkpoints a task specifically _because_ the inference circuit breaker
opened or the bounded queue is full, as distinct from an ordinary inference failure. Given
`performSwap`'s existing fallback-across-targets behavior already covers "this execution target
failed, try another," and `RuntimeModelCompletionResult.status` already propagates
unavailable/timeout without corrupting state, the circuit breaker added in this pass emits the
same failure shape the runtime already knows how to handle — see
[`resource-isolation.md`](./resource-isolation.md) §9 for exactly how the two connect.

## 10. Bulkhead architecture

Today: OCR and inference are already separate failure domains (different services, different
processes, different HTTP boundaries) — a crash or saturation in one cannot directly crash the
other. What's missing is _bounded concurrency for inference on the caller side_ (§3) and a
_shared, reusable_ bulkhead primitive — OCR's semaphore (`ocr-provider.ts:233-256`) is a private,
un-exported implementation that nothing else can reuse, so any future bounded workload would be
tempted to write a fourth one. **Fixed in this pass** by extracting one reusable bulkhead used by
both OCR and inference.

## 11. Scheduled job safety

Two distinct mechanisms, both already safe:

- **Render cron jobs** (`db:backup` 02:17, `db:purge-shops` 03:37, `db:purge-accounts` 04:07,
  `db:health` every 10 min — all in `render.yaml`): each trigger spins up a fresh, isolated Render
  process with its own Postgres pool. They cannot overlap with the API process's pools (different
  OS processes) and Render does not start a new cron invocation while a previous one is still the
  active instance for that trigger.
- **Six in-process `setInterval` runners** (`services/api/src/cp2/*-runner.ts`: connected-mailbox
  sync, notification delivery, conversation recycle-bin, agent-owner-correction retention,
  grogoniId cooldown, account deletion): every one follows an identical, already-correct shape —
  `setInterval(() => void runNow(), intervalMs)`, `.unref()`'d, with a single `inFlight` promise
  guard so a tick that arrives while the previous run is still active collapses into the same
  in-flight promise rather than starting a second overlapping run. This _is_ the "prevent
  overlapping execution" requirement, already implemented, independently, six times.

No `pg_advisory_lock`-based cross-instance job lock exists for these six runners — not a gap
today (single instance, per §0), but would become one the day a second `grogoni` instance is
introduced. Documented as a known limitation, not fixed in this pass (fixing it now would add
locking machinery whose only justification is a deployment topology that `render.yaml` does not
have and `docs/single-instance-store-ceiling.md` explicitly says not to introduce yet — see
`resource-isolation.md`'s "what we deliberately did not do" section).

## 12. Load shedding

No explicit load-shedding-by-priority exists yet. `pg_pool_waiting_requests` (already a gauge, §1)
and the new bulkhead queue-depth metrics (§3, added this pass) are the measurable signals a future
load-shedder would read; wiring an actual shedding policy on top is out of scope for this pass
(see `resource-isolation.md`'s scope notes) since no workload today is unbounded enough to need it
beyond what bounded concurrency + circuit breaking already provides.

## 13. Health and readiness

Already correctly separated, and already matches the task's own stated requirement that a failed
inference provider must not fail liveness:

- `GET /health/live` (`app.ts:395`) — pure liveness, zero I/O, always `200`.
- `GET /health/ready` (`app.ts:401`) — readiness, checks DB health and (only if
  `INFERENCE_REQUIRED=true`) inference health; `503` if not ready. Inference being down does
  **not** fail readiness unless the deployment explicitly promised zero-setup AI
  (`INFERENCE_REQUIRED`) — exactly the intended semantics.
- `GET /health/ai` (`app.ts:433`) — separate, explicit, forces a live inference probe.
- `GET /health/db` (`app.ts:461`) — separate, explicit DB detail endpoint.

Only gap: `/health/ready`'s DB check (`cp2Store.health()`) is the expensive query from §2 —
correct _shape_, wrong _cost_. Fixed in this pass without changing the shape.

## 14. Graceful shutdown

Already implemented, most recently in this branch's own last commit
(`a4ce5fa feat(api): gracefully drain during rolling deploys`,
`services/api/src/index.ts:309-333`): `SIGTERM`/`SIGINT` trigger `app.close()` (stops accepting
new connections, drains in-flight requests), with a `SHUTDOWN_GRACE_MS` (default 25000ms) forced
exit if draining hangs, and an `onClose` hook (`index.ts:214-226`) that stops every background
runner, disconnects the rate-limit Redis client, closes the artifact pool, and closes the CP2
store (which itself flushes the persistence queue and closes both its pools) — in that order,
before the process exits. Not a gap; not touched in this pass.

## 15. Observability

`@grogoni/observability` (`packages/observability/src/index.ts`) already provides, via
`@prometheus-io/client`: default Node metrics (RSS, CPU, event-loop lag), an HTTP request-duration
histogram, a per-pool query-duration histogram plus total/idle/waiting/max connection gauges for
every registered pool, and a model-request-duration histogram. `GET /metrics`
(`app.ts:447`, gated by `METRICS_AUTH_TOKEN`) exposes all of it in Prometheus text format. Nothing
currently scrapes it in production and no alerting is wired — a pre-existing gap noted in
`docs/single-instance-store-ceiling.md`, unrelated to this task and not addressed here (it's an
infrastructure/ops decision, not a code gap).

**Gap found:** none of the metrics this task specifically asks for exist yet —
`workload_active{class}`/`workload_rejected{class}`, `inference_queue_depth`, `ocr_queue_depth`,
`circuit_breaker_state`, `overload_rejection_total`, `scheduled_job_duration`/`failure`. Added in
this pass, reusing the existing `@prometheus-io/client`-backed `Metrics` object — no new
observability vendor.

## 16. Idempotency

Mature and pervasive — not a gap area. Runtime handoff/transfer operations, messaging (outbound
messages, SMS/email auto-replies, provider webhook updates), the offline sync queue, device
bootstrap, OTP email sends, account-deletion webhooks, and network invites all have explicit
idempotency keys today, per-domain. The newest addition,
`cp2_runtime_operation_dedup` (migration 083), is the first _generic_, reusable idempotency-key
primitive in the codebase; earlier idempotency is scattered, working, per-domain in-memory maps.
Not touched in this pass.

## 17. Security / rate limiting

`@fastify/rate-limit`, global, Redis-backed, IP-keyed, `/auth/*` at 60 req/min vs. 300 req/min
elsewhere (`app.ts:83-96`) — already a working backstop against a single client generating
unbounded request volume. It does not (and by design should not) protect OCR/inference _worker_
capacity directly — that's what the concurrency limiter and circuit breaker added in this pass are
for; the HTTP-level limiter and the workload-level bulkhead are complementary, not duplicative.

## 18. Deployment topology (render.yaml)

- `grogoni` (`type: web`, `runtime: node`, `plan: starter`) — the API, single instance, no
  autoscaling block. `healthCheckPath: /health/ready`.
- `grogoni-rate-limit-cache` (`type: keyvalue`) — Redis, backs the rate limiter.
- `grogoni-ocr-worker` (`type: pserv`, `runtime: docker`) — private network only, not
  public-facing; the codebase's only existing example of a workload already isolated into its own
  Render service.
- `grogoni-web-staging` (`type: web`, `runtime: static`) — unrelated to backend resources.
- Four `type: cron` jobs (`db-backup`, `shop-purge`, `account-purge`, `db-health`) — each an
  isolated one-shot process; `db-health` is the only place with intentionally different
  (smaller) pool sizing (`DB_POOL_MAX=2`) than the main API today.

Three of six background runners live **in-process inside the same web dyno as request
handling** (connected-mailbox sync, notification delivery, grogoniId cooldown are always-on by
default; conversation recycle-bin and owner-correction retention likewise; account deletion is
opt-in). This is consistent with §0: since the business-logic store is single-process and
in-memory by design, these runners operate on that same in-memory store directly — they could not
be split into a separate worker process without first resolving the single-instance-store
limitation (`docs/single-instance-store-ceiling.md`), which is explicitly out of scope for this
pass (a documented multi-week rewrite, not a same-session change).

## Summary: real gaps found, in priority order

1. **No bounded concurrency or circuit breaker on inference calls from `services/api`** (§3, §7) —
   highest priority; the only expensive workload with truly unbounded concurrency today.
2. **`/health/ready` runs 12 full-table scans per poll** against the same pool serving live traffic
   (§2, §13) — a self-inflicted, worsening-over-time resource-pressure source on the exact endpoint
   Render uses to decide whether to route traffic to this instance.
3. **`model_artifact_store` pool has no timeouts** and three pool-config implementations exist
   with no shared source of truth (§1).
4. **OCR retries immediately with no backoff/jitter** (§6).
5. **No reusable bounded-concurrency primitive** — OCR's semaphore is private and unexported (§10).
6. **No resource-pressure telemetry for any of the above** (§15).

Everything else audited — rate limiting, timeouts, graceful shutdown, health/readiness
_separation_, idempotency, RuntimeHandoff, scheduled-job overlap protection — was already correct
and is left untouched.
