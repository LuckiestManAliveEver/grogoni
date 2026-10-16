import { Pool } from "pg";
import type { buildDaemonGateway } from "./gateway.js";
import { repositoryDefaultRuntimePolicy } from "@grogoni/shared-types";
import { buildPgPoolConfig } from "../db-pool-config.js";
import { connectedAgentRuntimeAdapterId } from "../agent-harness/retired-agent-runtimes.js";
import { createPostgresDaemonTaskStore, defaultUserTakeoverMs } from "./task-store.js";
import { createDaemonExecutor, readDaemonCapabilities } from "./executor.js";
import { DEFAULT_DATABASE_STARTUP_RETRY, retryDatabaseStartup } from "../db-startup-retry.js";
import { pause, runDaemonWorker, type DaemonEvent } from "./worker.js";
import { daemonRetentionMsFromEnv, runDaemonRetention } from "./retention.js";
import { integerFromEnv, readDaemonNetworkConfig } from "./config.js";

/** SIGTERM arrived while waiting for the database at boot: exit cleanly, nothing started. */
class BootAborted extends Error {}

const databaseUrl =
  process.env.DAEMON_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim() || "";
if (!databaseUrl) throw new Error("DAEMON_DATABASE_URL or DATABASE_URL is required.");
const { port, host, pollMs } = readDaemonNetworkConfig();
const retentionMs = daemonRetentionMsFromEnv(process.env.DAEMON_RETENTION_DAYS);
// Must stay well below systemd TimeoutStopSec (40s): release, HTTP close and pool close follow it.
// Capped at 25s so, with a responsive database, settlement, release and close fit inside
// TimeoutStopSec=40. If the database hangs, systemd's SIGKILL may land first; queue state is
// still safe (the lease expires and fencing holds), only the final log line can be lost.
const shutdownGraceMs = integerFromEnv("DAEMON_SHUTDOWN_GRACE_MS", 20_000, 0, 25_000);
// Same retired-engine mapping as the API, so a stale "zeroclaw" setting resolves to Grogoni.
const defaultAgentAdapterId = connectedAgentRuntimeAdapterId(
  process.env.PLATFORM_DEFAULT_AGENT_ADAPTER_ID?.trim() ||
    repositoryDefaultRuntimePolicy.agentRuntimeAdapterId
);
if (defaultAgentAdapterId !== "grogoni" && defaultAgentAdapterId !== "pi")
  throw new Error("The daemon runs agent tasks on the grogoni or pi engine only.");
const defaultModelId =
  process.env.PLATFORM_DEFAULT_MODEL_ID?.trim() || repositoryDefaultRuntimePolicy.modelId;
const capabilities = readDaemonCapabilities(process.env, defaultModelId);
// Worker claim/renew/settle, retention and gateway requests share this pool; headroom keeps a
// slow operator query from delaying lease renewals.
const pool = new Pool(buildPgPoolConfig(databaseUrl, { max: 6 }));
pool.on("error", () => console.error(JSON.stringify({ type: "database_pool_error" })));
const store = createPostgresDaemonTaskStore(pool, {
  // Same rule as the Edge lane: a user's task waits this long for their browser first.
  userTakeoverMs: integerFromEnv(
    "DAEMON_USER_TAKEOVER_MS",
    defaultUserTakeoverMs,
    60_000,
    86_400_000
  )
});
const controller = new AbortController();
const serviceToken = process.env.DAEMON_SERVICE_TOKEN ?? "";
if (serviceToken.length < 32 || /\s/u.test(serviceToken))
  throw new Error("DAEMON_SERVICE_TOKEN must be at least 32 characters with no whitespace.");
let app: ReturnType<typeof buildDaemonGateway> | undefined;
function report(event: DaemonEvent) {
  console.log(JSON.stringify(event));
}
const execute = createDaemonExecutor(process.env);
// Repeated signals are absorbed so a second Ctrl-C or SIGTERM cannot cut the grace period short
// and strand a claimed task; systemd's SIGKILL after TimeoutStopSec remains the hard stop.
const shutdown = () => {
  if (controller.signal.aborted) return;
  report({ type: "daemon_stopping" });
  controller.abort();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
try {
  // A briefly unreachable database is retried in-process; a longer outage exits and systemd
  // restarts the unit indefinitely. SIGTERM during the retry ends it promptly and cleanly.
  const booted = await retryDatabaseStartup(
    "daemon_queue",
    async () => {
      if (controller.signal.aborted) return false;
      await store.health();
      return true;
    },
    {
      ...DEFAULT_DATABASE_STARTUP_RETRY,
      sleep: (ms) => pause(ms, controller.signal),
      log: ({ event, ...detail }) =>
        // An aborted boot "succeeds" only to stop; it must not claim the database recovered.
        (event === "db.startup_recovered" && controller.signal.aborted) ||
        console.log(
          JSON.stringify({
            type:
              event === "db.startup_recovered"
                ? "database_startup_recovered"
                : "database_startup_retry",
            ...detail
          })
        )
    }
  );
  if (!booted) throw new BootAborted();
  const { buildDaemonGateway } = await import("./gateway.js");
  if (controller.signal.aborted) throw new BootAborted();
  app = buildDaemonGateway({
    store,
    token: serviceToken,
    ready: () => !controller.signal.aborted,
    defaults: { modelId: defaultModelId, agentAdapterId: defaultAgentAdapterId },
    refusal: capabilities.refusal,
    report: (event) => report(event)
  });
  await app.listen({ host, port });
  console.log(
    JSON.stringify({
      type: "daemon_started",
      host,
      port,
      agents: capabilities.agents,
      maintenance: capabilities.maintenance,
      retentionDays: retentionMs === null ? 0 : retentionMs / 86_400_000
    })
  );
  await Promise.all([
    runDaemonWorker({ store, execute, signal: controller.signal, pollMs, shutdownGraceMs, report }),
    retentionMs === null
      ? undefined
      : runDaemonRetention({ store, retentionMs, signal: controller.signal, report })
  ]);
} catch (error) {
  if (!(error instanceof BootAborted)) throw error;
} finally {
  controller.abort();
  await app?.close();
  await pool.end();
  process.removeListener("SIGTERM", shutdown);
  process.removeListener("SIGINT", shutdown);
}
