// Schedules the Edge API's background jobs with Supabase Cron.
//
//   pnpm jobs:schedule:supabase            print the SQL that would be applied (no changes)
//   pnpm jobs:schedule:supabase --apply    reuse the job token and apply the schedule
//   pnpm jobs:schedule:supabase --apply --rotate-token    explicitly rotate the token
//
// --apply reuses the Vault token (or creates one on first setup), sets the Edge function secret, stores the
// same value in Supabase Vault, and (re)creates one pg_cron entry per job in
// services/api/src/edge-job-runner.ts. Requires SUPABASE_ACCESS_TOKEN. Safe to re-run.
import { randomBytes } from "node:crypto";
import { buildSupabaseCronSql, redactJobToken } from "../services/api/src/edge-job-schedule.ts";

const projectRef = "gnmndzsughifhboqvsgd";
const apiUrl = `https://${projectRef}.supabase.co/functions/v1/api`;
const managementBase = `https://api.supabase.com/v1/projects/${projectRef}`;
const apply = process.argv.includes("--apply");

if (!apply) {
  process.stdout.write(buildSupabaseCronSql({ apiUrl }));
  console.error("\nDry run: nothing was changed. Re-run with --apply to schedule the jobs.");
  process.exit(0);
}

const accessToken = process.env.SUPABASE_ACCESS_TOKEN?.trim();
if (!accessToken) throw new Error("SUPABASE_ACCESS_TOKEN is required.");

let jobToken = "";
const rotate = process.argv.includes("--rotate-token");

async function management(path, body) {
  const response = await fetch(`${managementBase}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: globalThis.AbortSignal.timeout(60000)
  });
  if (!response.ok)
    throw new Error(
      `Supabase ${path} returned HTTP ${response.status}: ${redactJobToken(await response.text(), jobToken).slice(0, 2000)}`
    );
  const text = await response.text();
  return text.trim() === "" ? null : JSON.parse(text);
}

const existing = rotate
  ? []
  : await management("/database/query", {
      query:
        "select decrypted_secret as token from vault.decrypted_secrets where name = 'grogoni_background_job_token'"
    });
if (!Array.isArray(existing) || existing.length > 1)
  throw new Error("Expected at most one background job token in Vault.");
const saved = existing[0]?.token;
if (saved !== undefined && (typeof saved !== "string" || !/^[A-Za-z0-9_-]{32,}$/.test(saved)))
  throw new Error("Existing Vault token is invalid; inspect before explicit rotation.");
jobToken = saved ?? randomBytes(32).toString("base64url");

// Two writes hold the token: the function secret (checked on each job call) and Vault (sent by
// cron). Reusing it avoids an authentication gap on ordinary schedule updates.
await management("/secrets", [{ name: "BACKGROUND_JOB_TOKEN", value: jobToken }]);
try {
  await management("/database/query", { query: buildSupabaseCronSql({ apiUrl, jobToken }) });
} catch (error) {
  console.error(
    "The function secret was updated but the schedule was not applied, so job calls will answer " +
      "401 if the token changed. Re-run: pnpm jobs:schedule:supabase --apply"
  );
  throw error;
}
const scheduled = await management("/database/query", {
  query:
    "select jobname, schedule from cron.job where jobname like 'grogoni-job-%' order by jobname"
});
console.log(JSON.stringify({ scheduled }, null, 2));
console.log("Applied. Existing Vault token reused: " + Boolean(saved));
if (!saved) console.log("The new token is read at cold start; allow running isolates to recycle.");
