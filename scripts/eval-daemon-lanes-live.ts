/**
 * Live end-to-end eval for the daemon lanes (docs/deployment/daemon-lanes.md). Paid: a handful of
 * small model calls. Drives the browser lane's real code (apps/web/src/daemon-lane.ts) against a
 * deployed Edge API with two disposable accounts, then checks the server lane's takeover, the
 * operator gateway, the wake hint, and that an idle queue wakes nothing. Every fixture it creates
 * (accounts, sessions, tasks) is deleted at the end, pass or fail.
 *
 *   EVAL_TARGET=local       the Deno stand-in on localhost:8000 (see the doc's "Local run");
 *                           the wake is simulated by calling grogoni_daemon_wake() and then the
 *                           job route, exactly what pg_net does in Supabase. Takeover is
 *                           fast-forwarded by back-dating the abandoned lease.
 *   EVAL_TARGET=production  the live API and the real Supabase Cron. Nothing is fast-forwarded:
 *                           the takeover case waits out the real 10-minute delay (~12 minutes).
 *   EVAL_REQUEST_ONLY=true  with EVAL_API_URL=<.../api-candidate>: the request-level checks only
 *                           (the cron only ever calls the api slug), about a minute.
 *
 *   pnpm eval:daemon-lanes:local
 *   pnpm eval:daemon-lanes:production
 *
 * Evidence: /tmp/daemon-lanes/live-eval/<target>/report.json. Exit code 1 on any hard failure
 * or when graded model replies fall below EVAL_PASS_THRESHOLD (default 0.66).
 */
import { createRequire } from "node:module";
import { randomInt, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type {
  DaemonClaim,
  DaemonUserTaskResult,
  PublicDaemonTask
} from "../packages/shared-types/src/daemon-lanes";
import type { Client as PgClient } from "../services/api/node_modules/pg";
import { runNextBrowserTask, type DaemonLaneRequest } from "../apps/web/src/daemon-lane";
import { deleteLiveFixtureAccounts } from "./live-fixture-cleanup.mjs";
import { edgeLocal } from "./edge-local-config.mjs";

const requireApi = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Client } = requireApi("pg") as { Client: typeof PgClient };

/** Response bodies as this eval reads them: the routes' contracts. */
interface Body {
  code?: string;
  account: { id: string };
  task: PublicDaemonTask;
  tasks: PublicDaemonTask[];
  claim: DaemonClaim | null;
  /** The operator gateway answers with a task at the top level. */
  id: string;
  status: string;
  lane: string | null;
  errorCode: string | null;
  result: { completion?: { outputText?: string }; purged?: number } | null;
}
interface HintRow {
  next_due_at: string | null;
  last_wake_at: string | null;
  version: string;
}
const userResult = (task: PublicDaemonTask | undefined) =>
  task?.result as Partial<DaemonUserTaskResult> | null | undefined;

type Target = "local" | "production";
const target = (process.env.EVAL_TARGET ?? "") as Target;
if (target !== "local" && target !== "production")
  throw new Error("Set EVAL_TARGET to local or production.");
const projectRef = "gnmndzsughifhboqvsgd";
const base =
  process.env.EVAL_API_URL ??
  (target === "local" ? edgeLocal.apiUrl : `https://${projectRef}.supabase.co/functions/v1/api`);
const queueUrl =
  target === "local"
    ? edgeLocal.queueUrl
    : (process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL ?? "");
const localHintUrl = edgeLocal.hintUrl;
const serviceToken =
  target === "local" ? edgeLocal.daemonServiceToken : (process.env.DAEMON_SERVICE_TOKEN ?? "");
const jobToken = target === "local" ? edgeLocal.backgroundJobToken : "";
if (!queueUrl) throw new Error("DATABASE_URL is required to clean up fixtures.");
if (serviceToken.length < 32) throw new Error("DAEMON_SERVICE_TOKEN is required.");
if (target === "local" && jobToken.length < 16)
  throw new Error("BACKGROUND_JOB_TOKEN is required for the local wake simulation.");
if (target === "production" && !process.env.SUPABASE_ACCESS_TOKEN)
  throw new Error("SUPABASE_ACCESS_TOKEN is required to read the wake hint and cron runs.");
const threshold = Number(process.env.EVAL_PASS_THRESHOLD ?? "0.66");
/** EVAL_REQUEST_ONLY=true: routes only, for an api-candidate deploy the cron does not call. */
const requestOnly = process.env.EVAL_REQUEST_ONLY === "true";
const runId = randomUUID().slice(0, 8);
const device = `daemon-lanes-eval-${randomUUID()}`;
const evidenceDir = `/tmp/daemon-lanes/live-eval/${target}${requestOnly ? "-request-only" : ""}`;
const started = Date.now();

