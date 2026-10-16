import { Buffer } from "node:buffer";
import type { DaemonPayload, DaemonUserTaskResult } from "@grogoni/shared-types";
import { integerFromEnv } from "./config.js";
import { createDaemonExecutor, readDaemonCapabilities } from "./executor.js";
import { buildDaemonGateway } from "./gateway.js";
import {
  createPostgresDaemonTaskStore,
  defaultUserTakeoverMs,
  toPublicDaemonTask,
  type DaemonPool,
  type DaemonTask,
  type DaemonTaskStore
} from "./task-store.js";
import {
  DaemonTaskError,
  runDaemonWorker,
  settleStorably,
  type DaemonEvent,
  type DaemonExecutor
} from "./worker.js";
import type { DaemonWakeHint } from "./wake-hint.js";

/**
 * The daemon inside the existing API, with no host of its own (docs/deployment/daemon-lanes.md).
 *
 * Browser lane: a signed-in user's open app claims that user's due tasks over /v1/daemon/claims,
 * runs them on an on-device model or asks the server to run them (/execute), and settles them.
 * The only credential it ever holds is the claim's lease token: one task, one user, until the
 * lease ends. No API key or job token reaches a browser.
 *
 * Server lane: runWorker(), called by the daemon_worker Edge job (Supabase Cron), runs operator
 * tasks as soon as they are due and a user's task once it has waited past the takeover delay.
 * Model calls never run inside a domain request transaction or hold account or store locks.
 *
 * Operators: /internal/daemon/* serves the native daemon's own gateway (gateway.ts) behind
 * DAEMON_SERVICE_TOKEN, so submitting, listing, cancelling and retrying work the same everywhere.
 */

export interface EdgeDaemonConfig {
  takeoverMs: number;
  runBudgetMs: number;
  taskTimeoutMs: number;
  browserLeaseMs: number;
  maxActivePerUser: number;
  minUserIntervalMs: number;
  modelId: string | null;
}

export function readEdgeDaemonConfig(environment: NodeJS.ProcessEnv): EdgeDaemonConfig {
  // At most 140s: Supabase Cron's pg_net call waits 150s, and so does a request to the function.
  const runBudgetMs = integerFromEnv(
    "DAEMON_EDGE_RUN_BUDGET_MS",
    // Default 120s: the run's clock starts after cold start and the job lock, and settling,
    // the hint write and the commit come after it, all inside the same 150s.
    120_000,
    10_000,
    140_000,
    environment
  );
  return {
    takeoverMs: integerFromEnv(
      "DAEMON_USER_TAKEOVER_MS",
      defaultUserTakeoverMs,
      60_000,
      86_400_000,
      environment
    ),
    runBudgetMs,
    // A task must fit inside one run with room left to settle it, and a browser's /execute call
    // (the timeout plus a margin) inside Supabase's 150-second request limit.
    taskTimeoutMs: integerFromEnv(
      "DAEMON_EDGE_TASK_TIMEOUT_MS",
      60_000,
      5_000,
      Math.min(runBudgetMs - 5_000, maxTaskTimeoutMs),
      environment
    ),
    browserLeaseMs: integerFromEnv("DAEMON_BROWSER_LEASE_MS", 60_000, 15_000, 300_000, environment),
    maxActivePerUser: integerFromEnv("DAEMON_USER_MAX_ACTIVE", 20, 1, 1_000, environment),
    minUserIntervalMs: integerFromEnv(
      "DAEMON_USER_MIN_INTERVAL_MS",
      900_000,
      60_000,
      30 * 86_400_000,
      environment
    ),
    modelId: environment.PLATFORM_DEFAULT_MODEL_ID?.trim() || null
  };
}

/**
 * Every route this lane serves on the Edge API (index.ts sends /v1/daemon/* and /internal/daemon/*
 * here). scripts/check-api-route-coverage.ts reads it; edge-lane.test.ts proves the handler serves
 * exactly these.
 */
