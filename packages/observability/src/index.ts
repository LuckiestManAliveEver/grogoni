import { Registry, Histogram, Gauge, Counter, collectDefaultMetrics } from "@prometheus-io/client";
import type { Bulkhead, CircuitBreaker, CircuitState } from "@grogoni/resource-control";

export type { Registry } from "@prometheus-io/client";

/** The subset of a resource-control event this module cares about - a structural type so this
 *  package never imports `@grogoni/resource-control`'s bulkhead/circuit-breaker event unions just to
 *  read three fields off them. */
export type ResourceControlMetricEvent =
  | { type: "capacity_reached"; name: string; workloadClass: string }
  | {
      type: "operation_rejected";
      name: string;
      workloadClass: string;
      reason: "queue_full" | "queue_timeout";
    }
  | { type: "opened" | "closed" | "half_open_probe"; name: string };

/**
 * The minimal shape of a `pg.Pool` this package instruments. Structural, not a `pg` import, so
 * this package stays dependency-free of the driver and works with any pool implementing it.
 */
export interface QueryablePool {
  query: (...args: unknown[]) => Promise<unknown>;
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
  options?: { max?: number };
}

export interface ModelRequestLabels {
  provider: string;
  model: string;
  executionTarget: string;
}

export interface HttpRequestObservation {
  method: string;
  route: string;
  statusCode: number;
  durationSeconds: number;
}

export interface InstrumentPoolOptions {
  /** Low-cardinality identifier for this pool, e.g. "cp2_primary", "cp2_realtime". */
  poolName: string;
  /** Overrides the pool's own configured max when it isn't reliably readable (e.g. a mock in tests). */
  maxConnections?: number;
}

export interface Metrics {
  readonly registry: Registry;
  readonly contentType: string;
  /** Prometheus text exposition of every metric currently registered. */
  metricsText(): Promise<string>;
  /**
   * Records one HTTP server request's duration. Percentiles (p50/p95/p99) are not computed here -
   * they come from running `histogram_quantile()` over `http_request_duration_seconds_bucket` at
   * query time, which is the standard Prometheus pattern and the only way to aggregate percentiles
   * correctly across multiple instances or scrape windows.
   */
  httpRequestDuration(observation: HttpRequestObservation): void;
  /**
   * Wraps `pool.query` in place (the same object is returned) so every caller already holding a
   * reference to this pool - including call sites that predate this instrumentation - starts
   * reporting query latency for free. Also registers this pool with the shared connection-pool
   * gauges (`pg_pool_total_connections` etc.), sampled live from the pool at scrape time.
   */
  instrumentPgPool<TPool extends QueryablePool>(pool: TPool, options: InstrumentPoolOptions): TPool;
  /**
   * Times an async model-runtime call and observes it into `model_request_duration_seconds`,
   * labeled by outcome ("success" if the call resolved, "error" if it threw). Rethrows whatever
   * `fn` throws after recording it - this never swallows or changes runtime behavior.
   */
  timeModelRequest<T>(labels: ModelRequestLabels, fn: () => Promise<T>): Promise<T>;
  /**
   * Registers a `Bulkhead` (resource-isolation.md §3/§10) so its live active/queued/budget
   * numbers are sampled into `workload_active`/`workload_queued`/`workload_max_concurrency`/
   * `workload_max_queue`, labeled `{name, workload_class}`, the same live-sampling pattern as
   * `instrumentPgPool`'s connection gauges.
   */
  instrumentBulkhead(bulkhead: Bulkhead): Bulkhead;
  /**
   * Registers a `CircuitBreaker` so its live state is sampled into `circuit_breaker_state`
   * (0=closed, 1=half_open, 2=open), labeled `{name}`.
   */
  instrumentCircuitBreaker(breaker: CircuitBreaker): CircuitBreaker;
  /**
   * Feeds one bulkhead/circuit-breaker event into the event-driven counters this module cannot
   * derive by live sampling: `overload_rejection_total{name, workload_class, reason}` and
   * `circuit_breaker_transitions_total{name, state}`. Call this from every bulkhead's/breaker's
   * `onEvent` callback.
   */
  recordResourceEvent(event: ResourceControlMetricEvent): void;
  /**
   * Times a scheduled job/background runner and observes it into `scheduled_job_duration_seconds`
   * (labeled `{job, outcome}`), also incrementing `scheduled_job_failure_total{job}` on throw.
   * Rethrows whatever `fn` throws after recording it.
   */
  timeScheduledJob<T>(job: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Records one multi-provider inference attempt (services/api/src/inference/providers):
   * `inference_requests_total`, `inference_errors_total`, `inference_latency_ms`,
   * `inference_first_token_ms`, `inference_input_tokens`, `inference_output_tokens`,
   * `inference_estimated_cost`, `provider_rate_limits`, `provider_fallbacks`. Labels are limited to
   * provider, model, execution_target and status - never user ids, tenants, prompts, or keys.
   */
  recordInference(observation: InferenceMetricObservation): void;
}

export interface InferenceMetricObservation {
  provider: string;
  model: string;
  executionTarget: string;
  status: "succeeded" | "failed" | "rejected";
  errorCode: string | null;
  latencyMs: number | null;
  firstTokenMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCost: number | null;
  currency: string | null;
  fallback: boolean;
}

export interface CreateMetricsOptions {
  /** Attached as the `service` label on every metric in this registry. */
  serviceName: string;
  /**
   * Passed through to prom-client's `collectDefaultMetrics` for event-loop lag sampling
   * resolution (milliseconds). Lower is more precise and slightly more overhead; prom-client's
   * own default is 10.
   */
  eventLoopMonitoringPrecision?: number;
}

const httpDurationBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const dbQueryDurationBuckets = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
const modelRequestDurationBuckets = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 40, 80];