interface Step {
  name: string;
  ok: boolean;
  ms: number;
  detail?: unknown;
}
const steps: Step[] = [];
const graded: { name: string; ok: boolean; reply: string; why: string | null }[] = [];
const accountIds = new Set<string>();
const operatorKeys: string[] = [];

function log(message: string) {
  const line = `[${new Date().toISOString()}] daemon-lanes eval (${target}): ${message}`;
  console.log(line);
}
async function step<T>(name: string, action: () => Promise<T>): Promise<T> {
  const at = Date.now();
  try {
    const value = await action();
    steps.push({ name, ok: true, ms: Date.now() - at, detail: value });
    log(`PASS ${name}`);
    return value;
  } catch (error) {
    steps.push({
      name,
      ok: false,
      ms: Date.now() - at,
      detail: error instanceof Error ? error.message : String(error)
    });
    log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * fetch, retried on network failures (no response at all) for reads only: a write that failed
 * this way may still have reached the server, and repeating a claim or an execute would not be
 * the same request. HTTP errors are never retried; they are results.
 */
async function fetchRead(url: string, init: RequestInit, read: boolean): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (!read || attempt >= 4) throw error;
      log(`network error on a read (attempt ${attempt}), retrying: ${String(error)}`);
      await delay(2_000 * attempt);
    }
  }
}

async function call(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string; bearer?: string } = {}
) {
  const method = init.method ?? "GET";
  const response = await fetchRead(
    base + path,
    {
      method,
      headers: {
        ...(target === "production" ? { origin: "https://grogoni.com" } : {}),
        "content-type": "application/json",
        "x-grogoni-device-id": device,
        ...(init.cookie ? { cookie: init.cookie } : {}),
        ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {})
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(120_000)
    },
    method === "GET"
  );
  const text = await response.text();
  let json = null as unknown as Body;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { status: response.status, json, cookies: response.headers.getSetCookie() };
}
/** What a signed-in browser's fetch does for the lane: non-2xx becomes an error with status. */
const browser =
  (cookie: string): DaemonLaneRequest =>
  async <T>(path: string, init?: { method?: string; body?: unknown }) => {
    const result = await call(path, { ...init, cookie });
    if (result.status < 200 || result.status >= 300)
      throw Object.assign(new Error(`${path} -> ${result.status} ${result.json?.code ?? ""}`), {
        status: result.status
      });
    return result.json as T;
  };

async function signUp(): Promise<{ cookie: string; accountId: string }> {
  const contact = `+442079460${String(randomInt(1000)).padStart(3, "0")}`;
  const response = await call("/auth/pin/signup", {
    method: "POST",
    body: { method: "phone", contact, pin: String(randomInt(1000, 9999)) }
  });
  check(
    response.status === 200,
    `signup HTTP ${response.status}: ${JSON.stringify(response.json)}`
  );
  accountIds.add(response.json.account.id);
  return {
    cookie: response.cookies.map((value) => value.split(";")[0]).join("; "),
    accountId: response.json.account.id
  };
}
async function createTask(cookie: string, key: string, message: string) {
  const response = await call("/v1/daemon/tasks", {
    method: "POST",
    cookie,
    body: { key: `${runId}-${key}`, message }
  });
  check(
    response.status === 201,
    `create HTTP ${response.status}: ${JSON.stringify(response.json)}`
  );
  return response.json.task as PublicDaemonTask;
}
async function getTask(cookie: string, id: string) {
  const response = await call(`/v1/daemon/tasks/${id}`, { cookie });
  return { status: response.status, task: response.json?.task as PublicDaemonTask | undefined };
}
async function waitForTask(cookie: string, id: string, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  let lastReport = 0;
  for (;;) {
    const { task } = await getTask(cookie, id);
    if (task && ["completed", "failed", "cancelled"].includes(task.status)) return task;
    if (Date.now() > deadline)
      throw new Error(`${label}: still ${task?.status} after ${timeoutMs} ms`);
    if (Date.now() - lastReport > 60_000) {
      lastReport = Date.now();
      log(
        `${label}: waiting, status ${task?.status}, ${Math.round((deadline - Date.now()) / 1000)}s left`
      );
    }
    await delay(target === "local" ? 500 : 10_000);
  }
}
function grade(name: string, reply: string, test: (reply: string) => string | null) {
  const why = test(reply);
  graded.push({ name, ok: why === null, reply: reply.slice(0, 400), why });
  log(`${why === null ? "GOOD" : "WEAK"} model reply for ${name}${why ? `: ${why}` : ""}`);
}
const tokenCheck = (reply: string) => (reply.includes("KIONDO-7731") ? null : "token missing");
const swahiliCheck = (reply: string) =>
  /\b(karibu|habari|jambo|asante|hujambo|mteja|duka)\b/iu.test(reply) ? null : "no Swahili marker";
