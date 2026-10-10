import { edgeJobDefinitions } from "./edge-job-runner.js";

/**
 * SQL that schedules every Edge background job with Supabase Cron (pg_cron + pg_net) in the
 * Supabase project's own Postgres. Generated from edgeJobDefinitions, so adding a job to the
 * runner adds its schedule, and a job removed from the runner is unscheduled on the next apply.
 *
 * The job token lives in Supabase Vault (`grogoni_background_job_token`), never in the cron
 * command text, which pg_cron stores in plain text in cron.job.
 */

export const cronJobPrefix = "grogoni-job-";
export const vaultTokenName = "grogoni_background_job_token";

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildSupabaseCronSql(input: { apiUrl: string; jobToken?: string }): string {
  if (!/^https:\/\/[^\s'"]+$/u.test(input.apiUrl)) throw new Error("apiUrl must be an https URL.");
  const jobs = Object.entries(edgeJobDefinitions).sort(([a], [b]) => a.localeCompare(b));
  const statements = [
    "create extension if not exists pg_cron;",
    "create extension if not exists pg_net;"
  ];
  if (input.jobToken !== undefined) {
    if (!/^[A-Za-z0-9_-]{32,}$/u.test(input.jobToken))
      throw new Error("jobToken must be at least 32 URL-safe characters.");
    statements.push(`do $vault$
declare existing uuid;
begin
  select id into existing from vault.secrets where name = ${literal(vaultTokenName)};
  if existing is null then
    perform vault.create_secret(${literal(input.jobToken)}, ${literal(vaultTokenName)});
  else
    perform vault.update_secret(existing, ${literal(input.jobToken)});
  end if;
end
$vault$;`);
  }
  statements.push(`create or replace function public.grogoni_run_background_job(job text)
returns bigint
language sql
security definer
set search_path = ''
as $function$
  select net.http_post(
    url := ${literal(input.apiUrl)} || '/internal/jobs/' || job || '/run',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-job-token', (select decrypted_secret from vault.decrypted_secrets where name = ${literal(vaultTokenName)})
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
$function$;`);
  statements.push(
    "revoke all on function public.grogoni_run_background_job(text) from public, anon, authenticated;"
  );
  statements.push(`select cron.unschedule(jobname) from cron.job
where jobname like ${literal(`${cronJobPrefix}%`)}
  and jobname not in (${jobs.map(([name]) => literal(`${cronJobPrefix}${name}`)).join(", ")});`);
  for (const [name, definition] of jobs) {
    statements.push(
      `select cron.schedule(${literal(`${cronJobPrefix}${name}`)}, ${literal(definition.schedule)}, ${literal(
        `select public.grogoni_run_background_job(${literal(name)})`
      )});`
    );
  }
  return `${statements.join("\n\n")}\n`;
}

/**
 * Text that may echo the applied SQL (a failed Management API call returns the query in its
 * error), with the job token removed so it never reaches a terminal or CI log. Fragments count
 * too: an error excerpt (`LINE 3: ...`) can cut through the token, so any run of 12 or more
 * token characters that occurs in the token is removed as well.
 */
export function redactJobToken(text: string, jobToken: string): string {
  if (jobToken.length === 0) return text;
  return text
    .replaceAll(jobToken, "[redacted job token]")
    .replace(/[A-Za-z0-9_-]{12,}/gu, (run) =>
      jobToken.includes(run) ? "[redacted job token]" : run
    );
}
