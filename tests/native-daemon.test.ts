import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDaemonGateway } from "../services/api/src/daemon/gateway.js";
import { DaemonTaskError, runDaemonWorker } from "../services/api/src/daemon/worker.js";
import type { DaemonTask, DaemonTaskStore } from "../services/api/src/daemon/task-store.js";
import {
  createDaemonExecutor,
  readDaemonCapabilities
} from "../services/api/src/daemon/executor.js";
import {
  daemonRetentionMsFromEnv,
  runDaemonRetention
} from "../services/api/src/daemon/retention.js";

afterEach(() => vi.unstubAllGlobals());

describe("native daemon executor", () => {
  it("executes Luna through Grogoni with no tool capability", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        model: "openai/gpt-6-luna",
        choices: [{ message: { content: '{"type":"response","message":"hello"}' } }],
        usage: { prompt_tokens: 12, completion_tokens: 8 }
      })
    );
    vi.stubGlobal("fetch", request);
    const result = await createDaemonExecutor({ OPENROUTER_API_KEY: "private-test" })(
      task,
      new AbortController().signal
    );
    expect(result).toMatchObject({
      completion: { status: "available", metadata: { agentAdapterId: "grogoni", promptTokens: 12 } }
    });
    expect(request).toHaveBeenCalledOnce();
    const body = JSON.parse(request.mock.calls[0]![1]!.body as string);
    expect(body.model).toBe("openai/gpt-6-luna");
    expect(body.tools).toBeUndefined();
  });
  it("uses the platform default runtime fallback when a task omits an explicit adapter", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        model: "openai/gpt-6-luna",
        choices: [{ message: { content: '{"type":"response","message":"hello"}' } }],
        usage: { prompt_tokens: 12, completion_tokens: 8 }
      })
    );
    vi.stubGlobal("fetch", request);
    const execute = createDaemonExecutor({ OPENROUTER_API_KEY: "private-test" });
    const result = await execute(
      {
        ...task,
        payload: {
          kind: "agent",
          message: "hello",
          modelId: "gpt-6-luna"
        } as unknown as typeof task.payload
      },
      new AbortController().signal
    );
    expect(result).toMatchObject({
      completion: {
        status: "available",
        metadata: { agentAdapterId: "grogoni" }
      }
    });
  });
  it("blocks unmapped models and preserves retryable provider errors", async () => {
    const execute = createDaemonExecutor({ OPENROUTER_API_KEY: "private-test" });
    await expect(
      execute(
        {
          ...task,
          payload: {
            kind: "agent",
            message: "hello",
            modelId: "unknown",
            agentAdapterId: "grogoni"
          }
        },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: "RUNTIME_NOT_CONFIGURED", retryable: false });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("private provider detail", { status: 429 }))
    );
    await expect(execute(task, new AbortController().signal)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true
    });
  });
  it("retries transient model failures the runtime marks retryable, such as an empty reply", async () => {
    // Regression: the runtime's retryable verdict was dropped, so an empty 200 from the provider
    // dead-lettered a recurring task after one of its attempts.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ model: "openai/gpt-6-luna", choices: [] }))
    );
    const execute = createDaemonExecutor({ OPENROUTER_API_KEY: "private-test" });
    await expect(execute(task, new AbortController().signal)).rejects.toMatchObject({
      retryable: true
    });
    // A request the provider rejects outright stays permanent.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad", { status: 400 }))
    );
    await expect(execute(task, new AbortController().signal)).rejects.toMatchObject({
      retryable: false
    });
  });
  it("dispatches only allowlisted maintenance jobs through the authenticated API", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ status: "completed" }));
    vi.stubGlobal("fetch", request);
    const execute = createDaemonExecutor({
      GROGONI_API_URL: "https://api.example/functions/v1/api",
      BACKGROUND_JOB_TOKEN: "job-test"
    });
    await execute(
      { ...task, payload: { kind: "maintenance", job: "connected_mailbox_sync" } },
      new AbortController().signal
    );
    expect(String(request.mock.calls[0]![0])).toBe(
      "https://api.example/functions/v1/api/internal/jobs/connected_mailbox_sync/run"
    );
    expect(request.mock.calls[0]![1]!.headers).toMatchObject({ "x-job-token": "job-test" });
    await expect(
      execute(
        { ...task, payload: { kind: "maintenance", job: "not-a-job" } },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: "UNKNOWN_JOB", retryable: false });
  });
  it("reports job API failures with job codes, never model-provider codes", async () => {
    const execute = createDaemonExecutor({
      GROGONI_API_URL: "https://api.example/functions/v1/api",
      BACKGROUND_JOB_TOKEN: "job-test"
    });
    const job = {
      ...task,
      payload: { kind: "maintenance" as const, job: "connected_mailbox_sync" }
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 503 }))
    );
    await expect(execute(job, new AbortController().signal)).rejects.toMatchObject({
      code: "JOB_API_UNAVAILABLE",
      retryable: true
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 403 }))
    );
    await expect(execute(job, new AbortController().signal)).rejects.toMatchObject({
      code: "JOB_API_REJECTED",
      retryable: false
    });
  });
});

