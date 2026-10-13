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

export const edgeLocal = {
  adminUrl: admin,
  /** Plays Neon: the full schema, migrated from infra/db/migrations. */
  queueUrl: at("grogoni_lanes_smoke"),
  /** Plays Supabase's own Postgres: the daemon wake hint and a stub for pg_net. */
  hintUrl: at("grogoni_lanes_hint"),
  apiUrl: "http://localhost:8000",
  backgroundJobToken: "localjobtoken_0123456789abcdefghijklmnopqrstuv",
  daemonServiceToken: "localdaemontoken_0123456789abcdefghijklmnopqrst",
  denoVersion: "2.5.4"
};
