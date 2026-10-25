import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { daemonWakeSql } from "../edge-job-schedule.js";
import {
  createEdgeDaemon,
  daemonLaneRoutes,
  DaemonHttpError,
  maintenanceFromJobRunner,
  readEdgeDaemonConfig,
  type EdgeDaemon
} from "./edge-lane.js";
import { createPostgresWakeHint } from "./wake-hint.js";
import { DaemonTaskError, runDaemonWorker, type DaemonExecutor } from "./worker.js";
import { daemonQueueMigrations, type DaemonTask, type DaemonTaskStore } from "./task-store.js";
import type { DaemonClaim, PublicDaemonTask } from "@grogoni/shared-types";

/**
 * A route's JSON body as the tests read it. Fields are declared present: when one is missing the
 * assertion that reads it fails, which is the point.
 */
interface Body {
  code: string;
  task: PublicDaemonTask & { result: Record<string, unknown> | null };
  tasks: PublicDaemonTask[];
  claim: DaemonClaim;
  renewed: boolean;
  /** Operator gateway answers. */
  id: string;
  error: string;
}

const url = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const environment = {
  OPENROUTER_API_KEY: "test-key",
  PLATFORM_DEFAULT_MODEL_ID: "gpt-6-luna",
  DAEMON_EDGE_RUN_BUDGET_MS: "20000",
  DAEMON_EDGE_TASK_TIMEOUT_MS: "5000"
};
const agentResult = (message: string) => ({
  completion: { status: "available", outputText: JSON.stringify({ message }) }
});