export const daemonLaneRoutes: ReadonlyArray<{ method: string; path: string }> = [
  { method: "GET", path: "/v1/daemon/tasks" },
  { method: "POST", path: "/v1/daemon/tasks" },
  { method: "GET", path: "/v1/daemon/tasks/:taskId" },
  { method: "DELETE", path: "/v1/daemon/tasks/:taskId" },
  { method: "POST", path: "/v1/daemon/claims" },
  ...["renew", "settle", "release", "execute"].map((action) => ({
    method: "POST",
    path: `/v1/daemon/claims/:taskId/${action}`
  }))
];

export class DaemonHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

/** One server-lane run, as recorded in the daemon_worker job status. */
export interface EdgeWorkerRun {
  /** ENABLE_DAEMON_WORKER=false: nothing ran and the wake hint was cleared. */
  disabled: boolean;
  claimed: number;
  finished: number;
  failed: number;
  fenced: number;
  leaseExhausted: number;
  nextServerDueAt: string | null;
  hint: "updated" | "superseded" | "unavailable";
  durationMs: number;
}

/** What a user task's result looks like, whichever lane ran it (the shared contract). */
export type UserTaskResult = DaemonUserTaskResult;

export interface EdgeDaemonDependencies {
  /** The queue database (Neon). Each call must commit on its own. */
  queue: DaemonPool;
  /** Null when SUPABASE_DB_URL is unavailable: the hourly sweep is then the only server wake. */
  hint: DaemonWakeHint | null;
  /** Resolves the signed-in user or throws DaemonHttpError(401). */
  authenticate: (request: Request) => Promise<{ userId: string }>;
  environment: NodeJS.ProcessEnv;
  runMaintenance?: (job: string, signal: AbortSignal) => Promise<unknown>;
  /** Tests inject a fake model; production builds the OpenRouter executor. */
  execute?: DaemonExecutor;
  report?: (event: DaemonEvent | { type: string; errorCode?: string }) => void;
}

const userKeyPattern = /^[A-Za-z0-9._:-]{1,120}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const errorCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const maxMessageChars = 8_000;
const maxTaskTimeoutMs = 120_000;
const maxDeviceResultChars = 32_000;
const maxIntervalMs = 30 * 86_400_000;
const maxScheduleAheadMs = 365 * 86_400_000;
/** Settling may land just after a lease ends on a slow network; the database fences it anyway. */
const executeLeaseMarginMs = 30_000;
/** How often /execute re-checks that its claim still stands (cancel, lease lost). */
const executeHeartbeatMs = 5_000;
/** Longest a request waits on the wake-hint write; a slow hint database must not slow users. */
const hintWriteBudgetMs = 3_000;

