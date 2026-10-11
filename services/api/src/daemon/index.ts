import { Pool } from "pg";
import { repositoryDefaultRuntimePolicy } from "@grogoni/shared-types";
import { buildPgPoolConfig } from "../db-pool-config.js";
import { connectedAgentRuntimeAdapterId } from "../agent-harness/retired-agent-runtimes.js";
import { createPostgresDaemonTaskStore } from "./task-store.js";
import { buildDaemonGateway } from "./gateway.js";
import { createDaemonExecutor, readDaemonCapabilities } from "./executor.js";
import { DEFAULT_DATABASE_STARTUP_RETRY, retryDatabaseStartup } from "../db-startup-retry.js";
import { pause, runDaemonWorker, type DaemonEvent } from "./worker.js";
import { daemonRetentionMsFromEnv, runDaemonRetention } from "./retention.js";

/** SIGTERM arrived while waiting for the database at boot: exit cleanly, nothing started. */
class BootAborted extends Error {}

const databaseUrl =
  process.env.DAEMON_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim() || "";
if (!databaseUrl) throw new Error("DAEMON_DATABASE_URL or DATABASE_URL is required.");
/** Plain decimal integers only: Number() would also accept "0x50", "1e3" and "0b1010000". */
function integerFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim() ?? "";
  if (raw === "") return fallback;
  const value = /^\d+$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!(value >= min && value <= max))
    throw new Error(`${name} must be a decimal integer from ${min} to ${max}.`);
  return value;
}
const port = integerFromEnv("DAEMON_PORT", 42700, 1, 65535);
// Blank means default, like every other setting: never let "DAEMON_HOST=" bind all interfaces.
const host = process.env.DAEMON_HOST?.trim() || "127.0.0.1";
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
const store = createPostgresDaemonTaskStore(pool);
const controller = new AbortController();
const app = buildDaemonGateway({
  store,
  token: process.env.DAEMON_SERVICE_TOKEN ?? "",
  ready: () => !controller.signal.aborted,
  defaults: { modelId: defaultModelId, agentAdapterId: defaultAgentAdapterId },
  refusal: capabilities.refusal,
  report: (event) => report(event)
});
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
    runDaemonWorker({ store, execute, signal: controller.signal, shutdownGraceMs, report }),
    retentionMs === null
      ? undefined
      : runDaemonRetention({ store, retentionMs, signal: controller.signal, report })
  ]);
} catch (error) {
  if (!(error instanceof BootAborted)) throw error;
} finally {
  controller.abort();
  await app.close();
  await pool.end();
  process.removeListener("SIGTERM", shutdown);
  process.removeListener("SIGINT", shutdown);
}
