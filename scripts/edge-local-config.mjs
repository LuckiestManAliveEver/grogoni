// Throwaway settings for the local Supabase Edge stand-in (scripts/edge-local.mjs) and the evals
// that target it. Local only: these are not secrets and must never be used anywhere else.
import { URL } from "node:url";

const admin =
  process.env.EDGE_LOCAL_ADMIN_URL ??
  "postgres://grogoni:grogoni_dev_password@localhost:5432/grogoni_market";
const at = (database) => {
  const url = new URL(admin);
  url.pathname = `/${database}`;
  return url.toString();
};

// Several stand-ins can run side by side (one per worktree): EDGE_LOCAL_PORT, EDGE_LOCAL_QUEUE_DB,
// EDGE_LOCAL_HINT_DB and EDGE_LOCAL_WEB_ORIGIN choose a port, scratch databases and the web origin
// it accepts. The defaults are the single-checkout setup.
const port = Number(process.env.EDGE_LOCAL_PORT ?? "8000");

export const edgeLocal = {
  adminUrl: admin,
  port,
  /** Plays Neon: the full schema, migrated from infra/db/migrations. */
  queueDatabase: process.env.EDGE_LOCAL_QUEUE_DB ?? "grogoni_lanes_smoke",
  queueUrl: at(process.env.EDGE_LOCAL_QUEUE_DB ?? "grogoni_lanes_smoke"),
  /** Plays Supabase's own Postgres: the daemon wake hint and a stub for pg_net. */
  hintDatabase: process.env.EDGE_LOCAL_HINT_DB ?? "grogoni_lanes_hint",
  hintUrl: at(process.env.EDGE_LOCAL_HINT_DB ?? "grogoni_lanes_hint"),
  apiUrl: `http://localhost:${port}`,
  webOrigin: process.env.EDGE_LOCAL_WEB_ORIGIN ?? "http://localhost:5173",
  backgroundJobToken: "localjobtoken_0123456789abcdefghijklmnopqrstuv",
  daemonServiceToken: "localdaemontoken_0123456789abcdefghijklmnopqrst",
  denoVersion: "2.5.4"
};