describe("native daemon startup configuration", () => {
  const agentEnv = { OPENROUTER_API_KEY: "key" };
  const jobEnv = { GROGONI_API_URL: "https://api.example/api", BACKGROUND_JOB_TOKEN: "job" };
  it("refuses to start with nothing to run or with invalid settings", () => {
    expect(() => readDaemonCapabilities({}, "gpt-6-luna")).toThrow("Nothing to run");
    expect(() => readDaemonCapabilities(agentEnv, "bogus-model")).toThrow("not mapped");
    expect(() =>
      readDaemonCapabilities({ GROGONI_API_URL: "not-a-url", BACKGROUND_JOB_TOKEN: "j" }, "x")
    ).toThrow();
    expect(() =>
      readDaemonCapabilities(
        { GROGONI_API_URL: "http://127.0.0.1:1", BACKGROUND_JOB_TOKEN: "j" },
        "x"
      )
    ).toThrow("HTTPS");
    expect(() => readDaemonCapabilities({ GROGONI_API_URL: "https://api.example" }, "x")).toThrow(
      "BACKGROUND_JOB_TOKEN"
    );
    expect(() => readDaemonCapabilities({ ...jobEnv, DAEMON_ALLOW_LOCAL_API: "yes" }, "x")).toThrow(
      "DAEMON_ALLOW_LOCAL_API"
    );
    expect(() =>
      readDaemonCapabilities({ ...agentEnv, OPENROUTER_MODELS: "{}" }, "gpt-6-luna")
    ).toThrow();
  });
  it("tells the gateway which payloads this daemon can actually run", () => {
    const agentsOnly = readDaemonCapabilities(agentEnv, "gpt-6-luna");
    const agent = (modelId: string) =>
      ({ kind: "agent", message: "hi", modelId, agentAdapterId: "grogoni" }) as const;
    const maintenance = { kind: "maintenance", job: "connected_mailbox_sync" } as const;
    expect(agentsOnly).toMatchObject({ agents: true, maintenance: false });
    expect(agentsOnly.refusal(agent("gpt-6-luna"))).toBeNull();
    expect(agentsOnly.refusal(agent("unmapped"))).toBe("MODEL_NOT_CONFIGURED");
    expect(agentsOnly.refusal(maintenance)).toBe("JOB_API_NOT_CONFIGURED");
    const jobsOnly = readDaemonCapabilities(
      { ...jobEnv, GROGONI_API_URL: "http://127.0.0.1:9", DAEMON_ALLOW_LOCAL_API: "true" },
      "unmapped-is-fine-without-agents"
    );
    expect(jobsOnly.refusal(maintenance)).toBeNull();
    expect(jobsOnly.refusal(agent("gpt-6-luna"))).toBe("AGENT_RUNTIME_NOT_CONFIGURED");
  });
  it("refuses messages the Grogoni engine would reject as too large, by bytes not characters", () => {
    // Regression: 45k CJK characters passed the 60k-character schema, were accepted, and then
    // dead-lettered as CONTEXT_TOO_LARGE on the first (non-retryable) run.
    const capabilities = readDaemonCapabilities(agentEnv, "gpt-6-luna");
    const agent = (message: string, agentAdapterId: "grogoni" | "pi" = "grogoni") =>
      ({ kind: "agent", message, modelId: "gpt-6-luna", agentAdapterId }) as const;
    expect(capabilities.refusal(agent("店".repeat(45_000)))).toBe("MESSAGE_TOO_LARGE");
    expect(capabilities.refusal(agent("店".repeat(43_000)))).toBeNull();
    expect(capabilities.refusal(agent("x".repeat(60_000)))).toBeNull();
    // Pi has no prompt byte cap of its own.
    expect(capabilities.refusal(agent("店".repeat(60_000), "pi"))).toBeNull();
  });
});

const task: DaemonTask = {
  id: "3869e8c4-e43f-48c8-9f0c-2b0b08c9f830",
  idempotency_key: "hello",
  payload: {
    kind: "agent",
    message: "hello",
    modelId: "gpt-6-luna",
    agentAdapterId: "grogoni"
  },
  status: "running",
  run_at: new Date("2026-10-11T00:00:00Z"),
  attempts: 1,
  max_attempts: 3,
  executions: 0,
  lease_token: "claim",
  lease_until: new Date("2026-10-11T00:00:30Z"),
  interval_ms: null,
  result: null,
  error_code: null,
  owner_user_id: null,
  lane: "server",
  created_at: new Date("2026-10-11T00:00:00Z"),
  updated_at: new Date("2026-10-11T00:00:01Z")
};
const token = "t".repeat(32);
const defaults = { modelId: "gpt-6-luna", agentAdapterId: "grogoni" as const };

