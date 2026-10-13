import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "../services/api/node_modules/pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createEdgeDaemon,
  DaemonHttpError,
  type EdgeDaemon
} from "../services/api/src/daemon/edge-lane";
import { daemonQueueMigrations } from "../services/api/src/daemon/task-store";
import { runNextBrowserTask, type DaemonLaneRequest } from "../apps/web/src/daemon-lane";

/**
 * The browser lane's real code against the Edge API's real daemon routes and a real PostgreSQL
 * queue: the contract both sides share, exercised end to end without a network.
 */
const url = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
describe.skipIf(!url)("daemon lanes end to end", () => {
  const schema = `daemon_e2e_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: url ?? "" });
  const pool = new pg.Pool({ connectionString: url ?? "", options: `-c search_path=${schema}` });
  const serverRuns: string[] = [];
  let daemon: EdgeDaemon;
  /** What a signed-in browser's fetch does: cookie in, JSON out, non-2xx thrown with status. */
  const browserOf =
    (session: string): DaemonLaneRequest =>
    async <T>(path: string, init?: { method?: string; body?: unknown }) => {
      const response = await daemon.routes(
        new Request(`https://edge.test${path}`, {
          method: init?.method ?? "GET",
          headers: { cookie: session, "content-type": "application/json" },
          ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) })
        }),
        path
      );
      if (response === null) throw Object.assign(new Error("not routed"), { status: 404 });
      const body = await response.json();
      if (!response.ok) throw Object.assign(new Error(body.code), { status: response.status });
      return body as T;
    };
  const createTask = async (session: string, key: string, message: string) =>
    (
      await browserOf(session)<{ task: { id: string } }>("/v1/daemon/tasks", {
        method: "POST",
        body: { key, message }
      })
    ).task.id;

  beforeAll(async () => {
    await admin.query(`create schema ${schema}`);
    for (const file of daemonQueueMigrations)
      await pool.query(
        await readFile(new URL(`../infra/db/migrations/${file}`, import.meta.url), "utf8")
      );
  });
  beforeEach(async () => {
    serverRuns.length = 0;
    await pool.query("truncate grogoni_daemon_tasks");
    daemon = createEdgeDaemon({
      queue: pool,
      hint: null,
      authenticate: async (request) => {
        const userId = { "s-amina": "amina", "s-baraka": "baraka" }[
          request.headers.get("cookie") ?? ""
        ];
        if (!userId) throw new DaemonHttpError(401, "auth_required", "Authentication is required.");
        return { userId };
      },
      environment: { OPENROUTER_API_KEY: "test", PLATFORM_DEFAULT_MODEL_ID: "gpt-6-luna" },
      execute: async (task) => {
        if (task.payload.kind !== "agent") throw new Error("unexpected maintenance task");
        serverRuns.push(task.payload.message);
        return {
          completion: {
            status: "available",
            outputText: JSON.stringify({ message: `server: ${task.payload.message}` })
          }
        };
      }
    });
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  });

  it("an open browser with a device model runs its user's task on the device", async () => {
    const id = await createTask("s-amina", "stock", "Which items are low on stock?");
    expect(
      await runNextBrowserTask({
        request: browserOf("s-amina"),
        device: () => ({ modelId: "Qwen-MLC", generate: async (m) => `device: ${m}` })
      })
    ).toEqual({ ran: true });
    expect(await daemon.store.get(id)).toMatchObject({
      status: "completed",
      lane: "browser",
      result: { text: "device: Which items are low on stock?", executedBy: "device" }
    });
    expect(serverRuns).toEqual([]);
  });

  it("an open browser without a device model has the server run its claim", async () => {
    const id = await createTask("s-amina", "greet", "Greet the morning customers");
    await runNextBrowserTask({
      request: browserOf("s-amina"),
      device: () => null
    });
    expect(await daemon.store.get(id)).toMatchObject({
      status: "completed",
      lane: "browser",
      result: { text: "server: Greet the morning customers", executedBy: "server" }
    });
  });

  it("another user's open browser never picks up the task", async () => {
    const id = await createTask("s-amina", "private", "Amina's private prompt");
    expect(
      await runNextBrowserTask({
        request: browserOf("s-baraka"),
        device: () => ({ modelId: "m", generate: async () => "stolen" })
      })
    ).toMatchObject({ ran: false });
    expect((await daemon.store.get(id))?.status).toBe("queued");
  });

  it("a browser that vanishes mid-task leaves it to the server after the takeover delay", async () => {
    const id = await createTask("s-amina", "vanish", "Draft the weekly report");
    // The tab claims the task and is closed before it can settle.
    await browserOf("s-amina")("/v1/daemon/claims", { method: "POST", body: {} });
    await pool.query(
      "update grogoni_daemon_tasks set lease_until=now()-interval '1 second' where id=$1",
      [id]
    );
    // Before the takeover delay the server leaves it for the user's browser.
    expect(await daemon.runWorker()).toMatchObject({ claimed: 0 });
    await pool.query(
      "update grogoni_daemon_tasks set lease_until=now()-interval '10 minutes 1 second' where id=$1",
      [id]
    );
    expect(await daemon.runWorker()).toMatchObject({ claimed: 1, finished: 1 });
    expect(await daemon.store.get(id)).toMatchObject({
      status: "completed",
      lane: "server",
      // One attempt by the vanished browser, one by the server.
      attempts: 2,
      result: { text: "server: Draft the weekly report", executedBy: "server" }
    });
  });
});
