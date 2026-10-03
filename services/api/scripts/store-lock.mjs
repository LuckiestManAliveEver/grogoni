// Inspects (and with --release, frees) the CP2 persistence advisory lock
// `hashtext('grogoni.cp2.normalized_store')`. Builds before the transaction-scoped lock took it with a
// session-level pg_advisory_lock through Neon's transaction-mode PgBouncer, which could leak it onto
// an idle pooled backend that never closes. See docs/runbooks/cp2-store-lock-leak.md.
//
// Usage (repo root):
//   pnpm db:store-lock                # report holders and waiters
//   pnpm db:store-lock -- --release   # terminate leaked (idle) holders
//
// The pooler host (`-pooler.`) is rewritten to the direct host: through the pooler this script's own
// query could run on the leaked backend itself, which would then show as "active" (this query)
// instead of "idle" and be missed.
import { URL } from "node:url";
import pg from "pg";
import { databasePoolConfig, readDatabaseUrl } from "./database-connection.mjs";
import { findStoreLockHolders, releaseLeakedStoreLockHolders } from "./store-lock-lib.mjs";

const configured = readDatabaseUrl();
if (configured === null) {
  console.error("DIRECT_DATABASE_URL or DATABASE_URL is required.");
  process.exit(1);
}
const target = new URL(configured);
target.hostname = target.hostname.replace("-pooler.", ".");
// Printed first so it is obvious which database is being inspected (.env.local can override .env).
console.log(`Target: ${target.hostname}${target.pathname}`);
const pool = new pg.Pool(
  databasePoolConfig(target.toString(), { applicationName: "grogoni-store-lock" })
);
try {
  const { holders, waiters } = await findStoreLockHolders(pool);
  console.log(JSON.stringify({ holders, waiters }, null, 2));
  const leaked = holders.filter((row) => row.state === "idle");
  if (leaked.length === 0) {
    console.log("No leaked (idle) holder.");
  } else if (!process.argv.includes("--release")) {
    console.log(
      `Leaked holder(s): ${leaked.map((row) => row.pid).join(", ")}. Re-run with --release to terminate.`
    );
  } else {
    for (const result of await releaseLeakedStoreLockHolders(pool)) {
      console.log(JSON.stringify(result));
    }
  }
} finally {
  await pool.end();
}