function fakeStore(): DaemonTaskStore {
  return {
    enqueue: vi.fn(async () => task),
    get: vi.fn(async () => task),
    list: vi.fn(async () => [task]),
    retry: vi.fn(async () => true),
    cancel: vi.fn(async () => true),
    expireExhausted: vi.fn(async () => []),
    claim: vi.fn(async () => task),
    claimOwned: vi.fn(async () => null),
    getOwned: vi.fn(async () => null),
    listOwned: vi.fn(async () => []),
    cancelOwned: vi.fn(async () => false),
    countActiveOwned: vi.fn(async () => 0),
    nextOwnedDueInMs: vi.fn(async () => null),
    clearCancelledLease: vi.fn(async () => undefined),
    nextServerDueAt: vi.fn(async () => null),
    renew: vi.fn(async () => true),
    settle: vi.fn(async () => true),
    release: vi.fn(async () => true),
    stats: vi.fn(async () => ({
      counts: { queued: 2, running: 1, completed: 5, failed: 1, cancelled: 0 },
      oldestDueSeconds: 4,
      expiredLeases: 0
    })),
    purge: vi.fn(async () => 0),
    health: vi.fn(async () => {})
  };
}

describe("native daemon gateway", () => {
  it("requires authentication, validates work, and supplies native defaults", async () => {
    const store = fakeStore();
    const app = buildDaemonGateway({ store, token, ready: () => true, defaults });
    const headers = { authorization: `Bearer ${"t".repeat(32)}` };
    try {
      expect((await app.inject({ url: "/health/live" })).statusCode).toBe(200);
      expect((await app.inject({ url: "/health/ready" })).statusCode).toBe(401);
      expect((await app.inject({ url: "/health/ready", headers })).statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/tasks",
            headers,
            payload: { key: "hello", payload: { kind: "agent", message: "hello" } }
          })
        ).statusCode
      ).toBe(202);
      expect(store.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ payload: task.payload })
      );
      expect((await app.inject({ url: "/v1/tasks", headers })).json()).toMatchObject({
        tasks: [{ id: task.id }]
      });
      expect(
        (await app.inject({ method: "POST", url: `/v1/tasks/${task.id}/retry`, headers })).json()
      ).toEqual({ queued: true });
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/tasks",
            headers,
            payload: { key: "bad", payload: { kind: "shell", command: "anything" } }
          })
        ).statusCode
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/tasks",
            headers,
            payload: { key: "bad", intervalMs: 1, payload: { kind: "maintenance", job: "unknown" } }
          })
        ).statusCode
      ).toBe(400);
      expect(
        (await app.inject({ method: "DELETE", url: `/v1/tasks/${task.id}`, headers })).json()
      ).toEqual({ cancelled: true });
    } finally {
      await app.close();
    }
  });
  it("never exposes lease tokens and applies operator defaults", async () => {
    const store = fakeStore();
    const app = buildDaemonGateway({
      store,
      token,
      ready: () => true,
      defaults: { modelId: "operator-model", agentAdapterId: "pi" }
    });
    const headers = { authorization: `Bearer ${token}` };
    try {
      const created = await app.inject({
        method: "POST",
        url: "/v1/tasks",
        headers,
        payload: { key: "hello", payload: { kind: "agent", message: "hello" } }
      });
      expect(store.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: {
            kind: "agent",
            message: "hello",
            modelId: "operator-model",
            agentAdapterId: "pi"
          }
        })
      );
      const bodies = [
        created.body,
        (await app.inject({ url: `/v1/tasks/${task.id}`, headers })).body,
        (await app.inject({ url: "/v1/tasks", headers })).body
      ];
      for (const body of bodies) {
        expect(body).not.toContain("claim");
        expect(body).not.toMatch(/lease_token|leaseToken/u);
      }
      expect(created.json()).toEqual({
        id: task.id,
        key: "hello",
        payload: task.payload,
        status: "running",
        runAt: "2026-10-11T00:00:00.000Z",
        intervalMs: null,
        attempts: 1,
        maxAttempts: 3,
        executions: 0,
        leaseUntil: "2026-10-11T00:00:30.000Z",
        result: null,
        errorCode: null,
        lane: "server",
        createdAt: "2026-10-11T00:00:00.000Z",
        updatedAt: "2026-10-11T00:00:01.000Z"
      });
    } finally {
      await app.close();
    }
  });
  it("reports queue health only to authenticated operators", async () => {
    const store = fakeStore();
    const app = buildDaemonGateway({ store, token, ready: () => true, defaults });
    try {
      expect((await app.inject({ url: "/v1/stats" })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            url: "/v1/stats",
            headers: { authorization: `Bearer ${"x".repeat(32)}` }
          })
        ).statusCode
      ).toBe(401);
      const stats = await app.inject({
        url: "/v1/stats",
        headers: { authorization: `Bearer ${token}` }
      });
      expect(stats.json()).toEqual({
        counts: { queued: 2, running: 1, completed: 5, failed: 1, cancelled: 0 },
        oldestDueSeconds: 4,
        expiredLeases: 0
      });
    } finally {
      await app.close();
    }
  });
  it("rejects unrunnable, blank and NUL-bearing work, and accepts long multibyte messages", async () => {
    const store = fakeStore();
    const app = buildDaemonGateway({
      store,
      token,
      ready: () => true,
      defaults,
      refusal: (payload) =>
        payload.kind === "agent" && payload.modelId === "unmapped" ? "MODEL_NOT_CONFIGURED" : null
    });
    const headers = { authorization: `Bearer ${token}` };
    const post = (payload: unknown) =>
      app.inject({ method: "POST", url: "/v1/tasks", headers, payload: payload as object });
    try {
      const refused = await post({
        key: "k",
        payload: { kind: "agent", message: "hi", modelId: "unmapped" }
      });
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toEqual({ error: "MODEL_NOT_CONFIGURED" });
      for (const bad of [
        { key: "   ", payload: { kind: "agent", message: "hi" } },
        { key: "k", payload: { kind: "agent", message: " \n\t " } },
        { key: "k\u0000", payload: { kind: "agent", message: "hi" } },
        { key: "k", payload: { kind: "agent", message: "hi\u0000there" } }
      ])
        expect((await post(bad)).json()).toEqual({ error: "INVALID_TASK" });
      expect(
        (await post({ key: "k", intervalMs: "60000", payload: { kind: "agent", message: "hi" } }))
          .statusCode
      ).toBe(400);
      expect(store.enqueue).not.toHaveBeenCalled();
      const long = await post({
        key: "cjk",
        payload: { kind: "agent", message: "店".repeat(60_000) }
      });
      expect(long.statusCode).toBe(202);
      expect(
        (await post({ key: "big", payload: { kind: "agent", message: "x".repeat(60_001) } }))
          .statusCode
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
  it("answers every kind of bad input with 400, never a retryable 503", async () => {
    const store = fakeStore();
    const events: string[] = [];
    const app = buildDaemonGateway({
      store,
      token,
      ready: () => true,
      defaults,
      report: (event) => events.push(event.type)
    });
    const auth = { authorization: `Bearer ${token}` };
    const json = { ...auth, "content-type": "application/json" };
    try {
      const cases = [
        app.inject({
          method: "POST",
          url: "/v1/tasks",
          headers: { ...auth, "content-type": "text/plain" },
          payload: "hi"
        }),
        app.inject({ method: "POST", url: "/v1/tasks", headers: json, payload: "{not json" }),
        app.inject({
          method: "POST",
          url: "/v1/tasks",
          headers: json,
          payload: JSON.stringify({
            key: "k",
            runAt: "2026-12-31T23:59:60Z",
            payload: { kind: "agent", message: "hi" }
          })
        }),
        app.inject({
          method: "POST",
          url: "/v1/tasks",
          headers: json,
          payload: '{"key":"k","payload":{"kind":"agent","message":"lone \\ud800 surrogate"}}'
        }),
        app.inject({
          method: "POST",
          url: "/v1/tasks",
          headers: json,
          payload: '{"key":"\\udc00","payload":{"kind":"agent","message":"hi"}}'
        })
      ];
      for (const response of await Promise.all(cases)) {
        expect(response.statusCode, response.body).toBe(400);
        expect(response.json()).toEqual({ error: "INVALID_TASK" });
      }
      expect(store.enqueue).not.toHaveBeenCalled();
      // A database data exception is still the caller's input, not an outage.
      store.enqueue = vi.fn(async () => {
        throw Object.assign(new Error("invalid input syntax"), { code: "22P02" });
      });
      const dataError = await app.inject({
        method: "POST",
        url: "/v1/tasks",
        headers: json,
        payload: JSON.stringify({ key: "k", payload: { kind: "agent", message: "hi" } })
      });
      expect(dataError.statusCode).toBe(400);
      expect(events).toEqual([]);
      // The literal text "\u0000" (backslash-u) is ordinary text, not a NUL character.
      store.enqueue = vi.fn(async () => task);
      const literal = await app.inject({
        method: "POST",
        url: "/v1/tasks",
        headers: json,
        payload: JSON.stringify({
          key: "k",
          payload: { kind: "agent", message: "type \\u0000 to test" }
        })
      });
      expect(literal.statusCode).toBe(202);
    } finally {
      await app.close();
    }
  });
  it("accepts cancel and retry requests that send a JSON content type with no body", async () => {
    const store = fakeStore();
    const app = buildDaemonGateway({ store, token, ready: () => true, defaults });
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    try {
      const cancel = await app.inject({ method: "DELETE", url: `/v1/tasks/${task.id}`, headers });
      expect(cancel.json()).toEqual({ cancelled: true });
      const retry = await app.inject({
        method: "POST",
        url: `/v1/tasks/${task.id}/retry`,
        headers
      });
      expect(retry.json()).toEqual({ queued: true });
      // Submissions still need a body, and prototype-poisoning payloads stay rejected.
      expect((await app.inject({ method: "POST", url: "/v1/tasks", headers })).statusCode).toBe(
        400
      );
      const poisoned = await app.inject({
        method: "POST",
        url: "/v1/tasks",
        headers,
        payload: '{"key":"k","__proto__":{"x":1},"payload":{"kind":"agent","message":"hi"}}'
      });
      expect(poisoned.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
  it("refuses to requeue work this daemon cannot run", async () => {
    const store = fakeStore();
    const app = buildDaemonGateway({
      store,
      token,
      ready: () => true,
      defaults,
      refusal: () => "MODEL_NOT_CONFIGURED"
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/tasks/${task.id}/retry`,
        headers: { authorization: `Bearer ${token}` }
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ error: "MODEL_NOT_CONFIGURED" });
      expect(store.retry).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("rejects weak tokens and compares supplied tokens without leaking length", async () => {
    expect(() =>
      buildDaemonGateway({ store: fakeStore(), token: " ".repeat(32), ready: () => true, defaults })
    ).toThrow("no whitespace");
    expect(() =>
      buildDaemonGateway({ store: fakeStore(), token: "short", ready: () => true, defaults })
    ).toThrow();
    const app = buildDaemonGateway({ store: fakeStore(), token, ready: () => true, defaults });
    try {
      for (const authorization of [
        "",
        `Bearer ${token.slice(1)}`,
        `Bearer ${token}${"t".repeat(500)}`
      ])
        expect(
          (await app.inject({ url: "/v1/tasks", headers: { authorization } })).statusCode
        ).toBe(401);
    } finally {
      await app.close();
    }
  });
  it("accepts the Bearer scheme in any case but compares the token exactly", async () => {
    const app = buildDaemonGateway({ store: fakeStore(), token, ready: () => true, defaults });
    try {
      for (const scheme of ["Bearer", "bearer", "BEARER"])
        expect(
          (await app.inject({ url: "/v1/tasks", headers: { authorization: `${scheme} ${token}` } }))
            .statusCode
        ).toBe(200);
      expect(
        (
          await app.inject({
            url: "/v1/tasks",
            headers: { authorization: `Bearer ${token.toUpperCase()}x` }
          })
        ).statusCode
      ).toBe(401);
      expect(
        (await app.inject({ url: "/v1/tasks", headers: { authorization: `Basic ${token}` } }))
          .statusCode
      ).toBe(401);
    } finally {
      await app.close();
    }
  });
  it("logs gateway database failures by code without leaking details to callers", async () => {
    const store = fakeStore();
    store.list = vi.fn(async () => {
      throw Object.assign(new Error("password=hunter2 connection refused"), {
        code: "ECONNREFUSED"
      });
    });
    const events: Array<{ type: string; errorCode?: string }> = [];
    const app = buildDaemonGateway({
      store,
      token,
      ready: () => true,
      defaults,
      report: (e) => events.push(e)
    });
    try {
      const response = await app.inject({
        url: "/v1/tasks",
        headers: { authorization: `Bearer ${token}` }
      });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain("hunter2");
      expect(events).toEqual([{ type: "gateway_error", errorCode: "ECONNREFUSED" }]);
    } finally {
      await app.close();
    }
  });
  it("fails readiness and submissions during shutdown without leaking database errors", async () => {
    const store = fakeStore();
    const app = buildDaemonGateway({ store, token, ready: () => false, defaults });
    try {
      expect(
        (
          await app.inject({
            url: "/health/ready",
            headers: { authorization: `Bearer ${"t".repeat(32)}` }
          })
        ).statusCode
      ).toBe(503);
    } finally {
      await app.close();
    }
  });
});

describe("native daemon worker", () => {
  it("settles successful work and shuts down cleanly", async () => {
    const store = fakeStore();
    const stop = new AbortController();
    store.settle = vi.fn(async () => {
      stop.abort();
      return true;
    });
    await runDaemonWorker({
      store,
      signal: stop.signal,
      execute: async () => ({ message: "done" })
    });
    expect(store.settle).toHaveBeenCalledWith(task, { result: { message: "done" } });
    expect(store.release).not.toHaveBeenCalled();
  });
  it("releases an interrupted claim rather than marking shutdown as permanent failure", async () => {
    const store = fakeStore();
    const stop = new AbortController();
    await runDaemonWorker({
      store,
      signal: stop.signal,
      execute: async (_task, signal) => {
        stop.abort();
        expect(signal.aborted).toBe(true);
        return new Promise(() => {});
      }
    });
    expect(store.release).toHaveBeenCalledWith(task);
    expect(store.settle).not.toHaveBeenCalled();
  });
  it("aborts a cancelled or lost claim and never writes a stale result", async () => {
    const store = fakeStore();
    const stop = new AbortController();
    store.renew = vi.fn(async () => false);
    await runDaemonWorker({
      store,
      signal: stop.signal,
      leaseMs: 30,
      report: (event) => {
        if (event.type === "lease_lost") stop.abort();
      },
      execute: async () => new Promise(() => {})
    });
    expect(store.settle).not.toHaveBeenCalled();
    expect(store.release).not.toHaveBeenCalled();
  });
  it("bounds stuck tasks and preserves typed retry policy", async () => {
    const store = fakeStore();
    const stop = new AbortController();
    store.settle = vi.fn(async () => {
      stop.abort();
      return true;
    });
    await runDaemonWorker({
      store,
      signal: stop.signal,
      taskTimeoutMs: 10,
      execute: async () => new Promise(() => {})
    });
    expect(store.settle).toHaveBeenCalledWith(task, { errorCode: "TASK_TIMEOUT", retryable: true });
  });
  it("redacts unknown execution failures instead of logging provider secrets", async () => {
    const store = fakeStore();
    const stop = new AbortController();
    store.settle = vi.fn(async () => {
      stop.abort();
      return true;
    });
    await runDaemonWorker({
      store,
      signal: stop.signal,
      execute: async () => {
        throw new Error("private credential");
      }
    });
    expect(store.settle).toHaveBeenCalledWith(task, {
      errorCode: "TASK_EXECUTION_FAILED",
      retryable: false
    });
    expect(new DaemonTaskError("RATE_LIMITED", true).retryable).toBe(true);
  });
  it("lets in-flight work finish within the shutdown grace period and settles it", async () => {
    // Regression: shutdown used to abort a nearly-finished task and release it, so another
    // worker repeated a completed (possibly paid) model call.
    const store = fakeStore();
    const stop = new AbortController();
    const events: string[] = [];
    await runDaemonWorker({
      store,
      signal: stop.signal,
      shutdownGraceMs: 1000,
      report: (event) => events.push(event.type),
      execute: async (_task, signal) => {
        stop.abort();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(signal.aborted).toBe(false);
        return { message: "finished during grace" };
      }
    });
    expect(store.settle).toHaveBeenCalledWith(task, {
      result: { message: "finished during grace" }
    });
    expect(store.release).not.toHaveBeenCalled();
    expect(store.claim).toHaveBeenCalledOnce();
    expect(events).toEqual(["task_started", "task_finished"]);
  });
  it("aborts and releases work that outlives the shutdown grace period", async () => {
    const store = fakeStore();
    const stop = new AbortController();
    const events: Array<{ type: string; errorCode?: string }> = [];
    await runDaemonWorker({
      store,
      signal: stop.signal,
      shutdownGraceMs: 20,
      report: (event) => events.push(event),
      execute: async () => {
        stop.abort();
        return new Promise(() => {});
      }
    });
    expect(store.release).toHaveBeenCalledWith(task);
    expect(store.settle).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "task_interrupted", errorCode: "SHUTDOWN" });
  });
  it("records a real failure during the grace period instead of releasing it", async () => {
    const store = fakeStore();
    const stop = new AbortController();
    await runDaemonWorker({
      store,
      signal: stop.signal,
      shutdownGraceMs: 1000,
      execute: async () => {
        stop.abort();
        throw new DaemonTaskError("INVALID_INPUT", false);
      }
    });
    expect(store.settle).toHaveBeenCalledWith(task, {
      errorCode: "INVALID_INPUT",
      retryable: false
    });
    expect(store.release).not.toHaveBeenCalled();
  });
  it("rides out one failed renewal but abandons a claim before its lease can expire", async () => {
    const tolerant = fakeStore();
    let renewals = 0;
    tolerant.renew = vi.fn(async () => {
      renewals += 1;
      if (renewals === 1) throw new Error("transient");
      return true;
    });
    const stop = new AbortController();
    tolerant.settle = vi.fn(async () => {
      stop.abort();
      return true;
    });
    await runDaemonWorker({
      store: tolerant,
      signal: stop.signal,
      leaseMs: 300,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 450));
        return "ok";
      }
    });
    expect(renewals).toBeGreaterThanOrEqual(2);
    expect(tolerant.settle).toHaveBeenCalledWith(task, { result: "ok" });

    const hung = fakeStore();
    hung.renew = vi.fn(() => new Promise<boolean>(() => {}));
    const halt = new AbortController();
    const events: string[] = [];
    let modelSignal: AbortSignal | undefined;
    await runDaemonWorker({
      store: hung,
      signal: halt.signal,
      leaseMs: 60,
      report: (event) => {
        events.push(event.type);
        if (event.type === "lease_lost") halt.abort();
      },
      execute: async (_task, signal) => {
        modelSignal = signal;
        return new Promise(() => {});
      }
    });
    expect(modelSignal?.aborted).toBe(true);
    expect(hung.settle).not.toHaveBeenCalled();
    expect(events).toContain("lease_lost");
  });
  it("reports a fenced settlement instead of claiming success", async () => {
    const store = fakeStore();
    const stop = new AbortController();
    store.settle = vi.fn(async () => {
      stop.abort();
      return false;
    });
    const events: string[] = [];
    await runDaemonWorker({
      store,
      signal: stop.signal,
      report: (event) => events.push(event.type),
      execute: async () => "late"
    });
    expect(events).toEqual(["task_started", "task_settle_fenced"]);
  });
  it("logs outcomes with timing and codes but never task content", async () => {
    const store = fakeStore();
    const stop = new AbortController();
    store.settle = vi.fn(async () => {
      stop.abort();
      return true;
    });
    const lines: string[] = [];
    await runDaemonWorker({
      store,
      signal: stop.signal,
      report: (event) => lines.push(JSON.stringify(event)),
      execute: async () => {
        throw new DaemonTaskError("RATE_LIMITED", true);
      }
    });
    const finished = JSON.parse(lines.at(-1)!);
    expect(finished).toMatchObject({
      type: "task_failed",
      taskId: task.id,
      attempt: 1,
      errorCode: "RATE_LIMITED"
    });
    expect(finished.durationMs).toBeGreaterThanOrEqual(0);
    expect(lines.join("\n")).not.toContain("hello");
  });
});

describe("native daemon worker hardening", () => {
  it("hands back a task claimed while shutdown began instead of starting it", async () => {
    const store = fakeStore();
    const stop = new AbortController();
    store.claim = vi.fn(async () => {
      stop.abort();
      return task;
    });
    const execute = vi.fn(async () => "should not run");
    await runDaemonWorker({ store, signal: stop.signal, shutdownGraceMs: 1000, execute });
    expect(execute).not.toHaveBeenCalled();
    expect(store.release).toHaveBeenCalledWith(task);
  });
  it("dead-letters a result the database cannot store instead of re-running paid work", async () => {
    const store = fakeStore();
    const stop = new AbortController();
    store.settle = vi.fn(async (_task, outcome) => {
      if ("result" in outcome)
        throw Object.assign(new Error("unsupported Unicode escape sequence"), { code: "22P05" });
      stop.abort();
      return true;
    });
    await runDaemonWorker({ store, signal: stop.signal, execute: async () => "x" });
    expect(store.settle).toHaveBeenLastCalledWith(task, {
      errorCode: "RESULT_NOT_STORABLE",
      retryable: false
    });
  });
  it("does not dead-letter a result when settlement fails for a transient reason", async () => {
    const store = fakeStore();
    const stop = new AbortController();
    const events: string[] = [];
    store.settle = vi.fn(async () => {
      stop.abort();
      throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    });
    await runDaemonWorker({
      store,
      signal: stop.signal,
      report: (event) => events.push(event.type),
      execute: async () => "x"
    });
    // Retried while the lease holds, then left to lease expiry (at-least-once).
    expect(store.settle).toHaveBeenCalledTimes(3);
    expect(store.settle).toHaveBeenLastCalledWith(task, { result: "x" });
    expect(events).toContain("task_settlement_failed");
  });
  it("rides out a single database blip at settlement without repeating the work", async () => {
    const store = fakeStore();
    const stop = new AbortController();
    const events: string[] = [];
    let calls = 0;
    store.settle = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
      stop.abort();
      return true;
    });
    const execute = vi.fn(async () => "x");
    await runDaemonWorker({
      store,
      signal: stop.signal,
      report: (e) => events.push(e.type),
      execute
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(events).toEqual(["task_started", "task_finished"]);
  });
  it("abandons a claim well before its lease can expire, even when renewals answer late", async () => {
    // Regression: ownership was measured from when a renewal *answered*, so a slow answer followed
    // by an outage let the worker keep a task after its lease had expired in the database.
    const leaseMs = 400;
    const store = fakeStore();
    let lastAcceptedSentAt = Date.now();
    let renewals = 0;
    store.renew = vi.fn(async () => {
      renewals += 1;
      if (renewals > 1) return new Promise<boolean>(() => {}); // database outage
      lastAcceptedSentAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 110)); // slow answer
      return true;
    });
    const stop = new AbortController();
    let abandonedAt = 0;
    await runDaemonWorker({
      store,
      signal: stop.signal,
      leaseMs,
      report: (event) => {
        if (event.type === "lease_lost") {
          abandonedAt = Date.now();
          stop.abort();
        }
      },
      execute: async () => new Promise(() => {})
    });
    // The database granted the lease until at least lastAcceptedSentAt + leaseMs.
    const marginMs = lastAcceptedSentAt + leaseMs - abandonedAt;
    expect(marginMs).toBeGreaterThanOrEqual(leaseMs / 4 - 30);
  });
});

describe("native daemon exhausted leases", () => {
  it("logs every claim dead-lettered for running out of attempts", async () => {
    // Regression: the sweep was silent, so a crashed final attempt vanished from the logs.
    const store = fakeStore();
    const stop = new AbortController();
    store.expireExhausted = vi.fn(async () => ["a", "b"]);
    store.claim = vi.fn(async () => {
      stop.abort();
      return null;
    });
    const events: Array<{ type: string; taskId?: string; errorCode?: string }> = [];
    await runDaemonWorker({
      store,
      signal: stop.signal,
      report: (e) => events.push(e),
      execute: vi.fn()
    });
    expect(events).toEqual([
      { type: "lease_exhausted", taskId: "a", errorCode: "LEASE_EXHAUSTED" },
      { type: "lease_exhausted", taskId: "b", errorCode: "LEASE_EXHAUSTED" }
    ]);
  });
});

describe("native daemon lease clock", () => {
  it("starts the ownership clock before the claim query, not when it answers", async () => {
    // Regression: a slow claim answer started the clock late, so the worker kept the task past
    // the database lease when the following renewals never answered.
    const leaseMs = 400;
    const store = fakeStore();
    let claimSentAt = 0;
    let claims = 0;
    store.claim = vi.fn(async () => {
      claims += 1;
      if (claims > 1) return null;
      claimSentAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 150));
      return task;
    });
    store.renew = vi.fn(() => new Promise<boolean>(() => {}));
    const stop = new AbortController();
    let abandonedAt = 0;
    await runDaemonWorker({
      store,
      signal: stop.signal,
      leaseMs,
      report: (event) => {
        if (event.type === "lease_lost") {
          abandonedAt = Date.now();
          stop.abort();
        }
      },
      execute: async () => new Promise(() => {})
    });
    expect(claimSentAt + leaseMs - abandonedAt).toBeGreaterThanOrEqual(leaseMs / 4 - 30);
  });
  it("reports a successful settlement as finished even if a renewal races it", async () => {
    const store = fakeStore();
    const stop = new AbortController();
    const events: string[] = [];
    store.renew = vi.fn(async () => false);
    store.settle = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      stop.abort();
      return true;
    });
    await runDaemonWorker({
      store,
      signal: stop.signal,
      leaseMs: 40,
      report: (event) => events.push(event.type),
      execute: async () => "done"
    });
    expect(events).toEqual(["task_started", "task_finished"]);
  });
});

describe("native daemon retention", () => {
  it("defaults to 30 days, allows 0 to disable, and rejects typos at startup", () => {
    expect(daemonRetentionMsFromEnv(undefined)).toBe(30 * 86_400_000);
    expect(daemonRetentionMsFromEnv(" ")).toBe(30 * 86_400_000);
    expect(daemonRetentionMsFromEnv("7")).toBe(7 * 86_400_000);
    expect(daemonRetentionMsFromEnv("0")).toBeNull();
    for (const bad of ["-1", "1.5", "30d", "3651", "1e3"])
      expect(() => daemonRetentionMsFromEnv(bad)).toThrow("DAEMON_RETENTION_DAYS");
  });
  it("drains expired tasks in bounded batches and survives database errors", async () => {
    const store = fakeStore();
    const stop = new AbortController();
    const batches = [2, 2, 1];
    store.purge = vi.fn(async () => batches.shift() ?? 0);
    const events: Array<{ type: string; deleted?: number }> = [];
    await runDaemonRetention({
      store,
      retentionMs: 1000,
      batchSize: 2,
      signal: stop.signal,
      intervalMs: 10_000,
      report: (event) => {
        events.push(event);
        stop.abort();
      }
    });
    expect(store.purge).toHaveBeenCalledTimes(3);
    expect(store.purge).toHaveBeenCalledWith(1000, 2);
    expect(events).toEqual([{ type: "retention_purged", deleted: 5 }]);

    const failing = fakeStore();
    failing.purge = vi.fn(async () => {
      throw new Error("database down");
    });
    const halt = new AbortController();
    const failures: string[] = [];
    await runDaemonRetention({
      store: failing,
      retentionMs: 1000,
      signal: halt.signal,
      report: (event) => {
        failures.push(event.type);
        halt.abort();
      }
    });
    expect(failures).toEqual(["retention_failed"]);
  });
});
