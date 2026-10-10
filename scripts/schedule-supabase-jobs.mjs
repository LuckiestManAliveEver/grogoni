// Schedules the Edge API's background jobs with Supabase Cron.
//
//   pnpm jobs:schedule:supabase            print the SQL that would be applied (no changes)
//   pnpm jobs:schedule:supabase --apply    rotate the job token and apply the schedule
//
// --apply generates a fresh BACKGROUND_JOB_TOKEN, sets it as the Edge function secret, stores the
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

const jobToken = randomBytes(32).toString("base64url");

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

// Two writes hold the token: the function secret (checked on each job call) and Vault (sent by
// cron). If only the first lands, the two differ and every job answers 401 until a re-run, which
// rotates the token again and writes both.
await management("/secrets", [{ name: "BACKGROUND_JOB_TOKEN", value: jobToken }]);
try {
  await management("/database/query", { query: buildSupabaseCronSql({ apiUrl, jobToken }) });
} catch (error) {
  console.error(
    "The function secret was updated but the schedule was not applied, so job calls will answer " +
      "401 until this script runs again. Re-run: pnpm jobs:schedule:supabase --apply"
  );
  throw error;
}
const scheduled = await management("/database/query", {
  query:
    "select jobname, schedule from cron.job where jobname like 'grogoni-job-%' order by jobname"
});
console.log(JSON.stringify({ scheduled }, null, 2));
console.log(
  "Applied. The function reads BACKGROUND_JOB_TOKEN at cold start; job calls answer 401 until " +
    "running isolates recycle (minutes)."
);