describe.skipIf(!url)("daemon lanes inside the Edge API", () => {
  const schema = `daemon_lanes_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url ?? "" });
  const pool = new Pool({ connectionString: url ?? "", options: `-c search_path=${schema}` });
  const calls: string[] = [];
  let behavior: (message: string, signal: AbortSignal) => Promise<unknown> = async (message) =>
    agentResult(`done: ${message}`);
  const execute: DaemonExecutor = async (task, signal) => {
    if (task.payload.kind !== "agent") return { maintenance: task.payload.job };
    calls.push(task.payload.message);
    return behavior(task.payload.message, signal);
  };
  const users = new Map([
    ["session-a", "user-a"],
    ["session-b", "user-b"]
  ]);
  const build = (
    env: Record<string, string> = environment,
    withHint: boolean | ReturnType<typeof createPostgresWakeHint> = true
  ): EdgeDaemon =>
    createEdgeDaemon({
      queue: pool,
      hint: withHint === true ? createPostgresWakeHint(pool) : withHint === false ? null : withHint,
      authenticate: async (request) => {
        const userId = users.get(request.headers.get("cookie") ?? "");
        if (!userId) throw new DaemonHttpError(401, "auth_required", "Authentication is required.");
        return { userId };
      },
      authorizeConversation: async (_request, id) => {
        if (id !== "11111111-1111-4111-8111-111111111111")
          throw new DaemonHttpError(404, "conversation_not_found", "Conversation not found.");
        return { modelId: "gpt-6-luna" };
      },
      deliverConversationTask: async (task) => {
        if (deliveryFailure) throw new Error("Messaging database unavailable");
        delivered.push(`${task.id}:${task.status}`);
      },
      environment: env,
      execute
    });
  let deliveryFailure = false;
  const delivered: string[] = [];
  let daemon: EdgeDaemon;
  const call = async (
    session: string,
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; json: Body }> => {
    const response = await daemon.routes(
      new Request(`https://edge.test${path}`, {
        method,
        headers: { cookie: session, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      }),
      path
    );
    if (response === null) return { status: 0, json: {} as Body };
    return { status: response.status, json: (await response.json()) as Body };
  };
  const hintRow = async () =>
    (await pool.query("select * from grogoni_internal.daemon_wake where id=1")).rows[0];
  const wakeCalls = async () =>
    Number((await pool.query("select count(*) as n from wake_calls")).rows[0].n);

  beforeAll(async () => {
    await admin.query(`create schema ${schema}`);
    // Supabase's API roles, which the wake SQL revokes from; harmless if they already exist.
    for (const role of ["anon", "authenticated"])
      await admin.query(
        `do $r$ begin create role ${role} nologin; exception when duplicate_object then null; end $r$`
      );
    for (const file of daemonQueueMigrations)
      await pool.query(
        await readFile(new URL(`../../../../infra/db/migrations/${file}`, import.meta.url), "utf8")
      );
  });
  beforeEach(async () => {
    deliveryFailure = false;
    delivered.length = 0;
    calls.length = 0;
    behavior = async (message) => agentResult(`done: ${message}`);
    await pool.query("truncate grogoni_daemon_tasks");
    // The wake guard lives in a fixed schema name (as in Supabase); recreate it per test, with a
    // stubbed job trigger that records calls instead of calling the Edge function.
    await pool.query("drop schema if exists grogoni_internal cascade");
    await pool.query(
      `create table if not exists wake_calls (job text, at timestamptz default now());
       truncate wake_calls;
       create or replace function public.grogoni_run_background_job(job text) returns bigint
       language sql as $f$ insert into ${schema}.wake_calls (job) values (job) returning 1::bigint $f$;`
    );
    for (const statement of daemonWakeSql()) await pool.query(statement);
    daemon = build();
  });
  afterAll(async () => {
    await pool.query("drop schema if exists grogoni_internal cascade");
    await pool.query("drop function if exists public.grogoni_run_background_job(text)");
    await pool.query("drop function if exists public.grogoni_daemon_wake()");
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  });

  it("retries failed owned tasks idempotently and fences stale leases", async () => {
    const created = await call("session-a", "POST", "/v1/daemon/tasks", {
      key: "owned-retry",
      message: "fail this task"
    });
    const first = (await call("session-a", "POST", "/v1/daemon/claims")).json.claim;
    await call("session-a", "POST", `/v1/daemon/claims/${created.json.task.id}/settle`, {
      leaseToken: first.leaseToken,
      outcome: { errorCode: "PROVIDER_UNAVAILABLE", retryable: false }
    });
    expect(
      (await call("session-b", "POST", `/v1/daemon/tasks/${created.json.task.id}/retry`, {})).status
    ).toBe(404);
    const retries = await Promise.all(
      [1, 2, 3].map(() =>
        call("session-a", "POST", `/v1/daemon/tasks/${created.json.task.id}/retry`, {})
      )
    );
    expect(retries.every((r) => r.status === 200)).toBe(true);
    expect((await daemon.store.get(created.json.task.id))?.attempts).toBe(0);
    const second = (await call("session-a", "POST", "/v1/daemon/claims")).json.claim;
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(
      (
        await call("session-a", "POST", `/v1/daemon/claims/${created.json.task.id}/settle`, {
          leaseToken: first.leaseToken,
          outcome: { text: "stale", modelId: "gpt-6-luna" }
        })
      ).status
    ).toBe(409);
    expect(
      (
        await call("session-a", "POST", `/v1/daemon/claims/${created.json.task.id}/execute`, {
          leaseToken: second.leaseToken
        })
      ).json.task.status
    ).toBe("completed");
  });
  it("retries terminal conversation delivery independently of the latest-50 task list", async () => {
    deliveryFailure = true;
    const created = await call("session-a", "POST", "/v1/daemon/tasks", {
      key: "conversation-outbox",
      message: "hello",
      conversation: {
        id: "11111111-1111-4111-8111-111111111111",
        clientMessageId: "origin-message",
        scope: "test",
        kind: "reply"
      }
    });
    expect(created.status).toBe(201);
    const claim = (await call("session-a", "POST", "/v1/daemon/claims")).json.claim;
    await call("session-a", "POST", `/v1/daemon/claims/${claim.task.id}/execute`, {
      leaseToken: claim.leaseToken
    });
    expect((await daemon.store.pendingConversationDeliveries(100)).map((t) => t.id)).toContain(
      claim.task.id
    );
    for (let i = 0; i < 51; i++)
      await daemon.store.enqueue({
        key: `later-${i}`,
        payload: {
          kind: "agent",
          message: "later",
          modelId: "gpt-6-luna",
          agentAdapterId: "grogoni"
        },
        ownerUserId: "user-a",
        runAt: new Date(Date.now() + 3600000),
        maxAttempts: 1
      });
    deliveryFailure = false;
    await daemon.runWorker();
    expect(delivered).toContain(`${claim.task.id}:completed`);
    expect(await daemon.store.pendingConversationDeliveries(100)).toHaveLength(0);
  });

  it("serves only the signed-in user's tasks and never another user's", async () => {
    const created = await call("session-a", "POST", "/v1/daemon/tasks", {
      key: "morning",
      message: "Summarize yesterday"
    });
    expect(created.status).toBe(201);
    expect(created.json.task).toMatchObject({ status: "queued", lane: null });
    const id = created.json.task.id;
    expect((await call("session-a", "GET", "/v1/daemon/tasks")).json.tasks).toHaveLength(1);
    expect((await call("session-b", "GET", "/v1/daemon/tasks")).json.tasks).toHaveLength(0);
    for (const [method, path] of [
      ["GET", `/v1/daemon/tasks/${id}`],
      ["DELETE", `/v1/daemon/tasks/${id}`]
    ] as const)
      expect((await call("session-b", method, path)).status).toBe(404);
    // B claims nothing of A's, and A's lease token is worthless to B.
    expect((await call("session-b", "POST", "/v1/daemon/claims")).json.claim).toBeNull();
    const claim = (await call("session-a", "POST", "/v1/daemon/claims")).json.claim;
    for (const action of ["renew", "settle", "release", "execute"])
      expect(
        (
          await call("session-b", "POST", `/v1/daemon/claims/${id}/${action}`, {
            leaseToken: claim.leaseToken,
            outcome: { text: "stolen", modelId: "x" }
          })
        ).status,
        action
      ).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("namespaces idempotency keys per user: a reused key never returns another user's row", async () => {
    const first = await call("session-a", "POST", "/v1/daemon/tasks", {
      key: "shared",
      message: "A's private prompt"
    });
    const replay = await call("session-a", "POST", "/v1/daemon/tasks", {
      key: "shared",
      message: "A's private prompt"
    });
    expect(replay.status).toBe(200);
    expect(replay.json.task.id).toBe(first.json.task.id);
    const other = await call("session-b", "POST", "/v1/daemon/tasks", {
      key: "shared",
      message: "B's prompt"
    });
    expect(other.status).toBe(201);
    expect(other.json.task.id).not.toBe(first.json.task.id);
    expect(JSON.stringify(other.json)).not.toContain("A's private prompt");
  });

  it("runs a claim on the device: the lease token is the only credential and is fenced", async () => {
    const id = (await call("session-a", "POST", "/v1/daemon/tasks", { key: "k", message: "hello" }))
      .json.task.id;
    const claim = (await call("session-a", "POST", "/v1/daemon/claims")).json.claim;
    expect(claim).toMatchObject({
      message: "hello",
      task: { id, status: "running", lane: "browser" }
    });
    expect(JSON.stringify(claim)).not.toMatch(/test-key|OPENROUTER/u);
    // A second claim finds nothing: the task is leased.
    expect((await call("session-a", "POST", "/v1/daemon/claims")).json.claim).toBeNull();
    const wrong = await call("session-a", "POST", `/v1/daemon/claims/${id}/settle`, {
      leaseToken: randomUUID(),
      outcome: { text: "x", modelId: "m" }
    });
    expect(wrong).toMatchObject({ status: 409, json: { code: "lease_lost" } });
    expect((await call("session-a", "POST", `/v1/daemon/claims/${id}/renew`, claim)).json).toEqual({
      renewed: true
    });
    const settled = await call("session-a", "POST", `/v1/daemon/claims/${id}/settle`, {
      leaseToken: claim.leaseToken,
      outcome: { text: "Hi from the phone", modelId: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC" }
    });
    expect(settled.json.task).toMatchObject({
      status: "completed",
      lane: "browser",
      result: { text: "Hi from the phone", executedBy: "device" }
    });
    // Settled once; the same token cannot settle again.
    expect(
      (
        await call("session-a", "POST", `/v1/daemon/claims/${id}/settle`, {
          leaseToken: claim.leaseToken,
          outcome: { text: "again", modelId: "m" }
        })
      ).status
    ).toBe(409);
    expect(calls).toHaveLength(0);
  });

  it("executes a claim on the server for a browser without a device model", async () => {
    const id = (
      await call("session-a", "POST", "/v1/daemon/tasks", { key: "k", message: "server please" })
    ).json.task.id;
    const claim = (await call("session-a", "POST", "/v1/daemon/claims")).json.claim;
    const done = await call("session-a", "POST", `/v1/daemon/claims/${id}/execute`, {
      leaseToken: claim.leaseToken
    });
    expect(done.json.task).toMatchObject({
      status: "completed",
      result: { text: "done: server please", executedBy: "server", modelId: "gpt-6-luna" }
    });
    expect(calls).toEqual(["server please"]);
  });

  it("maps server failures to retries or dead letters exactly like the worker", async () => {
    const id = (await call("session-a", "POST", "/v1/daemon/tasks", { key: "k", message: "flaky" }))
      .json.task.id;
    behavior = async () => {
      throw new DaemonTaskError("RATE_LIMITED", true);
    };
    let claim = (await call("session-a", "POST", "/v1/daemon/claims")).json.claim;
    const retried = await call("session-a", "POST", `/v1/daemon/claims/${id}/execute`, {
      leaseToken: claim.leaseToken
    });
    expect(retried.json.task).toMatchObject({ status: "queued", errorCode: "RATE_LIMITED" });
    await pool.query("update grogoni_daemon_tasks set run_at=now() where id=$1", [id]);
    behavior = async () => {
      throw new DaemonTaskError("MODEL_REFUSED", false);
    };
    claim = (await call("session-a", "POST", "/v1/daemon/claims")).json.claim;
    const failed = await call("session-a", "POST", `/v1/daemon/claims/${id}/execute`, {
      leaseToken: claim.leaseToken
    });
    expect(failed.json.task).toMatchObject({ status: "failed", errorCode: "MODEL_REFUSED" });
  });

  it("releases a claim back to the queue and cancels only active tasks", async () => {
    const id = (await call("session-a", "POST", "/v1/daemon/tasks", { key: "k", message: "later" }))
      .json.task.id;
    const claim = (await call("session-a", "POST", "/v1/daemon/claims")).json.claim;
    const released = await call("session-a", "POST", `/v1/daemon/claims/${id}/release`, claim);
    expect(released.json.task).toMatchObject({ status: "queued", attempts: 0 });
    const cancelled = await call("session-a", "DELETE", `/v1/daemon/tasks/${id}`);
    expect(cancelled.json.task.status).toBe("cancelled");
    expect((await call("session-a", "DELETE", `/v1/daemon/tasks/${id}`)).status).toBe(409);
  });

  it("validates input and enforces per-user limits", async () => {
    const bad = async (body: unknown) =>
      (await call("session-a", "POST", "/v1/daemon/tasks", body)).json.code;
    expect(await bad({ key: "has space", message: "x" })).toBe("task_key_invalid");
    expect(await bad({ key: "k", message: "   " })).toBe("task_message_invalid");
    expect(await bad({ key: "k", message: "x".repeat(8_001) })).toBe("task_message_invalid");
    expect(await bad({ key: "k", message: "x", intervalMs: 60_000 })).toBe("task_interval_invalid");
    expect(await bad({ key: "k", message: "x", intervalMs: 900_000.5 })).toBe(
      "task_interval_invalid"
    );
    expect(await bad({ key: "k", message: "x", runAt: "tomorrow" })).toBe("task_run_at_invalid");
    expect(
      await bad({
        key: "k",
        message: "x",
        runAt: new Date(Date.now() + 400 * 86_400_000).toISOString()
      })
    ).toBe("task_run_at_invalid");
    const wrongType = await daemon.routes(
      new Request("https://edge.test/v1/daemon/tasks", {
        method: "POST",
        headers: { cookie: "session-a", "content-type": "text/plain" },
        body: "{}"
      }),
      "/v1/daemon/tasks"
    );
    expect(wrongType?.status).toBe(415);
    expect(
      (
        await call("session-a", "POST", `/v1/daemon/claims/${randomUUID()}/settle`, {
          leaseToken: "nope"
        })
      ).json.code
    ).toBe("lease_token_invalid");
    daemon = build({ ...environment, DAEMON_USER_MAX_ACTIVE: "2" });
    for (const key of ["a", "b"])
      expect(
        (await call("session-a", "POST", "/v1/daemon/tasks", { key, message: "x" })).status
      ).toBe(201);
    const capped = await call("session-a", "POST", "/v1/daemon/tasks", { key: "c", message: "x" });
    expect(capped).toMatchObject({ status: 429, json: { code: "daemon_task_limit" } });
    // A replay of an existing key is not a new task, so the cap does not block it.
    expect(
      (await call("session-a", "POST", "/v1/daemon/tasks", { key: "a", message: "x" })).status
    ).toBe(200);
    // Another user has their own budget.
    expect(
      (await call("session-b", "POST", "/v1/daemon/tasks", { key: "c", message: "x" })).status
    ).toBe(201);
  });

  it("refuses new tasks when the server lane cannot run them", async () => {
    daemon = build({ ...environment, OPENROUTER_API_KEY: "" });
    expect(
      (await call("session-a", "POST", "/v1/daemon/tasks", { key: "k", message: "x" })).json.code
    ).toBe("daemon_server_lane_unavailable");
    daemon = build({ ...environment, PLATFORM_DEFAULT_MODEL_ID: "unmapped-model" });
    expect(
      (await call("session-a", "POST", "/v1/daemon/tasks", { key: "k", message: "x" })).status
    ).toBe(503);
  });

  it("requires a session and ignores paths it does not own", async () => {
    expect(await call("nobody", "GET", "/v1/daemon/tasks")).toMatchObject({
      status: 401,
      json: { code: "auth_required" }
    });
    expect((await call("session-a", "GET", "/v1/daemon/elsewhere")).status).toBe(0);
    expect((await call("session-a", "GET", "/v1/other")).status).toBe(0);
    expect((await call("session-a", "PUT", "/v1/daemon/tasks")).status).toBe(405);
  });

  it("serves exactly the routes it publishes for the API route checker", async () => {
    const id = randomUUID();
    for (const route of daemonLaneRoutes) {
      const response = await call(
        "session-a",
        route.method,
        route.path.replace(":taskId", id),
        route.method === "POST" ? {} : undefined
      );
      // Handled (answered by this lane), whatever the answer for an unknown task is.
      expect(response.status, `${route.method} ${route.path}`).not.toBe(0);
    }
    for (const unpublished of [
      "/v1/daemon/claims/x",
      "/v1/daemon/tasks/x/run",
      "/v1/daemon/claims/x/execute/again"
    ])
      expect((await call("session-a", "POST", unpublished, {})).status, unpublished).toBe(0);
  });

  it("server lane: operator work at once, a user's task only after the takeover delay", async () => {
    const operator = await daemon.store.enqueue({
      key: "operator",
      payload: {
        kind: "agent",
        message: "operator job",
        modelId: "gpt-6-luna",
        agentAdapterId: "grogoni"
      },
      runAt: new Date(),
      maxAttempts: 3
    });
    const user = (
      await call("session-a", "POST", "/v1/daemon/tasks", { key: "k", message: "user job" })
    ).json.task.id;
    const first = await daemon.runWorker();
    expect(first).toMatchObject({ claimed: 1, finished: 1, hint: "updated" });
    // Only the user's task remains: the server is next due when its takeover delay ends.
    const userRunAt = new Date((await daemon.store.get(user))!.run_at).getTime();
    expect(new Date(first.nextServerDueAt!).getTime()).toBe(userRunAt + 600_000);
    expect(new Date((await hintRow()).next_due_at).getTime()).toBe(userRunAt + 600_000);
    expect(calls).toEqual(["operator job"]);
    expect((await daemon.store.get(operator.id))?.lane).toBe("server");
    expect((await daemon.store.get(user))?.status).toBe("queued");
    // Ten minutes pass with no browser: the server takes it over.
    await pool.query(
      "update grogoni_daemon_tasks set run_at=now()-interval '10 minutes 1 second' where id=$1",
      [user]
    );
    const second = await daemon.runWorker();
    expect(second).toMatchObject({
      claimed: 1,
      finished: 1,
      nextServerDueAt: null,
      hint: "updated"
    });
    expect(await daemon.store.get(user)).toMatchObject({
      status: "completed",
      lane: "server",
      result: { text: "done: user job", executedBy: "server" }
    });
    expect((await hintRow()).next_due_at).toBeNull();
  });

  it("never starts a task that cannot finish inside the run budget", async () => {
    daemon = build({
      ...environment,
      DAEMON_EDGE_RUN_BUDGET_MS: "10000",
      DAEMON_EDGE_TASK_TIMEOUT_MS: "5000"
    });
    behavior = async (message) => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      return agentResult(message);
    };
    for (const key of ["a", "b", "c", "d"])
      await daemon.store.enqueue({
        key,
        payload: { kind: "agent", message: key, modelId: "gpt-6-luna", agentAdapterId: "grogoni" },
        runAt: new Date(),
        maxAttempts: 3
      });
    const run = await daemon.runWorker();
    // 3s tasks with a 5s timeout in a 10s budget: claims at ~0s and ~3s; at ~6s, 5s no longer fits.
    expect(run.claimed).toBe(2);
    expect(run.durationMs).toBeLessThan(10_000);
    // The backlog stays due, so the next tick wakes another run to continue it.
    expect(new Date(run.nextServerDueAt!).getTime()).toBeLessThanOrEqual(Date.now());
  }, 20_000);

  it("keeps the wake hint conservative: lowered on new work, superseded runs never raise it", async () => {
    const hint = createPostgresWakeHint(pool);
    await pool.query("update grogoni_internal.daemon_wake set next_due_at=null");
    const before = Date.now();
    await call("session-a", "POST", "/v1/daemon/tasks", { key: "k", message: "x" });
    const lowered = new Date((await hintRow()).next_due_at).getTime();
    // A user task is due for the server only after the takeover delay.
    expect(lowered).toBeGreaterThanOrEqual(before + 600_000 - 1_000);
    expect(lowered).toBeLessThanOrEqual(Date.now() + 600_000 + 1_000);
    // A run that read the version before new work landed cannot overwrite the lowered value.
    const version = await hint.version();
    await hint.lower(new Date(Date.now() - 1_000));
    expect(await hint.set(new Date(Date.now() + 3_600_000), version)).toBe(false);
    expect(new Date((await hintRow()).next_due_at).getTime()).toBeLessThan(Date.now());
    // lower() never moves it later.
    await hint.lower(new Date(Date.now() + 86_400_000));
    expect(new Date((await hintRow()).next_due_at).getTime()).toBeLessThan(Date.now());
  });

  it("re-queued recurring work lowers the hint to its next run plus the takeover delay", async () => {
    const id = (
      await call("session-a", "POST", "/v1/daemon/tasks", {
        key: "daily",
        message: "daily digest",
        intervalMs: 86_400_000
      })
    ).json.task.id;
    await pool.query("update grogoni_internal.daemon_wake set next_due_at=null");
    const claim = (await call("session-a", "POST", "/v1/daemon/claims")).json.claim;
    const settled = await call("session-a", "POST", `/v1/daemon/claims/${id}/settle`, {
      leaseToken: claim.leaseToken,
      outcome: { text: "digest", modelId: "m" }
    });
    expect(settled.json.task).toMatchObject({ status: "queued", executions: 1 });
    const due = new Date((await hintRow()).next_due_at).getTime();
    expect(due).toBeGreaterThan(Date.now() + 86_400_000 + 590_000);
  });

  it("the per-minute wake check calls the worker only when work is due, at most once a minute", async () => {
    await pool.query("update grogoni_internal.daemon_wake set next_due_at=now()+interval '1 hour'");
    await pool.query("select public.grogoni_daemon_wake()");
    expect(await wakeCalls()).toBe(0);
    await pool.query(
      "update grogoni_internal.daemon_wake set next_due_at=now()-interval '1 second'"
    );
    await pool.query("select public.grogoni_daemon_wake()");
    await pool.query("select public.grogoni_daemon_wake()");
    expect(await wakeCalls()).toBe(1);
    expect((await pool.query("select job from wake_calls")).rows[0].job).toBe("daemon_worker");
    await pool.query(
      "update grogoni_internal.daemon_wake set last_wake_at=now()-interval '56 seconds'"
    );
    await pool.query("select public.grogoni_daemon_wake()");
    expect(await wakeCalls()).toBe(2);
    // Re-applying the schedule SQL keeps the existing hint.
    for (const statement of daemonWakeSql()) await pool.query(statement);
    expect((await hintRow()).last_wake_at).not.toBeNull();
  });

  it("serves the native gateway to operators: token-guarded, hint-aware, maintenance in-process", async () => {
    const token = "o".repeat(40);
    const maintenance: string[] = [];
    const operatorDaemon = (env: Record<string, string>) =>
      createEdgeDaemon({
        queue: pool,
        hint: createPostgresWakeHint(pool),
        authenticate: async () => {
          throw new DaemonHttpError(401, "auth_required", "Authentication is required.");
        },
        environment: env,
        runMaintenance: async (job) => {
          maintenance.push(job);
          return { ran: job };
        }
      });
    const operator = async (
      target: EdgeDaemon,
      method: string,
      path: string,
      body?: unknown,
      bearer = token
    ) => {
      const response = await target.routes(
        new Request(`https://edge.test${path}`, {
          method,
          headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        }),
        path
      );
      return { status: response!.status, json: (await response!.json()) as Body };
    };
    // Without DAEMON_SERVICE_TOKEN the operator API does not exist.
    expect((await operator(build(), "GET", "/internal/daemon/v1/stats")).status).toBe(404);
    const target = operatorDaemon({ ...environment, DAEMON_SERVICE_TOKEN: token });
    expect(
      (await operator(target, "GET", "/internal/daemon/v1/stats", undefined, "x".repeat(40))).status
    ).toBe(401);
    await pool.query("update grogoni_internal.daemon_wake set next_due_at=null");
    const submitted = await operator(target, "POST", "/internal/daemon/v1/tasks", {
      key: "nightly-purge",
      payload: { kind: "maintenance", job: "edge_rate_limit_retention" }
    });
    expect(submitted.status).toBe(202);
    // Operator work is due for the server at once: no takeover delay.
    expect(new Date((await hintRow()).next_due_at).getTime()).toBeLessThanOrEqual(Date.now());
    expect(await target.runWorker()).toMatchObject({ claimed: 1, finished: 1 });
    expect(maintenance).toEqual(["edge_rate_limit_retention"]);
    expect(
      (await operator(target, "GET", `/internal/daemon/v1/tasks/${submitted.json.id}`)).json
    ).toMatchObject({
      status: "completed",
      lane: "server",
      result: { ran: "edge_rate_limit_retention" }
    });
    // An agent task that the server cannot run is refused, never queued to dead-letter later.
    const refused = await operator(
      operatorDaemon({ DAEMON_SERVICE_TOKEN: token }),
      "POST",
      "/internal/daemon/v1/tasks",
      { key: "agent", payload: { kind: "agent", message: "hi" } }
    );
    expect(refused).toMatchObject({ status: 422, json: { error: "AGENT_RUNTIME_NOT_CONFIGURED" } });
    // The worker job itself cannot be queued: in-process it would only find its own lock held.
    const self = await operator(target, "POST", "/internal/daemon/v1/tasks", {
      key: "self",
      payload: { kind: "maintenance", job: "daemon_worker" }
    });
    expect(self).toMatchObject({ status: 422, json: { error: "JOB_NOT_QUEUEABLE" } });
  }, 20_000);

  it("runs a claim on the server exactly once, however often /execute is sent at once", async () => {
    behavior = async (message) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return agentResult(message);
    };
    const id = (
      await call("session-a", "POST", "/v1/daemon/tasks", { key: "k", message: "pay once" })
    ).json.task.id;
    const claim = (await call("session-a", "POST", "/v1/daemon/claims")).json.claim;
    const lease = { leaseToken: claim.leaseToken };
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () =>
        call("session-a", "POST", `/v1/daemon/claims/${id}/execute`, lease)
      )
    );
    expect(calls).toEqual(["pay once"]);
    expect(attempts.filter((attempt) => attempt.status === 200)).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 409)).toHaveLength(9);
    // A device settling the same claim afterwards is fenced too.
    expect(
      (
        await call("session-a", "POST", `/v1/daemon/claims/${id}/settle`, {
          ...lease,
          outcome: { text: "late", modelId: "m" }
        })
      ).status
    ).toBe(409);
  });

  it("holds the per-user cap and create-once under concurrency", async () => {
    daemon = build({ ...environment, DAEMON_USER_MAX_ACTIVE: "20" });
    const creates = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        call("session-a", "POST", "/v1/daemon/tasks", { key: `k${index}`, message: "x" })
      )
    );
    expect(creates.filter((create) => create.status === 201)).toHaveLength(20);
    expect(creates.filter((create) => create.status === 429)).toHaveLength(20);
    expect(await daemon.store.countActiveOwned("user-a")).toBe(20);
    const same = await Promise.all(
      Array.from({ length: 10 }, () =>
        call("session-b", "POST", "/v1/daemon/tasks", { key: "same", message: "x" })
      )
    );
    expect(same.filter((create) => create.status === 201)).toHaveLength(1);
    expect(new Set(same.map((create) => create.json.task.id)).size).toBe(1);
  });

  it("refuses text PostgreSQL cannot store, and settles device failures and bad results right", async () => {
    for (const message of ["nul \u0000 inside", "lone \ud800 surrogate"])
      expect(
        (await call("session-a", "POST", "/v1/daemon/tasks", { key: "k", message })).json.code
      ).toBe("task_message_invalid");
    const id = (await call("session-a", "POST", "/v1/daemon/tasks", { key: "k", message: "x" }))
      .json.task.id;
    const claim = (await call("session-a", "POST", "/v1/daemon/claims")).json.claim;
    const settle = (outcome: unknown) =>
      call("session-a", "POST", `/v1/daemon/claims/${id}/settle`, {
        leaseToken: claim.leaseToken,
        outcome
      });
    for (const outcome of [
      { text: "lone \ud800", modelId: "m" },
      { text: "x".repeat(32_001), modelId: "m" },
      { text: "ok", modelId: "has spaces" },
      { errorCode: "lower_case" },
      {}
    ])
      expect((await settle(outcome)).json.code, JSON.stringify(outcome).slice(0, 40)).toBe(
        "outcome_invalid"
      );
    const failed = await settle({ errorCode: "DEVICE_OUT_OF_MEMORY", retryable: true });
    expect(failed.json.task).toMatchObject({
      status: "queued",
      errorCode: "DEVICE_OUT_OF_MEMORY"
    });
  });

  it("dead-letters a server result PostgreSQL cannot store instead of failing the request", async () => {
    behavior = async () => agentResult("broken \ud800 reply");
    const id = (await call("session-a", "POST", "/v1/daemon/tasks", { key: "k", message: "x" }))
      .json.task.id;
    const claim = (await call("session-a", "POST", "/v1/daemon/claims")).json.claim;
    const done = await call("session-a", "POST", `/v1/daemon/claims/${id}/execute`, {
      leaseToken: claim.leaseToken
    });
    expect(done.status).toBe(200);
    expect(done.json.task).toMatchObject({ status: "failed", errorCode: "RESULT_NOT_STORABLE" });
  });

  it("gives the browser the server's timings, and an idle tab the delay to the next task", async () => {
    expect((await call("session-a", "POST", "/v1/daemon/claims")).json).toEqual({
      claim: null,
      nextDueInMs: null
    });
    await call("session-a", "POST", "/v1/daemon/tasks", {
      key: "later",
      message: "x",
      runAt: new Date(Date.now() + 120_000).toISOString()
    });
    const idle = (await call("session-a", "POST", "/v1/daemon/claims")).json as unknown as {
      nextDueInMs: number;
    };
    expect(idle.nextDueInMs).toBeGreaterThan(115_000);
    expect(idle.nextDueInMs).toBeLessThanOrEqual(120_000);
    await call("session-a", "POST", "/v1/daemon/tasks", { key: "now", message: "x" });
    expect((await call("session-a", "POST", "/v1/daemon/claims")).json.claim).toMatchObject({
      leaseMs: 60_000,
      executeTimeoutMs: 35_000
    });
  });

  it("switched off, runs nothing and silences the per-minute wake", async () => {
    daemon = build({ ...environment, ENABLE_DAEMON_WORKER: "false" });
    await daemon.store.enqueue({
      key: "operator",
      payload: { kind: "agent", message: "x", modelId: "gpt-6-luna", agentAdapterId: "grogoni" },
      runAt: new Date(),
      maxAttempts: 3
    });
    await pool.query("update grogoni_internal.daemon_wake set next_due_at=now()");
    expect(await daemon.runWorker()).toMatchObject({ disabled: true, claimed: 0 });
    expect((await hintRow()).next_due_at).toBeNull();
    expect(calls).toEqual([]);
    await pool.query("select public.grogoni_daemon_wake()");
    expect(await wakeCalls()).toBe(0);
  });

  it("wakes for an exhausted claim when its lease ends, with no takeover delay", async () => {
    const id = (await call("session-a", "POST", "/v1/daemon/tasks", { key: "k", message: "x" }))
      .json.task.id;
    await pool.query(
      `update grogoni_daemon_tasks set status='running', attempts=max_attempts,
         lease_token=gen_random_uuid(), lease_until=now()-interval '1 second' where id=$1`,
      [id]
    );
    const due = await daemon.store.nextServerDueAt();
    expect(due!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await daemon.runWorker()).toMatchObject({ leaseExhausted: 1, nextServerDueAt: null });
    expect(await daemon.store.get(id)).toMatchObject({
      status: "failed",
      error_code: "LEASE_EXHAUSTED"
    });
  });

  it("stops an in-flight /execute model call when the task is cancelled, and counts it until then", async () => {
    // A 20s task timeout: only the heartbeat (5s) can explain an answer within ~6.5s.
    daemon = build({
      ...environment,
      DAEMON_EDGE_RUN_BUDGET_MS: "30000",
      DAEMON_EDGE_TASK_TIMEOUT_MS: "20000",
      DAEMON_USER_MAX_ACTIVE: "1"
    });
    let aborted = false;
    behavior = (_message, signal) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        })
      );
    const id = (
      await call("session-a", "POST", "/v1/daemon/tasks", { key: "k", message: "long job" })
    ).json.task.id;
    const claim = (await call("session-a", "POST", "/v1/daemon/claims")).json.claim;
    const started = Date.now();
    const running = call("session-a", "POST", `/v1/daemon/claims/${id}/execute`, {
      leaseToken: claim.leaseToken
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await call("session-a", "DELETE", `/v1/daemon/tasks/${id}`)).status).toBe(200);
    // Cancelled but still running: it still counts, so cancel-and-recreate cannot beat the cap.
    expect(
      (await call("session-a", "POST", "/v1/daemon/tasks", { key: "next", message: "x" })).status
    ).toBe(429);
    const answer = await running;
    expect(answer).toMatchObject({ status: 409, json: { code: "lease_lost" } });
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(6_500);
    expect((await daemon.store.get(id))?.status).toBe("cancelled");
    // Stopped: the slot is free again.
    expect(
      (await call("session-a", "POST", "/v1/daemon/tasks", { key: "next", message: "x" })).status
    ).toBe(201);
  }, 20_000);

  it("holds /execute to its timeout even when the model ignores the abort signal", async () => {
    behavior = () =>
      new Promise((resolve) => setTimeout(() => resolve(agentResult("late")), 9_000));
    const id = (await call("session-a", "POST", "/v1/daemon/tasks", { key: "k", message: "x" }))
      .json.task.id;
    const claim = (await call("session-a", "POST", "/v1/daemon/claims")).json.claim;
    const started = Date.now();
    const done = await call("session-a", "POST", `/v1/daemon/claims/${id}/execute`, {
      leaseToken: claim.leaseToken
    });
    // The test environment's task timeout is 5s.
    expect(Date.now() - started).toBeLessThan(7_000);
    expect(done.json.task).toMatchObject({ status: "queued", errorCode: "TASK_TIMEOUT" });
  }, 15_000);

  it("never holds a user request longer than 3s on a hanging hint database", async () => {
    const hanging = {
      version: async () => 0,
      lower: () => new Promise<void>(() => {}),
      set: async () => true
    };
    daemon = build(environment, hanging);
    const started = Date.now();
    const created = await call("session-a", "POST", "/v1/daemon/tasks", { key: "k", message: "x" });
    expect(created.status).toBe(201);
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 10_000);

  it("bounds a server run's hint reads and writes when the hint database hangs", async () => {
    const hangingSet = {
      version: async () => 0,
      lower: async () => undefined,
      set: () => new Promise<boolean>(() => {})
    };
    daemon = build(environment, hangingSet);
    let started = Date.now();
    expect(await daemon.runWorker()).toMatchObject({ claimed: 0, hint: "unavailable" });
    expect(Date.now() - started).toBeLessThan(4_500);
    daemon = build(environment, { ...hangingSet, version: () => new Promise<number>(() => {}) });
    started = Date.now();
    expect(await daemon.runWorker()).toMatchObject({ hint: "unavailable" });
    expect(Date.now() - started).toBeLessThan(4_500);
  }, 15_000);

  it("works without a hint database: the hourly sweep is then the only wake", async () => {
    daemon = build(environment, false);
    expect(
      (await call("session-a", "POST", "/v1/daemon/tasks", { key: "k", message: "x" })).status
    ).toBe(201);
    expect(await daemon.runWorker()).toMatchObject({ claimed: 0, hint: "unavailable" });
  });
});