export function createEdgeDaemon(dependencies: EdgeDaemonDependencies) {
  const environment = dependencies.environment;
  const config = readEdgeDaemonConfig(environment);
  const report = (event: Parameters<NonNullable<EdgeDaemonDependencies["report"]>>[0]) =>
    dependencies.report?.(event);
  const store: DaemonTaskStore = createPostgresDaemonTaskStore(dependencies.queue, {
    userTakeoverMs: config.takeoverMs
  });
  // The native daemon's own rules for what this server can run. A misconfiguration refuses
  // agent work with a clear code instead of failing the whole API at startup.
  let capabilities: ReturnType<typeof readDaemonCapabilities> | null = null;
  if (config.modelId !== null) {
    try {
      capabilities = readDaemonCapabilities(environment, config.modelId, {
        maintenanceInProcess: dependencies.runMaintenance !== undefined
      });
    } catch {
      report({ type: "daemon_capabilities_invalid" });
    }
  }
  const refusal = (payload: DaemonPayload): string | null =>
    // The worker job cannot be queued as maintenance: run in-process it would only find its own
    // lock held and do nothing.
    payload.kind === "maintenance" && payload.job === "daemon_worker"
      ? "JOB_NOT_QUEUEABLE"
      : capabilities !== null
        ? capabilities.refusal(payload)
        : payload.kind === "maintenance" && dependencies.runMaintenance !== undefined
          ? null
          : "AGENT_RUNTIME_NOT_CONFIGURED";
  const serverCanRunAgents = capabilities?.agents === true;
  const baseExecute =
    dependencies.execute ??
    createDaemonExecutor(
      environment,
      dependencies.runMaintenance === undefined
        ? {}
        : { runMaintenance: dependencies.runMaintenance }
    );
  // User tasks store one result shape for both lanes; operator tasks keep the raw agent result.
  const execute: DaemonExecutor = async (task, signal) => {
    const result = await baseExecute(task, signal);
    return task.owner_user_id === null ? result : userResultFromAgent(task, result);
  };
  /** Best effort: a failed hint write is repaired by the hourly sweep. */
  async function lowerHint(at: Date) {
    const hint = dependencies.hint;
    if (hint === null) return;
    // One retry (a busy connection should not cost a task an hour), within a fixed budget: past
    // it the request answers anyway and a write still in flight may land later.
    const write = (async () => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await hint.lower(at);
          return true;
        } catch {
          // Retried once, then left to the hourly sweep.
        }
      }
      return false;
    })();
    const written = await withinBudget(write, hintWriteBudgetMs);
    if (written === "late") {
      // Still in flight: it may land after this request answers, and lowering is always safe.
      report({ type: "wake_hint_slow" });
      void write.then((landed) => {
        if (!landed) report({ type: "wake_hint_unavailable" });
      });
    } else if (!written) report({ type: "wake_hint_unavailable" });
  }
  /** After a task is re-queued, the server may need it at its next run plus the takeover delay. */
  async function lowerHintFor(task: DaemonTask | null) {
    if (task === null || task.status !== "queued") return;
    const due = new Date(task.run_at).getTime();
    await lowerHint(new Date(due + (task.owner_user_id === null ? 0 : config.takeoverMs)));
  }

  async function ownedClaim(userId: string, id: string, body: Record<string, unknown>) {
    const leaseToken = body.leaseToken;
    if (typeof leaseToken !== "string" || !uuidPattern.test(leaseToken))
      throw new DaemonHttpError(400, "lease_token_invalid", "A lease token is required.");
    const task = uuidPattern.test(id) ? await store.getOwned(userId, id) : null;
    if (task === null) throw new DaemonHttpError(404, "task_not_found", "Task was not found.");
    // The same answer for a wrong, stale or settled lease: none of them grant anything.
    if (
      task.status !== "running" ||
      task.lease_token !== leaseToken ||
      task.lease_until === null ||
      new Date(task.lease_until).getTime() <= Date.now()
    )
      throw new DaemonHttpError(409, "lease_lost", "This claim is no longer held.");
    return task;
  }

  async function createTask(userId: string, body: Record<string, unknown>) {
    const key = body.key;
    if (typeof key !== "string" || !userKeyPattern.test(key))
      throw new DaemonHttpError(
        400,
        "task_key_invalid",
        "key must be 1-120 letters, digits, '.', '_', ':' or '-'."
      );
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (message === "" || message.length > maxMessageChars || !storableText(message))
      throw new DaemonHttpError(
        400,
        "task_message_invalid",
        `message must be 1-${maxMessageChars} characters.`
      );
    let intervalMs: number | undefined;
    if (body.intervalMs !== undefined && body.intervalMs !== null) {
      if (
        typeof body.intervalMs !== "number" ||
        !Number.isSafeInteger(body.intervalMs) ||
        body.intervalMs < config.minUserIntervalMs ||
        body.intervalMs > maxIntervalMs
      )
        throw new DaemonHttpError(
          400,
          "task_interval_invalid",
          `intervalMs must be an integer from ${config.minUserIntervalMs} to ${maxIntervalMs}.`
        );
      intervalMs = body.intervalMs;
    }
    const now = Date.now();
    let runAt = new Date(now);
    if (body.runAt !== undefined && body.runAt !== null) {
      const parsed = typeof body.runAt === "string" ? Date.parse(body.runAt) : Number.NaN;
      if (!Number.isFinite(parsed) || parsed > now + maxScheduleAheadMs)
        throw new DaemonHttpError(
          400,
          "task_run_at_invalid",
          "runAt must be an ISO time within a year."
        );
      runAt = new Date(Math.max(now, parsed));
    }
    if (config.modelId === null)
      throw new DaemonHttpError(
        503,
        "daemon_server_lane_unavailable",
        "Background tasks are not available right now."
      );
    // Every user task must be runnable by the server: it is the lane of last resort.
    const payload: DaemonPayload = {
      kind: "agent",
      message,
      modelId: config.modelId,
      agentAdapterId: "grogoni"
    };
    const refused = refusal(payload);
    if (refused === "MESSAGE_TOO_LARGE")
      throw new DaemonHttpError(400, "task_message_invalid", "message is too large.");
    if (refused !== null)
      throw new DaemonHttpError(
        503,
        "daemon_server_lane_unavailable",
        "Background tasks are not available right now."
      );
    // Keys are unique across the whole queue; the owner prefix keeps users from colliding with,
    // or reading, each other's tasks through a shared key.
    const namespacedKey = `user:${userId}:${key}`;
    const added = await store.enqueueOwned(
      {
        key: namespacedKey,
        payload,
        runAt,
        ...(intervalMs === undefined ? {} : { intervalMs }),
        maxAttempts: 3,
        ownerUserId: userId
      },
      config.maxActivePerUser
    );
    if ("limited" in added)
      throw new DaemonHttpError(
        429,
        "daemon_task_limit",
        `At most ${config.maxActivePerUser} tasks can be queued or running at once.`
      );
    const { created, task } = added;
    if (task.owner_user_id !== userId)
      throw new DaemonHttpError(409, "task_key_conflict", "That key is already in use.");
    if (created) await lowerHintFor(task);
    report({ type: created ? "user_task_created" : "user_task_replayed", taskId: task.id });
    return { created, task };
  }

  async function executeOnServer(userId: string, id: string, body: Record<string, unknown>) {
    const held = await ownedClaim(userId, id, body);
    // Swap the token before the model call: of concurrent /execute calls (or an /execute racing
    // the device's /settle) exactly one wins and pays for a run. The new lease covers the whole
    // call; the heartbeat below only checks that the claim still stands.
    const claimed = await store.rotateLease(held, config.taskTimeoutMs + executeLeaseMarginMs);
    if (claimed === null)
      throw new DaemonHttpError(409, "lease_lost", "This claim is no longer held.");
    const timeout = AbortSignal.timeout(config.taskTimeoutMs);
    // A cancelled task (or a lease lost any other way) stops its model call within a heartbeat,
    // as the worker's does: a cancel must not leave paid work running past the per-user cap.
    const lost = new AbortController();
    let checking = false;
    const heartbeat = setInterval(() => {
      // One check at a time: a slow queue database must not pile renewals onto the pool.
      if (checking) return;
      checking = true;
      void store
        .renew(claimed, config.taskTimeoutMs + executeLeaseMarginMs)
        .then((owned) => {
          if (!owned) lost.abort();
        })
        .catch(() => undefined)
        .finally(() => {
          checking = false;
        });
    }, executeHeartbeatMs);
    const stop = AbortSignal.any([timeout, lost.signal]);
    // The deadline holds even if an executor ignores its signal, as the worker's does.
    let onStop: () => void = () => {};
    const stopped = new Promise<never>((_, reject) => {
      onStop = () => reject(stop.reason);
      stop.addEventListener("abort", onStop, { once: true });
    });
    let outcome: { result: unknown } | { errorCode: string; retryable: boolean };
    try {
      outcome = { result: await Promise.race([execute(claimed, stop), stopped]) };
    } catch (error) {
      outcome = lost.signal.aborted
        ? { errorCode: "LEASE_LOST", retryable: false }
        : timeout.aborted
          ? { errorCode: "TASK_TIMEOUT", retryable: true }
          : error instanceof DaemonTaskError
            ? { errorCode: error.code, retryable: error.retryable }
            : { errorCode: "TASK_EXECUTION_FAILED", retryable: false };
    } finally {
      clearInterval(heartbeat);
      stop.removeEventListener("abort", onStop);
    }
    if (lost.signal.aborted) {
      // Cancelled mid-call: the call has stopped, so it no longer counts toward the user's cap.
      await store.clearCancelledLease(claimed);
      throw new DaemonHttpError(409, "lease_lost", "This claim is no longer held.");
    }
    if (!(await settleStorably(store, claimed, outcome)))
      throw new DaemonHttpError(409, "lease_lost", "This claim is no longer held.");
    const settled = await store.getOwned(userId, id);
    await lowerHintFor(settled);
    report({
      type: "browser_server_execute",
      taskId: id,
      ...("errorCode" in outcome ? { errorCode: outcome.errorCode } : {})
    });
    return settled!;
  }

  async function settleFromDevice(userId: string, id: string, body: Record<string, unknown>) {
    const claimed = await ownedClaim(userId, id, body);
    const raw = body.outcome;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
      throw new DaemonHttpError(400, "outcome_invalid", "outcome is required.");
    const outcome = raw as Record<string, unknown>;
    let settled: { result: UserTaskResult } | { errorCode: string; retryable: boolean };
    if (typeof outcome.text === "string") {
      if (outcome.text.length > maxDeviceResultChars || !storableText(outcome.text))
        throw new DaemonHttpError(
          400,
          "outcome_invalid",
          "The result text is too long or invalid."
        );
      if (typeof outcome.modelId !== "string" || !/^[\w./:@-]{1,200}$/u.test(outcome.modelId))
        throw new DaemonHttpError(400, "outcome_invalid", "modelId is required.");
      settled = {
        result: { text: outcome.text, modelId: outcome.modelId, executedBy: "device" }
      };
    } else if (typeof outcome.errorCode === "string" && errorCodePattern.test(outcome.errorCode)) {
      settled = { errorCode: outcome.errorCode, retryable: outcome.retryable === true };
    } else throw new DaemonHttpError(400, "outcome_invalid", "outcome needs text or errorCode.");
    if (!(await settleStorably(store, claimed, settled)))
      throw new DaemonHttpError(409, "lease_lost", "This claim is no longer held.");
    const task = await store.getOwned(userId, id);
    await lowerHintFor(task);
    return task!;
  }

  const serviceToken = environment.DAEMON_SERVICE_TOKEN?.trim() ?? "";
  let gateway: ReturnType<typeof buildDaemonGateway> | null = null;
  /** /internal/daemon/* → the native daemon's gateway, built once per isolate. */
  async function handleOperator(request: Request, path: string): Promise<Response | null> {
    if (!path.startsWith("/internal/daemon/")) return null;
    // Unconfigured means absent, not open: the gateway refuses short tokens at build time.
    if (serviceToken.length < 32)
      throw new DaemonHttpError(404, "route_not_found", "Route not found.");
    if (gateway === null) {
      gateway = buildDaemonGateway({
        store,
        token: serviceToken,
        ready: () => true,
        defaults: { modelId: config.modelId ?? "unconfigured", agentAdapterId: "grogoni" },
        refusal,
        report,
        onQueued: lowerHintFor
      });
      await gateway.ready();
    }
    const payload =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : // The gateway's own body limit, enforced while reading rather than after.
          Buffer.from(await readBounded(request, 400_000));
    const headers = Object.fromEntries(request.headers);
    delete headers["content-length"];
    const result = await gateway.inject({
      method: request.method as "GET" | "POST" | "DELETE",
      url: path.slice("/internal/daemon".length) + new URL(request.url).search,
      headers,
      ...(payload === undefined ? {} : { payload })
    });
    return new Response(result.statusCode === 204 ? null : new Uint8Array(result.rawPayload), {
      status: result.statusCode,
      headers: { "content-type": String(result.headers["content-type"] ?? "application/json") }
    });
  }

  async function handle(request: Request, path: string): Promise<Response | null> {
    if (!path.startsWith("/v1/daemon/")) return null;
    const segments = path.split("/").slice(3); // ["tasks"|"claims", id?, action?]
    const [collection, id, action, ...rest] = segments;
    const known =
      rest.length === 0 &&
      ((collection === "tasks" && action === undefined) ||
        (collection === "claims" &&
          (id === undefined
            ? true
            : ["renew", "settle", "release", "execute"].includes(action ?? ""))));
    if (!known) return null;
    const method = request.method;
    const { userId } = await dependencies.authenticate(request);
    const body =
      method === "POST" && !(collection === "claims" && id === undefined)
        ? await readJsonObject(request)
        : {};

    if (collection === "tasks" && id === undefined) {
      if (method === "GET")
        return json({ tasks: (await store.listOwned(userId, 50)).map(toPublicDaemonTask) });
      if (method === "POST") {
        const { created, task } = await createTask(userId, body);
        return json({ task: toPublicDaemonTask(task) }, created ? 201 : 200);
      }
      throw new DaemonHttpError(405, "method_not_allowed", "Method not allowed.");
    }
    if (collection === "tasks") {
      const task = uuidPattern.test(id!) ? await store.getOwned(userId, id!) : null;
      if (task === null) throw new DaemonHttpError(404, "task_not_found", "Task was not found.");
      if (method === "GET") return json({ task: toPublicDaemonTask(task) });
      if (method === "DELETE") {
        if (!(await store.cancelOwned(userId, id!)))
          throw new DaemonHttpError(
            409,
            "task_not_active",
            "Only queued or running tasks can be cancelled."
          );
        return json({ task: toPublicDaemonTask((await store.getOwned(userId, id!))!) });
      }
      throw new DaemonHttpError(405, "method_not_allowed", "Method not allowed.");
    }
    if (method !== "POST")
      throw new DaemonHttpError(405, "method_not_allowed", "Method not allowed.");
    if (id === undefined) {
      // Dead-lettering exhausted leases is the server lane's sweep, never a browser poll's.
      const task = await store.claimOwned(userId, config.browserLeaseMs);
      if (task === null) {
        return json({ claim: null, nextDueInMs: await store.nextOwnedDueInMs(userId) });
      }
      report({ type: "browser_claimed", taskId: task.id, attempt: task.attempts });
      return json({
        claim: {
          task: toPublicDaemonTask(task),
          leaseToken: task.lease_token,
          leaseUntil: new Date(task.lease_until!).toISOString(),
          leaseMs: config.browserLeaseMs,
          executeTimeoutMs: config.taskTimeoutMs + executeLeaseMarginMs,
          // The browser lane needs the message to run it on the device.
          message: task.payload.kind === "agent" ? task.payload.message : null
        }
      });
    }
    if (action === "renew") {
      const claimed = await ownedClaim(userId, id, body);
      if (!(await store.renew(claimed, config.browserLeaseMs)))
        throw new DaemonHttpError(409, "lease_lost", "This claim is no longer held.");
      return json({ renewed: true });
    }
    if (action === "release") {
      const claimed = await ownedClaim(userId, id, body);
      if (!(await store.release(claimed)))
        throw new DaemonHttpError(409, "lease_lost", "This claim is no longer held.");
      const task = await store.getOwned(userId, id);
      await lowerHintFor(task);
      return json({ task: toPublicDaemonTask(task!) });
    }
    if (action === "settle")
      return json({ task: toPublicDaemonTask(await settleFromDevice(userId, id, body)) });
    return json({ task: toPublicDaemonTask(await executeOnServer(userId, id, body)) });
  }

  return {
    store,
    config,
    serverCanRunAgents,
    /** Returns null for paths it does not own; errors become JSON responses. */
    async routes(request: Request, path: string): Promise<Response | null> {
      try {
        return (await handleOperator(request, path)) ?? (await handle(request, path));
      } catch (error) {
        if (error instanceof DaemonHttpError)
          return json({ code: error.code, message: error.message }, error.status);
        throw error;
      }
    },
    /** One bounded server-lane run (the daemon_worker Edge job). */
    async runWorker(): Promise<EdgeWorkerRun> {
      const started = performance.now();
      let version: number | null = null;
      if (dependencies.hint !== null) {
        const read = await withinBudget(
          dependencies.hint.version().catch(() => null),
          hintWriteBudgetMs
        );
        version = read === "late" ? null : read;
        if (version === null) report({ type: "wake_hint_unavailable" });
      }
      const counts = { claimed: 0, finished: 0, failed: 0, fenced: 0, leaseExhausted: 0 };
      let hint: EdgeWorkerRun["hint"] = "unavailable";
      const finish = async (disabled: boolean, nextDueAt: Date | null): Promise<EdgeWorkerRun> => {
        if (dependencies.hint !== null && version !== null) {
          const written = await withinBudget(
            dependencies.hint.set(nextDueAt, version).catch(() => null),
            hintWriteBudgetMs
          );
          if (written === "late" || written === null) report({ type: "wake_hint_unavailable" });
          else hint = written ? "updated" : "superseded";
        }
        return {
          disabled,
          ...counts,
          nextServerDueAt: nextDueAt?.toISOString() ?? null,
          hint,
          durationMs: Math.round(performance.now() - started)
        };
      };
      // Switched off: clear the hint so the per-minute wake stops calling this job. New work
      // lowers it again, which costs one more call that clears it again.
      if (environment.ENABLE_DAEMON_WORKER === "false") return finish(true, null);
      await runDaemonWorker({
        store,
        execute,
        signal: new AbortController().signal,
        leaseMs: 30_000,
        taskTimeoutMs: config.taskTimeoutMs,
        runUntil: started + config.runBudgetMs,
        exitWhenIdle: true,
        report: (event) => {
          if (event.type === "task_started") counts.claimed++;
          else if (event.type === "task_finished") counts.finished++;
          else if (event.type === "task_failed") counts.failed++;
          else if (event.type === "task_settle_fenced" || event.type === "lease_lost")
            counts.fenced++;
          else if (event.type === "lease_exhausted") counts.leaseExhausted++;
          report(event);
        }
      });
      return finish(false, await store.nextServerDueAt());
    }
  };
}