export function createMetrics(options: CreateMetricsOptions): Metrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service: options.serviceName });
  collectDefaultMetrics({
    register: registry,
    eventLoopMonitoringPrecision: options.eventLoopMonitoringPrecision ?? 10
  });

  const httpHistogram = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP server request duration in seconds. Derive p50/p95/p99 with histogram_quantile().",
    labelNames: ["method", "route", "status_code"],
    buckets: httpDurationBuckets,
    registers: [registry]
  });

  const dbHistogram = new Histogram({
    name: "pg_query_duration_seconds",
    help: "Postgres (Neon) query round-trip duration in seconds, as observed by the pool.",
    labelNames: ["pool", "operation", "outcome"],
    buckets: dbQueryDurationBuckets,
    registers: [registry]
  });

  const modelHistogram = new Histogram({
    name: "model_request_duration_seconds",
    help: "Model runtime request duration in seconds.",
    labelNames: ["provider", "model", "execution_target", "outcome"],
    buckets: modelRequestDurationBuckets,
    registers: [registry]
  });

  const inferenceLabelNames = ["provider", "model", "execution_target", "status"] as const;
  const inferenceRequests = new Counter({
    name: "inference_requests_total",
    help: "Multi-provider inference attempts, by outcome.",
    labelNames: inferenceLabelNames,
    registers: [registry]
  });
  const inferenceErrors = new Counter({
    name: "inference_errors_total",
    help: "Failed or rejected inference attempts, by normalized error code.",
    labelNames: [...inferenceLabelNames, "code"],
    registers: [registry]
  });
  const inferenceLatency = new Histogram({
    name: "inference_latency_ms",
    help: "Inference request latency in milliseconds.",
    labelNames: inferenceLabelNames,
    buckets: [50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 20_000, 40_000, 80_000],
    registers: [registry]
  });
  const inferenceFirstToken = new Histogram({
    name: "inference_first_token_ms",
    help: "Time to first streamed token in milliseconds.",
    labelNames: inferenceLabelNames,
    buckets: [50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 20_000],
    registers: [registry]
  });
  const inferenceInputTokens = new Counter({
    name: "inference_input_tokens",
    help: "Input tokens reported by providers.",
    labelNames: inferenceLabelNames,
    registers: [registry]
  });
  const inferenceOutputTokens = new Counter({
    name: "inference_output_tokens",
    help: "Output tokens reported by providers.",
    labelNames: inferenceLabelNames,
    registers: [registry]
  });
  const inferenceEstimatedCost = new Counter({
    name: "inference_estimated_cost",
    help: "Estimated inference cost from catalog pricing, by currency.",
    labelNames: [...inferenceLabelNames, "currency"],
    registers: [registry]
  });
  const providerRateLimits = new Counter({
    name: "provider_rate_limits",
    help: "Requests rejected by a provider rate limit or a Grogoni budget/rate policy.",
    labelNames: ["provider", "code"],
    registers: [registry]
  });
  const providerFallbacks = new Counter({
    name: "provider_fallbacks",
    help: "Inference attempts made under an explicit fallback policy.",
    labelNames: ["provider", "model", "execution_target"],
    registers: [registry]
  });

  const instrumentedPools = new Map<
    string,
    { pool: QueryablePool; maxConnections: number | null }
  >();

  new Gauge({
    name: "pg_pool_total_connections",
    help: "Connections currently held by the pool (idle + active).",
    labelNames: ["pool"],
    registers: [registry],
    collect(this: Gauge<"pool">) {
      for (const [poolName, entry] of instrumentedPools) {
        this.set({ pool: poolName }, entry.pool.totalCount);
      }
    }
  });

  new Gauge({
    name: "pg_pool_idle_connections",
    help: "Idle (not currently checked out) connections held by the pool.",
    labelNames: ["pool"],
    registers: [registry],
    collect(this: Gauge<"pool">) {
      for (const [poolName, entry] of instrumentedPools) {
        this.set({ pool: poolName }, entry.pool.idleCount);
      }
    }
  });

  new Gauge({
    name: "pg_pool_waiting_requests",
    help: "Queries currently waiting for a free connection.",
    labelNames: ["pool"],
    registers: [registry],
    collect(this: Gauge<"pool">) {
      for (const [poolName, entry] of instrumentedPools) {
        this.set({ pool: poolName }, entry.pool.waitingCount);
      }
    }
  });

  new Gauge({
    name: "pg_pool_max_connections",
    help: "Configured maximum size of the pool. Compare against pg_pool_total_connections for saturation.",
    labelNames: ["pool"],
    registers: [registry],
    collect(this: Gauge<"pool">) {
      for (const [poolName, entry] of instrumentedPools) {
        if (entry.maxConnections !== null) this.set({ pool: poolName }, entry.maxConnections);
      }
    }
  });

  const instrumentedBulkheads = new Map<string, Bulkhead>();
  const instrumentedBreakers = new Map<string, CircuitBreaker>();

  new Gauge({
    name: "workload_active",
    help: "Operations currently running inside a bounded workload (bulkhead).",
    labelNames: ["name", "workload_class"],
    registers: [registry],
    collect(this: Gauge<"name" | "workload_class">) {
      for (const bulkhead of instrumentedBulkheads.values()) {
        this.set(
          { name: bulkhead.name, workload_class: bulkhead.workloadClass },
          bulkhead.stats().active
        );
      }
    }
  });

  new Gauge({
    name: "workload_queued",
    help: "Operations currently waiting for a free slot in a bounded workload (bulkhead).",
    labelNames: ["name", "workload_class"],
    registers: [registry],
    collect(this: Gauge<"name" | "workload_class">) {
      for (const bulkhead of instrumentedBulkheads.values()) {
        this.set(
          { name: bulkhead.name, workload_class: bulkhead.workloadClass },
          bulkhead.stats().queued
        );
      }
    }
  });

  new Gauge({
    name: "workload_max_concurrency",
    help: "Configured concurrency budget for a bounded workload (bulkhead).",
    labelNames: ["name", "workload_class"],
    registers: [registry],
    collect(this: Gauge<"name" | "workload_class">) {
      for (const bulkhead of instrumentedBulkheads.values()) {
        this.set(
          { name: bulkhead.name, workload_class: bulkhead.workloadClass },
          bulkhead.stats().maxConcurrency
        );
      }
    }
  });

  new Gauge({
    name: "workload_max_queue",
    help: "Configured wait-queue budget for a bounded workload (bulkhead).",
    labelNames: ["name", "workload_class"],
    registers: [registry],
    collect(this: Gauge<"name" | "workload_class">) {
      for (const bulkhead of instrumentedBulkheads.values()) {
        this.set(
          { name: bulkhead.name, workload_class: bulkhead.workloadClass },
          bulkhead.stats().maxQueue
        );
      }
    }
  });

  new Gauge({
    name: "circuit_breaker_state",
    help: "0=closed, 1=half_open, 2=open.",
    labelNames: ["name"],
    registers: [registry],
    collect(this: Gauge<"name">) {
      for (const breaker of instrumentedBreakers.values()) {
        this.set({ name: breaker.name }, circuitStateValue(breaker.state()));
      }
    }
  });

  const overloadRejectionCounter = new Counter({
    name: "overload_rejection_total",
    help: "Operations rejected because a bounded workload's queue was full or a queued wait timed out.",
    labelNames: ["name", "workload_class", "reason"],
    registers: [registry]
  });

  const circuitBreakerTransitionCounter = new Counter({
    name: "circuit_breaker_transitions_total",
    help: "Circuit breaker state transitions and half-open probes.",
    labelNames: ["name", "state"],
    registers: [registry]
  });

  const scheduledJobHistogram = new Histogram({
    name: "scheduled_job_duration_seconds",
    help: "Scheduled/background job run duration in seconds.",
    labelNames: ["job", "outcome"],
    buckets: [0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 120, 300],
    registers: [registry]
  });

  const scheduledJobFailureCounter = new Counter({
    name: "scheduled_job_failure_total",
    help: "Scheduled/background job runs that threw.",
    labelNames: ["job"],
    registers: [registry]
  });

  return {
    registry,
    contentType: registry.contentType,
    metricsText: () => registry.metrics(),

    httpRequestDuration({ method, route, statusCode, durationSeconds }) {
      httpHistogram.observe(
        { method, route, status_code: String(statusCode) },
        Math.max(0, durationSeconds)
      );
    },

    instrumentPgPool(pool, { poolName, maxConnections }) {
      instrumentedPools.set(poolName, {
        pool,
        maxConnections: maxConnections ?? pool.options?.max ?? null
      });

      const originalQuery = pool.query.bind(pool);
      pool.query = ((...args: unknown[]) => {
        const operation = inferSqlOperation(args[0]);
        const startedAtNs = process.hrtime.bigint();
        const observe = (outcome: "success" | "error") => {
          const elapsedSeconds = Number(process.hrtime.bigint() - startedAtNs) / 1e9;
          dbHistogram.observe({ pool: poolName, operation, outcome }, elapsedSeconds);
        };
        return originalQuery(...args).then(
          (value) => {
            observe("success");
            return value;
          },
          (error: unknown) => {
            observe("error");
            throw error;
          }
        );
      }) as QueryablePool["query"];

      return pool;
    },

    async timeModelRequest(labels, fn) {
      const startedAtNs = process.hrtime.bigint();
      const observationLabels = {
        provider: labels.provider,
        model: labels.model,
        execution_target: labels.executionTarget
      };
      try {
        const result = await fn();
        modelHistogram.observe(
          { ...observationLabels, outcome: "success" },
          Number(process.hrtime.bigint() - startedAtNs) / 1e9
        );
        return result;
      } catch (error) {
        modelHistogram.observe(
          { ...observationLabels, outcome: "error" },
          Number(process.hrtime.bigint() - startedAtNs) / 1e9
        );
        throw error;
      }
    },

    instrumentBulkhead(bulkhead) {
      instrumentedBulkheads.set(bulkhead.name, bulkhead);
      return bulkhead;
    },

    instrumentCircuitBreaker(breaker) {
      instrumentedBreakers.set(breaker.name, breaker);
      return breaker;
    },

    recordResourceEvent(event) {
      if (event.type === "operation_rejected") {
        overloadRejectionCounter.inc({
          name: event.name,
          workload_class: event.workloadClass,
          reason: event.reason
        });
        return;
      }
      if (event.type === "opened" || event.type === "closed" || event.type === "half_open_probe") {
        circuitBreakerTransitionCounter.inc({ name: event.name, state: event.type });
      }
    },

    recordInference(observation) {
      const labels = {
        provider: observation.provider,
        model: observation.model,
        execution_target: observation.executionTarget,
        status: observation.status
      };
      inferenceRequests.inc(labels);
      if (observation.status !== "succeeded") {
        inferenceErrors.inc({ ...labels, code: observation.errorCode ?? "UNKNOWN" });
      }
      if (observation.errorCode === "RATE_LIMITED" || observation.errorCode === "BUDGET_EXCEEDED") {
        providerRateLimits.inc({ provider: observation.provider, code: observation.errorCode });
      }
      if (observation.latencyMs !== null)
        inferenceLatency.observe(labels, Math.max(0, observation.latencyMs));
      if (observation.firstTokenMs !== null) {
        inferenceFirstToken.observe(labels, Math.max(0, observation.firstTokenMs));
      }
      if (observation.inputTokens !== null)
        inferenceInputTokens.inc(labels, observation.inputTokens);
      if (observation.outputTokens !== null)
        inferenceOutputTokens.inc(labels, observation.outputTokens);
      if (observation.estimatedCost !== null && observation.currency !== null) {
        inferenceEstimatedCost.inc(
          { ...labels, currency: observation.currency },
          observation.estimatedCost
        );
      }
      if (observation.fallback) {
        providerFallbacks.inc({
          provider: observation.provider,
          model: observation.model,
          execution_target: observation.executionTarget
        });
      }
    },

    async timeScheduledJob(job, fn) {
      const startedAtNs = process.hrtime.bigint();
      try {
        const result = await fn();
        scheduledJobHistogram.observe(
          { job, outcome: "success" },
          Number(process.hrtime.bigint() - startedAtNs) / 1e9
        );
        return result;
      } catch (error) {
        scheduledJobHistogram.observe(
          { job, outcome: "error" },
          Number(process.hrtime.bigint() - startedAtNs) / 1e9
        );
        scheduledJobFailureCounter.inc({ job });
        throw error;
      }
    }
  };
}

function circuitStateValue(state: CircuitState): number {
  switch (state) {
    case "closed":
      return 0;
    case "half_open":
      return 1;
    case "open":
      return 2;
  }
}

function inferSqlOperation(query: unknown): string {
  const text = typeof query === "string" ? query : (query as { text?: string } | undefined)?.text;
  if (typeof text !== "string") return "unknown";
  const match = /^\s*(\w+)/.exec(text);
  return match?.[1]?.toLowerCase() ?? "unknown";
}