describe("daemon lane units", () => {
  it("never settles a maintenance task as done when its job did not run", async () => {
    const run = (status: "completed" | "disabled" | "skipped") =>
      maintenanceFromJobRunner(async () => ({ status }))("edge_rate_limit_retention");
    await expect(run("completed")).resolves.toEqual({ status: "completed" });
    await expect(run("skipped")).rejects.toMatchObject({
      code: "JOB_ALREADY_RUNNING",
      retryable: true
    });
    await expect(run("disabled")).rejects.toMatchObject({ code: "JOB_DISABLED", retryable: false });
  });

  it("hands back unstarted a task whose slow claim left too little of the run budget", async () => {
    const task = { id: "t", lease_token: "l" } as DaemonTask;
    const released: string[] = [];
    const executed: string[] = [];
    const store = {
      expireExhausted: async () => [],
      claim: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return task;
      },
      release: async (claimed: DaemonTask) => {
        released.push(claimed.id);
        return true;
      }
    } as unknown as DaemonTaskStore;
    await runDaemonWorker({
      store,
      execute: async () => {
        executed.push("ran");
        return null;
      },
      signal: new AbortController().signal,
      taskTimeoutMs: 1_000,
      // Fits when the claim starts, no longer fits once it returns.
      runUntil: performance.now() + 1_200,
      exitWhenIdle: true
    });
    expect(executed).toEqual([]);
    expect(released).toEqual(["t"]);
  });
});

describe("daemon lane configuration", () => {
  it("has safe defaults and rejects out-of-range settings", () => {
    expect(readEdgeDaemonConfig({})).toEqual({
      takeoverMs: 600_000,
      runBudgetMs: 120_000,
      taskTimeoutMs: 60_000,
      browserLeaseMs: 60_000,
      maxActivePerUser: 20,
      minUserIntervalMs: 900_000,
      modelId: null
    });
    expect(() => readEdgeDaemonConfig({ DAEMON_USER_TAKEOVER_MS: "59999" })).toThrow(
      "DAEMON_USER_TAKEOVER_MS"
    );
    // A task timeout must leave room to settle inside the run budget.
    expect(() =>
      readEdgeDaemonConfig({
        DAEMON_EDGE_RUN_BUDGET_MS: "20000",
        DAEMON_EDGE_TASK_TIMEOUT_MS: "16000"
      })
    ).toThrow("DAEMON_EDGE_TASK_TIMEOUT_MS");
    expect(() => readEdgeDaemonConfig({ DAEMON_USER_MAX_ACTIVE: "1e3" })).toThrow(
      "DAEMON_USER_MAX_ACTIVE"
    );
  });
});
