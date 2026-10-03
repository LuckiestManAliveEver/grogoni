# Observability: metrics

`services/api` exposes a Prometheus-format `GET /metrics` endpoint backed by
`packages/observability` (`@grogoni/observability`, wrapping the official
`@prometheus-io/client` - the package `prom-client` now redirects to). This is the "first
measure" pass called for in
[`docs/single-instance-store-ceiling.md`](./single-instance-store-ceiling.md)'s recommended
path, step 1 ("monitor process RSS in production"): before deciding whether/how to scale or
optimize the API, have real numbers for the things that would tell you it's necessary.

## What's measured, and where it comes from

| Metric                            | Source                                                                                              | Prometheus name(s)                                                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Memory                            | `@prometheus-io/client`'s default Node collectors, zero custom code                                 | `process_resident_memory_bytes`, `nodejs_heap_size_used_bytes`, `nodejs_heap_size_total_bytes`, `nodejs_external_memory_bytes`        |
| CPU                               | same default collectors                                                                             | `process_cpu_user_seconds_total`, `process_cpu_system_seconds_total`, `process_cpu_seconds_total`                                     |
| Event-loop lag                    | same default collectors, sampled via `perf_hooks.monitorEventLoopDelay`                             | `nodejs_eventloop_lag_seconds`, `_p50`, `_p90`, `_p99`                                                                                |
| API request latency (p50/p95/p99) | every request, via `app.ts`'s existing `onResponse` hook (reuses `reply.elapsedTime`, no new timer) | `http_request_duration_seconds_bucket{method,route,status_code}`                                                                      |
| Neon query latency                | `pool.query` wrapped in place at each `new Pool(...)` call site (`postgres-store.ts`, `index.ts`)   | `pg_query_duration_seconds_bucket{pool,operation,outcome}`                                                                            |
| Connection-pool saturation        | live gauges reading `pool.totalCount`/`idleCount`/`waitingCount` at scrape time (no polling timer)  | `pg_pool_total_connections`, `pg_pool_idle_connections`, `pg_pool_waiting_requests`, `pg_pool_max_connections` (all labeled `{pool}`) |
| Runtime/model-request latency     | every `ModelRuntimeAdapter` call (`canRun`/`healthCheck`/`generate`), wrapped in `index.ts`         | `model_request_duration_seconds_bucket{provider,model,execution_target,outcome}`                                                      |

Every metric also carries a `service="api"` label, so a second instrumented service can share
a scrape target without collisions.

Percentiles are **not** precomputed. Histograms are the correct primitive for latency that must
be aggregated across scrape windows or instances - a client-side "p95" number can't be
averaged or re-aggregated after the fact, a histogram can. Compute percentiles at query time:

```promql
histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, route))
histogram_quantile(0.99, sum(rate(pg_query_duration_seconds_bucket[5m])) by (le, pool))
```

Connection-pool saturation as a ratio:

```promql
(pg_pool_total_connections - pg_pool_idle_connections) / pg_pool_max_connections
```

## Instrumented pools today

- `cp2_primary` - the main store pool (`DB_POOL_MAX`, default 5).
- `cp2_realtime` - the dedicated `LISTEN/NOTIFY` connection (`max: 1` by design; see
  `docs/single-instance-store-ceiling.md`).
- `model_artifact_store` - only created when `VERCEL_INFERENCE_URL` is set (`max: 2`).

## Scraping it

```bash
curl -s http://127.0.0.1:4000/metrics
# or, in production, with the auth token set:
curl -s -H "x-metrics-token: $METRICS_AUTH_TOKEN" https://grogoni.com/metrics
```

`METRICS_AUTH_TOKEN` (render.yaml, `generateValue: true`) gates the endpoint in any
deployment reachable from the public internet - metrics reveal pool sizing, queue depth, and
per-route latency, which is real infrastructure detail. Point whatever scrapes this endpoint
(Prometheus, Grafana Cloud's agent, a one-off `curl` from a cron job) at the same token via its
`x-metrics-token` header. Locally, with no token configured, the endpoint is open. `/metrics` is
also exempt from the global HTTP rate limit (`app.ts`'s `allowList`), the same as `/health*`, so
a scraper polling every few seconds never gets throttled.

## What this does not cover yet

- `services/sync` and `services/ai-runtime` are not instrumented. The ceiling doc's concern is
  specifically `services/api`'s single in-memory store, so that's where this pass focused; wiring
  the other services in is a follow-up, and `@grogoni/observability` is already a shared package so
  doing so is additive (`createMetrics` + `instrumentPgPool` + the HTTP hook), not a rewrite.
- Nothing scrapes `/metrics` today (no Prometheus/Grafana deployed alongside this Blueprint).
  The endpoint is real and correct against a live pool - see the test suite - but a scraper and a
  dashboard are infrastructure this repo doesn't run yet.