const sumCheck = (reply: string) => (/1[,\s]?350/u.test(reply) ? null : "expected 1350");

/** The wake hint and recent cron activity, read where Supabase Cron reads them. */
async function supabaseSql<Row = Record<string, string | number | null>>(
  query: string
): Promise<Row[]> {
  if (target === "local") {
    const client = new Client({ connectionString: localHintUrl });
    await client.connect();
    try {
      return (await client.query(query)).rows as Row[];
    } finally {
      await client.end();
    }
  }
  // Production only ever sends selects here, so a network failure is safe to retry.
  const response = await fetchRead(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(60_000)
    },
    true
  );
  check(response.ok, `Supabase query HTTP ${response.status}`);
  return (await response.json()) as Row[];
}
const hintRow = async () =>
  (
    await supabaseSql<HintRow>(
      "select next_due_at, last_wake_at, version from grogoni_internal.daemon_wake"
    )
  )[0];
/** Local only: one cron tick, exactly as Supabase runs it (wake check, then the job call). */
async function localTick() {
  const before = Number((await supabaseSql("select count(*) as n from wake_calls"))[0].n);
  await supabaseSql("select public.grogoni_daemon_wake()");
  const after = Number((await supabaseSql("select count(*) as n from wake_calls"))[0].n);
  if (after > before) {
    const run = await fetch(`${base}/internal/jobs/daemon_worker/run`, {
      method: "POST",
      headers: { "x-job-token": jobToken, "content-type": "application/json" },
      body: "{}"
    });
    return { woke: true, run: await run.json() };
  }
  return { woke: false };
}
async function withQueue<T>(action: (client: InstanceType<typeof Client>) => Promise<T>) {
  const client = new Client({ connectionString: queueUrl, connectionTimeoutMillis: 15_000 });
  await client.connect();
  try {
    return await action(client);
  } finally {
    await client.end();
  }
}