export type EdgeDaemon = ReturnType<typeof createEdgeDaemon>;

/**
 * A maintenance task's executor over the Edge job runner. A job that was already running (its
 * lock held) or is switched off did not do the work, so the task must not settle as if it had.
 */
export function maintenanceFromJobRunner(
  runJob: (job: string) => Promise<{ status: "completed" | "disabled" | "skipped" }>
) {
  return async (job: string) => {
    const outcome = await runJob(job);
    if (outcome.status === "skipped") throw new DaemonTaskError("JOB_ALREADY_RUNNING", true);
    if (outcome.status === "disabled") throw new DaemonTaskError("JOB_DISABLED", false);
    return outcome;
  };
}

/** The reply text from an agent result: the runtime's JSON contract, or the raw output. */
function userResultFromAgent(task: DaemonTask, result: unknown): UserTaskResult {
  const completion = (result as { completion?: { outputText?: unknown } } | null)?.completion;
  const raw = typeof completion?.outputText === "string" ? completion.outputText : "";
  let text = raw;
  try {
    const parsed = JSON.parse(raw) as { message?: unknown };
    if (typeof parsed.message === "string") text = parsed.message;
  } catch {
    // Not the JSON contract: keep the raw text.
  }
  return {
    text,
    modelId: task.payload.kind === "agent" ? task.payload.modelId : "",
    executedBy: "server"
  };
}

/** The promise's value if it settles within `ms`, otherwise "late" (it keeps running). */
async function withinBudget<T>(promise: Promise<T>, ms: number): Promise<T | "late"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), ms)))
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** The body as bytes, refusing (413) before it grows past `max`. */
async function readBounded(request: Request, max: number): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new DaemonHttpError(413, "request_too_large", "The request is too large.");
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks);
}

/** PostgreSQL text and jsonb reject NUL, and a lone surrogate cannot be encoded at all. */
function storableText(text: string): boolean {
  return !text.includes("\0") && !/\p{Cs}/u.test(text);
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
  )
    throw new DaemonHttpError(415, "content_type_invalid", "Use application/json.");
  const text = Buffer.from(await readBounded(request, 100_000)).toString("utf8");
  try {
    const parsed: unknown = JSON.parse(text || "{}");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new DaemonHttpError(400, "request_invalid", "A JSON object is required.");
  }
}
