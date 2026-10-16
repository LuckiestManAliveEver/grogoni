import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { createPostgresDaemonTaskStore, daemonQueueMigrations } from "./task-store.js";

const url = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
describe.skipIf(!url)("durable native daemon queue", () => {
  const schema = `daemon_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url ?? "" });
  const pool = new Pool({ connectionString: url ?? "", options: `-c search_path=${schema}` });
  const store = createPostgresDaemonTaskStore(pool);
  const enqueue = (key: string = randomUUID(), extra = {}) =>
    store.enqueue({
      key,
      payload: {
        kind: "agent",
        message: "hello",
        modelId: "gpt-6-luna",
        agentAdapterId: "grogoni"
      },
      runAt: new Date(),
      maxAttempts: 3,
      ...extra
    });
  beforeAll(async () => {
    await admin.query(`create schema ${schema}`);
    for (const file of daemonQueueMigrations)
      await pool.query(
        await readFile(new URL(`../../../../infra/db/migrations/${file}`, import.meta.url), "utf8")
      );
  });
  beforeEach(async () => {
    await pool.query("truncate grogoni_daemon_tasks");
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  });

  it("deduplicates submissions and gives only one worker ownership", async () => {
    const tasks = await Promise.all([enqueue("same"), enqueue("same")]);
    expect(tasks[0]!.id).toBe(tasks[1]!.id);
    const claims = await Promise.all([store.claim(30_000), store.claim(30_000)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await store.settle(claims.find(Boolean)!, { result: { ok: true } });
    expect(await store.get(tasks[0]!.id)).toMatchObject({
      status: "completed",
      executions: "1",
      result: { ok: true }
    });
  });
  it("recovers expired leases and fences stale results", async () => {
    await enqueue();
    const first = (await store.claim(30_000))!;
    await pool.query("update grogoni_daemon_tasks set lease_until=now()-interval '1 second'");
    const next = (await store.claim(30_000))!;
    expect(next.lease_token).not.toBe(first.lease_token);
    expect(await store.renew(first, 30_000)).toBe(false);
    expect(await store.settle(first, { result: { stale: true } })).toBe(false);
    expect((await store.get(next.id))!.status).toBe("running");
    expect(await store.settle(next, { result: { fresh: true } })).toBe(true);
    expect((await store.get(next.id))!.result).toEqual({ fresh: true });
  });
  it("cancels running work and rejects late completion", async () => {
    const item = await enqueue();
    const claim = (await store.claim(30_000))!;
    expect(await store.cancel(item.id)).toBe(true);
    expect(await store.renew(claim, 30_000)).toBe(false);
    await store.settle(claim, { result: "late" });
    expect((await store.get(item.id))!.status).toBe("cancelled");
  });
  it("reschedules recurring work and respects future starts", async () => {
    const item = await enqueue("recurring", { intervalMs: 60_000 });
    await store.settle((await store.claim(30_000))!, { result: "done" });
    expect(await store.get(item.id)).toMatchObject({
      status: "queued",
      attempts: 0,
      result: "done"
    });
    expect(await store.claim(30_000)).toBeNull();
  });
  it("backs off retryable failures and dead-letters exhausted crashes", async () => {
    const item = await enqueue();
    const claim = (await store.claim(30_000))!;
    await store.settle(claim, { errorCode: "RATE_LIMITED", retryable: true });
    expect((await store.get(item.id))!.status).toBe("queued");
    expect(await store.claim(30_000)).toBeNull();
    await pool.query(
      "update grogoni_daemon_tasks set status='running',lease_token=gen_random_uuid(),attempts=3,lease_until=now()-interval '1 second'"
    );
    expect(await store.claim(30_000)).toBeNull();
    expect(await store.expireExhausted()).toEqual([item.id]);
    expect(await store.expireExhausted()).toEqual([]);
    expect(await store.claim(30_000)).toBeNull();
    expect(await store.get(item.id)).toMatchObject({
      status: "failed",
      error_code: "LEASE_EXHAUSTED"
    });
  });
  it("releases shutdown claims without exhausting their attempt budget", async () => {
    const item = await enqueue();
    const claim = (await store.claim(30_000))!;
    expect(await store.release(claim)).toBe(true);
    expect(await store.release(claim)).toBe(false);
    expect(await store.get(item.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(await store.claim(30_000)).not.toBeNull();
  });
  it("lists dead letters and allows explicit retry without resetting running work", async () => {
    const item = await enqueue();
    const claim = (await store.claim(30_000))!;
    expect(await store.retry(item.id)).toBe(false);
    await store.settle(claim, { errorCode: "INVALID_INPUT", retryable: false });
    expect((await store.list())[0]).toMatchObject({ id: item.id, status: "failed" });
    expect(await store.retry(item.id)).toBe(true);
    expect(await store.get(item.id)).toMatchObject({
      status: "queued",
      attempts: 0,
      error_code: null
    });
  });
  it("purges only expired terminal tasks, oldest first, in bounded batches", async () => {
    const make = async (key: string, status: string, ageDays: number, intervalMs?: number) => {
      const item = await enqueue(key, intervalMs ? { intervalMs } : {});
      await pool.query(
        `update grogoni_daemon_tasks set status=$2,updated_at=now()-$3::int*interval '1 day',
          lease_token=case when $2='running' then gen_random_uuid() end,
          lease_until=case when $2='running' then now()+interval '1 minute' end where id=$1`,
        [item.id, status, ageDays]
      );
      return item.id;
    };
    const oldDone = await make("old-done", "completed", 40);
    const oldFailed = await make("old-failed", "failed", 35);
    const oldCancelled = await make("old-cancelled", "cancelled", 31);
    const freshDone = await make("fresh-done", "completed", 1);
    const oldQueued = await make("old-queued", "queued", 90);
    const oldRunning = await make("old-running", "running", 90);
    const recurring = await make("recurring-queued", "queued", 90, 60_000);
    const thirtyDays = 30 * 86_400_000;
    expect(await store.purge(thirtyDays, 2)).toBe(2);
    // Oldest first: the 40- and 35-day rows go in the first batch.
    expect(await store.get(oldDone)).toBeNull();
    expect(await store.get(oldFailed)).toBeNull();
    expect(await store.get(oldCancelled)).not.toBeNull();
    expect(await store.purge(thirtyDays, 2)).toBe(1);
    expect(await store.purge(thirtyDays, 2)).toBe(0);
    for (const kept of [freshDone, oldQueued, oldRunning, recurring])
      expect(await store.get(kept)).not.toBeNull();
    // A purged idempotency key can be submitted again as new work.
    const again = await enqueue("old-done");
    expect(again.id).not.toBe(oldDone);
  });
  it("never deletes a task requeued by a retry that races the purge", async () => {
    // Regression: purge filtered only in a subquery, so after waiting on the retry's row lock it
    // deleted the row even though it had become queued.
    const item = await enqueue("raced");
    await pool.query(
      "update grogoni_daemon_tasks set status='failed',updated_at=now()-interval '40 days' where id=$1",
      [item.id]
    );
    const retrying = await pool.connect();
    try {
      await retrying.query("begin");
      await retrying.query(
        "update grogoni_daemon_tasks set status='queued',attempts=0,updated_at=now() where id=$1",
        [item.id]
      );
      const purging = store.purge(30 * 86_400_000, 10);
      await delay(200);
      await retrying.query("commit");
      expect(await purging).toBe(0);
    } finally {
      retrying.release();
    }
    expect(await store.get(item.id)).toMatchObject({ status: "queued" });
  });
  it("blocks retry of a task cancelled mid-run until its old lease has expired", async () => {
    // Regression: cancel cleared lease_until, so retry handed the task to a second worker while
    // the first was still executing it.
    const item = await enqueue("cancel-retry");
    const first = (await store.claim(30_000))!;
    expect(await store.cancel(item.id)).toBe(true);
    expect(await store.renew(first, 30_000)).toBe(false);
    expect(await store.retry(item.id)).toBe(false);
    expect(await store.claim(30_000)).toBeNull();
    await pool.query(
      "update grogoni_daemon_tasks set lease_until=now()-interval '1 second' where id=$1",
      [item.id]
    );
    expect(await store.retry(item.id)).toBe(true);
    const second = (await store.claim(30_000))!;
    expect(second.id).toBe(item.id);
    expect(await store.settle(first, { result: "stale" })).toBe(false);
    // A queued (never started) task can still be cancelled and retried immediately.
    const idle = await enqueue("idle-cancel", { runAt: new Date(Date.now() + 60_000) });
    expect(await store.cancel(idle.id)).toBe(true);
    expect(await store.retry(idle.id)).toBe(true);
  });
  it("stores model output containing NUL characters instead of failing settlement", async () => {
    await enqueue("nul");
    const claim = (await store.claim(30_000))!;
    expect(await store.settle(claim, { result: { text: "a\u0000b", nested: ["\u0000"] } })).toBe(
      true
    );
    expect((await store.get(claim.id))!.result).toEqual({ text: "a\uFFFDb", nested: ["\uFFFD"] });
  });
  it("refuses to boot with invalid configuration and retries an unreachable database", async () => {
    const run = (
      env: Record<string, string>,
      untilLine?: string,
      signal: NodeJS.Signals = "SIGKILL"
    ) =>
      new Promise<{ code: number | null; output: string }>((resolve) => {
        const daemon = spawn(
          process.execPath,
          ["--import", "tsx", "services/api/src/daemon/index.ts"],
          {
            cwd: process.cwd(),
            stdio: "pipe",
            env: { ...process.env, DAEMON_SERVICE_TOKEN: randomUUID(), DAEMON_PORT: "1", ...env }
          }
        );
        let output = "";
        const collect = (chunk: Buffer) => {
          output += chunk.toString();
          if (untilLine && output.includes(untilLine)) daemon.kill(signal);
        };
        daemon.stdout.on("data", collect);
        daemon.stderr.on("data", collect);
        daemon.on("exit", (code) => resolve({ code, output }));
      });
    const invalid = await run({
      DAEMON_DATABASE_URL: url!,
      OPENROUTER_API_KEY: "key",
      PLATFORM_DEFAULT_MODEL_ID: "bogus-model"
    });
    expect(invalid.code).not.toBe(0);
    expect(invalid.output).toContain("not mapped in OPENROUTER_MODELS");
    const nothing = await run({ DAEMON_DATABASE_URL: url!, OPENROUTER_API_KEY: "" });
    expect(nothing.output).toContain("Nothing to run");
    const badPorts = await Promise.all(
      ["0x50", "1e3", "0b1010000", "80.5", "70000"].map((port) =>
        run({ DAEMON_DATABASE_URL: url!, OPENROUTER_API_KEY: "key", DAEMON_PORT: port })
      )
    );
    for (const badPort of badPorts) {
      expect(badPort.code).not.toBe(0);
      expect(badPort.output).toContain("DAEMON_PORT must be a decimal integer");
    }
    // A blank DAEMON_HOST means the default loopback bind, never every interface.
    const schemaUrl = new URL(url!);
    schemaUrl.searchParams.set("options", `-c search_path=${schema}`);
    const blankHost = await run(
      {
        DAEMON_DATABASE_URL: schemaUrl.toString(),
        OPENROUTER_API_KEY: "key",
        DAEMON_HOST: "",
        DAEMON_PORT: "42797"
      },
      '"type":"daemon_started"',
      "SIGTERM"
    );
    expect(blankHost.output).toContain('"host":"127.0.0.1"');
    expect(blankHost.code).toBe(0);
    // SIGTERM while waiting for an unreachable database exits promptly and cleanly.
    const stopped = Date.now();
    const unreachable = await run(
      {
        DAEMON_DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none",
        OPENROUTER_API_KEY: "key",
        DAEMON_PORT: "42799"
      },
      "database_startup_retry",
      "SIGTERM"
    );
    expect(unreachable.output).toContain('"type":"database_startup_retry"');
    expect(unreachable.code).toBe(0);
    expect(Date.now() - stopped).toBeLessThan(10_000);
    expect(unreachable.output).not.toContain("database_startup_recovered");
  }, 60_000);
  it("rejects a running row without a lease at the schema level", async () => {
    const item = await enqueue("unleased");
    await expect(
      pool.query("update grogoni_daemon_tasks set status='running' where id=$1", [item.id])
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("summarizes queue health for operators", async () => {
    await enqueue("due");
    await enqueue("future", { runAt: new Date(Date.now() + 3_600_000) });
    await pool.query(
      "update grogoni_daemon_tasks set run_at=now()-interval '90 seconds' where idempotency_key='due'"
    );
    const running = await enqueue("crashed");
    await pool.query(
      "update grogoni_daemon_tasks set status='running',lease_token=gen_random_uuid(),lease_until=now()-interval '1 second' where id=$1",
      [running.id]
    );
    const stats = await store.stats();
    expect(stats.counts).toEqual({ queued: 2, running: 1, completed: 0, failed: 0, cancelled: 0 });
    expect(stats.oldestDueSeconds).toBeGreaterThanOrEqual(89);
    expect(stats.oldestDueSeconds).toBeLessThan(120);
    expect(stats.expiredLeases).toBe(1);
    await pool.query("truncate grogoni_daemon_tasks");
    expect(await store.stats()).toEqual({
      counts: { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 },
      oldestDueSeconds: 0,
      expiredLeases: 0
    });
  });
  it("runs the full queue lifecycle as the least-privilege role and nothing more", async () => {
    const role = `grogoni_daemon_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const password = randomUUID();
    const grants = (
      await readFile(
        new URL("../../../../infra/db/roles/grogoni_daemon_role.sql", import.meta.url),
        "utf8"
      )
    ).replace(/\bgrogoni_daemon\b/gu, role);
    await admin.query(`create role ${role} login password '${password}'`);
    await pool.query(grants);
    await pool.query("create table if not exists unrelated_secrets (value text)");
    const limited = new URL(url!);
    limited.username = role;
    limited.password = password;
    limited.searchParams.set("options", `-c search_path=${schema}`);
    const rolePool = new Pool({ connectionString: limited.toString() });
    try {
      const roleStore = createPostgresDaemonTaskStore(rolePool);
      await roleStore.health();
      const item = await roleStore.enqueue({
        key: "role",
        payload: { kind: "maintenance", job: "connected_mailbox_sync" },
        runAt: new Date(),
        maxAttempts: 1
      });
      const claim = (await roleStore.claim(30_000))!;
      expect(await roleStore.renew(claim, 30_000)).toBe(true);
      expect(await roleStore.settle(claim, { result: "ok" })).toBe(true);
      await roleStore.stats();
      await pool.query(
        "update grogoni_daemon_tasks set updated_at=now()-interval '40 days' where id=$1",
        [item.id]
      );
      expect(await roleStore.purge(86_400_000, 10)).toBe(1);
      await expect(rolePool.query("select * from unrelated_secrets")).rejects.toMatchObject({
        code: "42501"
      });
      await expect(rolePool.query("drop table grogoni_daemon_tasks")).rejects.toMatchObject({
        code: "42501"
      });
    } finally {
      await rolePool.end();
      await pool.query("drop table if exists unrelated_secrets");
      await admin.query(`drop owned by ${role}`);
      await admin.query(`drop role ${role}`);
    }
  });
  it("runs the native process: retention, graceful SIGTERM, restart persistence", async () => {
    const socket = createServer();
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const port = (socket.address() as { port: number }).port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    const connection = new URL(url!);
    connection.searchParams.set("options", `-c search_path=${schema}`);
    const token = randomUUID();
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const base = `http://127.0.0.1:${port}`;
    let child: ChildProcess | undefined;
    // Stands in for the API's /internal/jobs endpoint; answers after `jobDelayMs` (or never).
    let jobDelayMs: number | null = 1500;
    let jobRequests = 0;
    const jobApi = createHttpServer((request, response) => {
      jobRequests += 1;
      request.resume();
      if (jobDelayMs === null) return;
      setTimeout(() => response.end(JSON.stringify({ status: "completed" })), jobDelayMs);
    });
    jobApi.listen(0, "127.0.0.1");
    await once(jobApi, "listening");
    const jobApiUrl = `http://127.0.0.1:${(jobApi.address() as { port: number }).port}`;
    const start = async (extra: Record<string, string> = {}) => {
      child = spawn(process.execPath, ["--import", "tsx", "services/api/src/daemon/index.ts"], {
        cwd: process.cwd(),
        stdio: "pipe",
        env: {
          ...process.env,
          DAEMON_DATABASE_URL: connection.toString(),
          DAEMON_PORT: String(port),
          DAEMON_HOST: "127.0.0.1",
          DAEMON_SERVICE_TOKEN: token,
          // Never called: agent tasks in this test are scheduled a day ahead.
          OPENROUTER_API_KEY: "test-key-not-used",
          GROGONI_API_URL: jobApiUrl,
          BACKGROUND_JOB_TOKEN: "job-test",
          DAEMON_ALLOW_LOCAL_API: "true",
          ...extra
        }
      });
      child.stdout?.resume();
      child.stderr?.resume();
      for (let attempt = 0; attempt < 150; attempt++) {
        if (child.exitCode !== null) throw new Error("Daemon exited before readiness.");
        try {
          if (
            (await fetch(`${base}/health/ready`, { headers, signal: AbortSignal.timeout(1000) })).ok
          )
            return;
        } catch {
          /* Startup includes module loading and database connection. */
        }
        await delay(100);
      }
      throw new Error("Daemon readiness timed out.");
    };
    const stop = async () => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const guard = setTimeout(() => child?.kill("SIGKILL"), 10_000);
      try {
        expect((await exited)[0]).toBe(0);
      } finally {
        clearTimeout(guard);
        child = undefined;
      }
    };
    const submitJob = async (key: string) => {
      const response = await fetch(`${base}/v1/tasks`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          key,
          maxAttempts: 1,
          payload: { kind: "maintenance", job: "connected_mailbox_sync" }
        })
      });
      return ((await response.json()) as { id: string }).id;
    };
    const waitFor = async (check: () => Promise<boolean> | boolean) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await check()) return;
        await delay(50);
      }
      throw new Error("Condition not reached.");
    };
    try {
      // An expired dead letter is purged by the startup retention pass.
      const expired = await enqueue("expired-dead-letter");
      await pool.query(
        "update grogoni_daemon_tasks set status='failed',updated_at=now()-interval '40 days' where id=$1",
        [expired.id]
      );
      await start({ DAEMON_RETENTION_DAYS: "30" });
      await waitFor(async () => (await store.get(expired.id)) === null);
      expect(
        (await (await fetch(`${base}/v1/stats`, { headers })).json()) as { counts: object }
      ).toMatchObject({ counts: { failed: 0 } });

      // SIGTERM mid-request: the grace period lets the job finish and settle exactly once.
      const graceful = await submitJob("graceful-shutdown");
      await waitFor(() => jobRequests === 1);
      await stop();
      expect(await store.get(graceful)).toMatchObject({
        status: "completed",
        executions: "1",
        result: { status: "completed" }
      });
      await start({ DAEMON_RETENTION_DAYS: "0" });
      const projected = await (await fetch(`${base}/v1/tasks/${graceful}`, { headers })).text();
      expect(JSON.parse(projected)).toMatchObject({ status: "completed", executions: 1 });
      expect(projected).not.toMatch(/lease_token|leaseToken/u);
      await stop();

      // With no grace, work that cannot finish is released, not failed or lost.
      jobDelayMs = null;
      await start({ DAEMON_SHUTDOWN_GRACE_MS: "0" });
      const interrupted = await submitJob("interrupted-shutdown");
      await waitFor(() => jobRequests === 2);
      await stop();
      expect(await store.get(interrupted)).toMatchObject({ status: "queued", attempts: 0 });
      await store.cancel(interrupted);
      jobDelayMs = 1500;

      // A stale retired-engine setting must not brick startup; it maps to Grogoni like the API.
      await start({ PLATFORM_DEFAULT_AGENT_ADAPTER_ID: "zeroclaw" });
      const response = await fetch(`${base}/v1/tasks`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          key: "restart-check",
          runAt: new Date(Date.now() + 86_400_000).toISOString(),
          payload: { kind: "agent", message: "hello" }
        })
      });
      expect(response.status).toBe(202);
      const created = (await response.json()) as {
        id: string;
        payload: { agentAdapterId: string };
      };
      expect(created.payload.agentAdapterId).toBe("grogoni");
      await stop();
      await start();
      const persisted = await fetch(`${base}/v1/tasks/${created.id}`, { headers });
      expect(await persisted.json()).toMatchObject({ id: created.id, status: "queued" });
      expect(
        (
          await fetch(`${base}/v1/tasks/${created.id}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${token}` }
          })
        ).ok
      ).toBe(true);
    } finally {
      await stop();
      jobApi.closeAllConnections();
      await new Promise<void>((resolve) => jobApi.close(() => resolve()));
    }
  }, 60_000);
});