let failure: unknown = null;
try {
  log(`run ${runId} against ${base}`);
  await step("api is ready", async () => {
    const ready = await call("/health/ready");
    check(ready.status === 200, `ready HTTP ${ready.status}`);
    return ready.json;
  });
  // Session cookies stay in memory: the report records only account IDs.
  const amina = await signUp();
  await step("sign up disposable user A", async () => ({ accountId: amina.accountId }));
  const baraka = await signUp();
  await step("sign up disposable user B", async () => ({ accountId: baraka.accountId }));

  await step("browser lane runs a task on the device model", async () => {
    const created = await createTask(amina.cookie, "device", "Say hello to the shop owner.");
    const ran = await runNextBrowserTask({
      request: browser(amina.cookie),
      // Node has no WebGPU: a deterministic stand-in plays the installed model.
      device: () => ({
        modelId: "eval-device-stub",
        generate: async (m) => `device reply to: ${m}`
      })
    });
    check(ran.ran, `lane returned ${JSON.stringify(ran)}`);
    const { task } = await getTask(amina.cookie, created.id);
    check(task?.status === "completed", `status ${task?.status}`);
    check(task.lane === "browser", `lane ${task.lane}`);
    check(userResult(task)?.executedBy === "device", "not executed on device");
    return { id: task.id, lane: task.lane, result: task.result };
  });

  await step("browser lane without a device model has the server run its claim", async () => {
    const created = await createTask(
      amina.cookie,
      "server",
      "Include the exact token KIONDO-7731 in your reply. Do not call tools."
    );
    const ran = await runNextBrowserTask({
      request: browser(amina.cookie),
      device: () => null
    });
    check(ran.ran, `lane returned ${JSON.stringify(ran)}`);
    const { task } = await getTask(amina.cookie, created.id);
    check(task?.status === "completed", `status ${task?.status} ${task?.errorCode ?? ""}`);
    check(userResult(task)?.executedBy === "server", "not executed on the server");
    grade("server execute", String(userResult(task)?.text ?? ""), tokenCheck);
    return { id: task.id, lane: task.lane, result: task.result };
  });

  await step("another user can neither see nor run the task", async () => {
    const created = await createTask(amina.cookie, "private", "Amina's private request.");
    const peek = await getTask(baraka.cookie, created.id);
    check(peek.status === 404, `B read A's task: HTTP ${peek.status}`);
    const list = await call("/v1/daemon/tasks", { cookie: baraka.cookie });
    check(!JSON.stringify(list.json).includes(created.id), "A's task appeared in B's list");
    const ran = await runNextBrowserTask({
      request: browser(baraka.cookie),
      device: () => ({ modelId: "m", generate: async () => "stolen" })
    });
    check(!ran.ran, `B's lane ran A's task: ${JSON.stringify(ran)}`);
    const cancel = await call(`/v1/daemon/tasks/${created.id}`, {
      method: "DELETE",
      cookie: baraka.cookie
    });
    check(cancel.status === 404, `B cancel HTTP ${cancel.status}`);
    // Tidy: A cancels its own, so it never runs.
    const own = await call(`/v1/daemon/tasks/${created.id}`, {
      method: "DELETE",
      cookie: amina.cookie
    });
    check(own.status === 200, `A cancel HTTP ${own.status}`);
    return { id: created.id };
  });

  await step("an unauthenticated caller gets 401 and no data", async () => {
    const anonymous = await call("/v1/daemon/tasks");
    check(anonymous.status === 401, `HTTP ${anonymous.status}`);
    const operator = await call("/internal/daemon/v1/stats", { bearer: "x".repeat(40) });
    check(operator.status === 401, `operator with a wrong token: HTTP ${operator.status}`);
    return { user: anonymous.status, operator: operator.status };
  });

  const operatorTask = await step(
    "operator submits an agent task through the gateway",
    async () => {
      const key = `eval-daemon-lanes-${runId}-operator`;
      operatorKeys.push(key);
      const before = await hintRow();
      const submitted = await call("/internal/daemon/v1/tasks", {
        method: "POST",
        bearer: serviceToken,
        body: {
          key,
          payload: {
            kind: "agent",
            message:
              "A basket costs 450 shillings. What do 3 baskets cost? Give the number. No tools."
          }
        }
      });
      check(
        submitted.status === 202,
        `HTTP ${submitted.status}: ${JSON.stringify(submitted.json)}`
      );
      const hint = await hintRow();
      // The submit itself lowered the hint (a new version) to now: operator work has no delay.
      check(
        Number(hint?.version) > Number(before?.version),
        `hint not lowered: ${JSON.stringify({ before, hint })}`
      );
      check(
        new Date(hint.next_due_at).getTime() <= Date.now() + 5_000,
        `hint not due: ${JSON.stringify(hint)}`
      );
      return { id: submitted.json.id as string, before, hint };
    }
  );

  if (requestOnly) {
    // A candidate deploy shares the cron with production (it targets the api slug), so the
    // wake, takeover and idle checks cannot be about this deploy: cancel and stop here.
    await step("operator cancels its task", async () => {
      const cancelled = await call(`/internal/daemon/v1/tasks/${operatorTask.id}`, {
        method: "DELETE",
        bearer: serviceToken
      });
      check(cancelled.status === 200, `HTTP ${cancelled.status}`);
      return cancelled.json;
    });
  } else {
    await step("the wake runs operator work within one cron tick", async () => {
      const at = Date.now();
      if (target === "local") {
        const tick = await localTick();
        check(tick.woke, "the wake check did not fire for due work");
      }
      const deadline = Date.now() + (target === "local" ? 30_000 : 4 * 60_000);
      let task: Body | undefined;
      for (;;) {
        task = (
          await call(`/internal/daemon/v1/tasks/${operatorTask.id}`, { bearer: serviceToken })
        ).json;
        if (["completed", "failed"].includes(task?.status ?? "") || Date.now() > deadline) break;
        await delay(target === "local" ? 500 : 5_000);
      }
      check(task?.status === "completed", `status ${task?.status} ${task?.errorCode ?? ""}`);
      check(task.lane === "server", `lane ${task.lane}`);
      const output = String(task.result?.completion?.outputText ?? "");
      let reply = output;
      try {
        reply = String((JSON.parse(output) as { message?: unknown }).message ?? "");
      } catch {
        // Not the JSON contract: grade the raw output.
      }
      grade("operator agent task", reply, sumCheck);
      return { id: task.id, secondsToComplete: Math.round((Date.now() - at) / 1000) };
    });

    await step("a browser that vanishes mid-task is taken over by the server", async () => {
      const created = await createTask(
        amina.cookie,
        "takeover",
        "Reply only in Swahili with a one-sentence welcome to a customer. Do not call tools."
      );
      // The tab claims it and closes without settling.
      const claim = await call("/v1/daemon/claims", {
        method: "POST",
        cookie: amina.cookie,
        body: {}
      });
      check(claim.json?.claim?.task?.id === created.id, "the vanishing tab did not get the claim");
      const abandonedAt = Date.now();
      if (target === "local") {
        // Fast-forward: the lease ended 10 minutes ago, and the hint says so.
        await withQueue((client) =>
          client.query(
            "update grogoni_daemon_tasks set lease_until=now()-interval '10 minutes 1 second' where id=$1",
            [created.id]
          )
        );
        await supabaseSql(
          "update grogoni_internal.daemon_wake set next_due_at=now()-interval '1 second', last_wake_at=null"
        );
        const tick = await localTick();
        check(tick.woke, "the wake check did not fire");
      } else {
        log("takeover: waiting out the real takeover delay (about 12 minutes)");
      }
      const task = await waitForTask(
        amina.cookie,
        created.id,
        target === "local" ? 60_000 : 16 * 60_000,
        "takeover"
      );
      check(task.status === "completed", `status ${task.status} ${task.errorCode ?? ""}`);
      check(task.lane === "server", `lane ${task.lane}`);
      const completedAfterSeconds = Math.round((Date.parse(task.updatedAt) - abandonedAt) / 1000);
      if (target === "production")
        check(
          completedAfterSeconds >= 600,
          `taken over after ${completedAfterSeconds}s, before the 10-minute delay`
        );
      grade("takeover", String(userResult(task)?.text ?? ""), swahiliCheck);
      return { id: task.id, lane: task.lane, attempts: task.attempts, completedAfterSeconds };
    });

    await step("an idle queue wakes nothing", async () => {
      const before = await hintRow();
      const since = new Date().toISOString();
      if (target === "local") {
        await supabaseSql("update grogoni_internal.daemon_wake set last_wake_at=null");
        const ticks = [await localTick(), await localTick()];
        check(
          ticks.every((tick) => !tick.woke),
          `woke with nothing due: ${JSON.stringify(before)}`
        );
        return { hint: before, ticks };
      }
      await delay(150_000);
      const after = await hintRow();
      const runs = await supabaseSql(
        `select d.status, d.start_time from cron.job_run_details d join cron.job j on j.jobid = d.jobid
         where j.jobname = 'grogoni-daemon-wake' and d.start_time > '${since}' order by d.start_time`
      );
      check(runs.length >= 2, `the wake check ran ${runs.length} times in 150s`);
      check(
        String(after.last_wake_at) === String(before.last_wake_at),
        `the worker was woken while idle: ${JSON.stringify({ before, after })}`
      );
      return { before, after, wakeChecks: runs.length };
    });
  }
} catch (error) {
  failure = error;
} finally {
  await step("remove every fixture", async () => {
    await withQueue(async (client) => {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('grogoni.cp2.normalized_store'))");
      await deleteLiveFixtureAccounts(client, { accountIds: [...accountIds] });
      const operator = await client.query(
        "delete from grogoni_daemon_tasks where idempotency_key = any($1::text[])",
        [operatorKeys]
      );
      await client.query("commit");
      return { accounts: accountIds.size, operatorTasks: operator.rowCount };
    });
    const left = await withQueue((client) =>
      client.query("select count(*)::int as n from accounts where id = any($1::uuid[])", [
        [...accountIds]
      ])
    );
    check(left.rows[0].n === 0, `${left.rows[0].n} fixture accounts remain`);
    return { removedAccounts: accountIds.size };
  }).catch((error) => {
    failure ??= error;
  });
  const score = graded.length === 0 ? 0 : graded.filter((item) => item.ok).length / graded.length;
  const report = {
    target,
    base,
    requestOnly,
    runId,
    startedAt: new Date(started).toISOString(),
    durationSeconds: Math.round((Date.now() - started) / 1000),
    passed: failure === null && steps.every((item) => item.ok) && score >= threshold,
    modelScore: score,
    threshold,
    steps,
    graded
  };
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(`${evidenceDir}/report.json`, JSON.stringify(report, null, 2));
  log(
    `${report.passed ? "PASSED" : "FAILED"}: ${steps.filter((item) => item.ok).length}/${steps.length} steps, model score ${score.toFixed(2)} (threshold ${threshold}). Evidence: ${evidenceDir}/report.json`
  );
  if (!report.passed) process.exitCode = 1;
}
