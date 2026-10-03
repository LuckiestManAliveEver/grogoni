import { describe, expect, it } from "vitest";
import { createBulkhead, createCircuitBreaker } from "@grogoni/resource-control";
import { createMetrics, type QueryablePool } from "./index.js";

function fakePool(
  overrides: Partial<Omit<QueryablePool, "options">> & { options?: { max?: number } } = {}
): QueryablePool & {
  calls: unknown[][];
  totalCount: number;
  idleCount: number;
  waitingCount: number;
} {
  const state = {
    calls: [] as unknown[][],
    totalCount: 3,
    idleCount: 2,
    waitingCount: 0
  };
  return {
    ...state,
    options: { max: 5 },
    async query(...args: unknown[]) {
      state.calls.push(args);
      const [sql] = args;
      if (sql === "SELECT pg_sleep(0) -- fail") throw new Error("boom");
      return { rows: [] };
    },
    ...overrides
  };
}

function fakePoolWithoutOptions(): QueryablePool {
  const pool: Partial<QueryablePool> = fakePool();
  delete pool.options;
  return pool as QueryablePool;
}

describe("createMetrics", () => {
  it("tags every metric with the service label and exposes Node process defaults", async () => {
    const metrics = createMetrics({ serviceName: "api" });

    const text = await metrics.metricsText();

    expect(text).toContain('service="api"');
    // Memory, CPU, and event-loop lag: the three "first measure" fundamentals that
    // prom-client's collectDefaultMetrics provides with zero custom code.
    expect(text).toContain("process_resident_memory_bytes");
    expect(text).toContain("process_cpu_user_seconds_total");
    expect(text).toContain("nodejs_eventloop_lag_seconds");
  });

  it("records HTTP request duration observations queryable as percentiles", async () => {
    const metrics = createMetrics({ serviceName: "api" });

    metrics.httpRequestDuration({
      method: "GET",
      route: "/health",
      statusCode: 200,
      durationSeconds: 0.02
    });

    const text = await metrics.metricsText();
    expect(text).toContain("http_request_duration_seconds_bucket");
    expect(text).toContain('method="GET"');
    expect(text).toContain('route="/health"');
    expect(text).toContain('status_code="200"');
  });

  it("clamps a negative duration to zero instead of corrupting the histogram", async () => {
    const metrics = createMetrics({ serviceName: "api" });

    expect(() =>
      metrics.httpRequestDuration({
        method: "GET",
        route: "/health",
        statusCode: 200,
        durationSeconds: -5
      })
    ).not.toThrow();
  });

  it("wraps pool.query in place so existing callers get timing for free", async () => {
    const metrics = createMetrics({ serviceName: "api" });
    const pool = fakePool();
    const originalQueryRef = pool.query;

    const returned = metrics.instrumentPgPool(pool, { poolName: "cp2_primary" });

    expect(returned).toBe(pool);
    expect(pool.query).not.toBe(originalQueryRef);

    await pool.query("select 1");
    expect(pool.calls).toEqual([["select 1"]]);

    const text = await metrics.metricsText();
    expect(text).toContain("pg_query_duration_seconds_bucket");
    expect(text).toContain('pool="cp2_primary"');
    expect(text).toContain('operation="select"');
    expect(text).toContain('outcome="success"');
  });

  it("records a failed query as outcome=error and still rethrows", async () => {
    const metrics = createMetrics({ serviceName: "api" });
    const pool = fakePool();
    metrics.instrumentPgPool(pool, { poolName: "cp2_primary" });

    await expect(pool.query("SELECT pg_sleep(0) -- fail")).rejects.toThrow("boom");

    const text = await metrics.metricsText();
    expect(text).toContain('outcome="error"');
  });

  it("samples pool gauges live at scrape time, not at instrument time", async () => {
    const metrics = createMetrics({ serviceName: "api" });
    const pool = fakePool();
    metrics.instrumentPgPool(pool, { poolName: "cp2_primary" });

    pool.totalCount = 9;
    pool.idleCount = 1;
    pool.waitingCount = 4;

    const text = await metrics.metricsText();
    expect(text).toMatch(/pg_pool_total_connections\{[^}]*pool="cp2_primary"[^}]*\} 9/);
    expect(text).toMatch(/pg_pool_idle_connections\{[^}]*pool="cp2_primary"[^}]*\} 1/);
    expect(text).toMatch(/pg_pool_waiting_requests\{[^}]*pool="cp2_primary"[^}]*\} 4/);
    expect(text).toMatch(/pg_pool_max_connections\{[^}]*pool="cp2_primary"[^}]*\} 5/);
  });

  it("prefers an explicit maxConnections override over the pool's own options.max", async () => {
    const metrics = createMetrics({ serviceName: "api" });
    const pool = fakePool();
    metrics.instrumentPgPool(pool, { poolName: "cp2_realtime", maxConnections: 1 });

    const text = await metrics.metricsText();
    expect(text).toMatch(/pg_pool_max_connections\{[^}]*pool="cp2_realtime"[^}]*\} 1/);
  });

  it("omits pg_pool_max_connections for a pool with no discoverable max", async () => {
    const metrics = createMetrics({ serviceName: "api" });
    const pool = fakePoolWithoutOptions();
    metrics.instrumentPgPool(pool, { poolName: "cp2_unknown_max" });

    const text = await metrics.metricsText();
    expect(text).not.toMatch(/pg_pool_max_connections\{[^}]*pool="cp2_unknown_max"/);
  });

  it("keeps independently instrumented pools on separate label series", async () => {
    const metrics = createMetrics({ serviceName: "api" });
    metrics.instrumentPgPool(fakePool({ totalCount: 5 }), { poolName: "cp2_primary" });
    metrics.instrumentPgPool(fakePool({ totalCount: 1 }), { poolName: "cp2_realtime" });

    const text = await metrics.metricsText();
    expect(text).toMatch(/pg_pool_total_connections\{[^}]*pool="cp2_primary"[^}]*\} 5/);
    expect(text).toMatch(/pg_pool_total_connections\{[^}]*pool="cp2_realtime"[^}]*\} 1/);
  });

  it("times a successful model request and resolves with its value", async () => {
    const metrics = createMetrics({ serviceName: "api" });

    const result = await metrics.timeModelRequest(
      { provider: "llama.cpp", model: "smollm2-360m", executionTarget: "vercel" },
      async () => "generated text"
    );

    expect(result).toBe("generated text");
    const text = await metrics.metricsText();
    expect(text).toContain("model_request_duration_seconds_bucket");
    expect(text).toContain('provider="llama.cpp"');
    expect(text).toContain('model="smollm2-360m"');
    expect(text).toContain('execution_target="vercel"');
    expect(text).toContain('outcome="success"');
  });

  it("records outcome=error and rethrows when the model call fails", async () => {
    const metrics = createMetrics({ serviceName: "api" });

    await expect(
      metrics.timeModelRequest(
        { provider: "llama.cpp", model: "smollm2-360m", executionTarget: "vercel" },
        async () => {
          throw new Error("inference unreachable");
        }
      )
    ).rejects.toThrow("inference unreachable");

    const text = await metrics.metricsText();
    expect(text).toMatch(/model_request_duration_seconds_bucket\{[^}]*outcome="error"/);
  });

  it("samples a registered bulkhead's active/queued/budget gauges live at scrape time", async () => {
    const metrics = createMetrics({ serviceName: "api" });
    const bulkhead = createBulkhead({
      name: "ocr",
      workloadClass: "background",
      maxConcurrency: 3,
      maxQueue: 7
    });
    metrics.instrumentBulkhead(bulkhead);

    let releaseFirst!: () => void;
    const hold = bulkhead.run(() => new Promise<void>((resolve) => (releaseFirst = resolve)));
    await Promise.resolve();

    const text = await metrics.metricsText();
    expect(text).toMatch(/workload_active\{[^}]*name="ocr"[^}]*\} 1/);
    expect(text).toMatch(/workload_max_concurrency\{[^}]*name="ocr"[^}]*\} 3/);
    expect(text).toMatch(/workload_max_queue\{[^}]*name="ocr"[^}]*\} 7/);
    expect(text).toContain('workload_class="background"');
    releaseFirst();
    await hold;
  });

  it("samples a registered circuit breaker's state live at scrape time", async () => {
    const metrics = createMetrics({ serviceName: "api" });
    const breaker = createCircuitBreaker({
      name: "inference",
      failureThreshold: 1,
      resetTimeoutMs: 60_000
    });
    metrics.instrumentCircuitBreaker(breaker);

    let text = await metrics.metricsText();
    expect(text).toMatch(/circuit_breaker_state\{[^}]*name="inference"[^}]*\} 0/);

    await expect(breaker.run(() => Promise.reject(new Error("down")))).rejects.toThrow();

    text = await metrics.metricsText();
    expect(text).toMatch(/circuit_breaker_state\{[^}]*name="inference"[^}]*\} 2/);
  });

  it("increments overload_rejection_total from a bulkhead's operation_rejected event", async () => {
    const metrics = createMetrics({ serviceName: "api" });
    const bulkhead = createBulkhead({
      name: "ocr",
      workloadClass: "background",
      maxConcurrency: 1,
      maxQueue: 0,
      onEvent: (event) => metrics.recordResourceEvent(event)
    });
    const hold = bulkhead.run(() => new Promise<void>(() => undefined));
    await Promise.resolve();

    await expect(bulkhead.run(async () => "x")).rejects.toThrow();

    const text = await metrics.metricsText();
    expect(text).toMatch(
      /overload_rejection_total\{[^}]*name="ocr"[^}]*reason="queue_full"[^}]*\} 1/
    );
    void hold;
  });

  it("increments circuit_breaker_transitions_total from a breaker's opened/closed events", async () => {
    const metrics = createMetrics({ serviceName: "api" });
    const breaker = createCircuitBreaker({
      name: "inference",
      failureThreshold: 1,
      resetTimeoutMs: 60_000,
      onEvent: (event) => metrics.recordResourceEvent(event)
    });
    await expect(breaker.run(() => Promise.reject(new Error("down")))).rejects.toThrow();

    const text = await metrics.metricsText();
    expect(text).toMatch(
      /circuit_breaker_transitions_total\{[^}]*name="inference"[^}]*state="opened"[^}]*\} 1/
    );
  });

  it("times a scheduled job and records success", async () => {
    const metrics = createMetrics({ serviceName: "api" });
    const result = await metrics.timeScheduledJob("grogoniid_cooldown", async () => "done");
    expect(result).toBe("done");
    const text = await metrics.metricsText();
    expect(text).toMatch(
      /scheduled_job_duration_seconds_bucket\{[^}]*job="grogoniid_cooldown"[^}]*outcome="success"/
    );
  });

  it("times a failing scheduled job and increments the failure counter", async () => {
    const metrics = createMetrics({ serviceName: "api" });
    await expect(
      metrics.timeScheduledJob("grogoniid_cooldown", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    const text = await metrics.metricsText();
    expect(text).toMatch(
      /scheduled_job_duration_seconds_bucket\{[^}]*job="grogoniid_cooldown"[^}]*outcome="error"/
    );
    expect(text).toMatch(/scheduled_job_failure_total\{[^}]*job="grogoniid_cooldown"[^}]*\} 1/);
  });
});
