// Deploying the Edge API through the Supabase CLI (`--use-docker`) instead of the Management
// API's multipart upload. Since 2026-11-18 the Management API refuses this function's upload with
// HTTP 413 ("maximum deployment size (5 MB)") even at sizes it accepted the day before, while the
// CLI's locally bundled deployment of the same sources succeeds.
import { spawnSync } from "node:child_process";

/** Upload routes the deploy script supports. The CLI is the default. */
export const uploadMethods = Object.freeze(["cli", "management-api"]);

export function readUploadMethod(argv) {
  const value = argv.find((arg) => arg.startsWith("--upload="))?.slice("--upload=".length) ?? "cli";
  if (!uploadMethods.includes(value))
    throw new Error(`Unsupported --upload=${value}; use one of: ${uploadMethods.join(", ")}.`);
  return value;
}

/** The CLI executable: SUPABASE_CLI when set (a path), otherwise `supabase` on PATH. */
export function supabaseCliCommand(env) {
  const configured = env.SUPABASE_CLI?.trim();
  return configured ? configured : "supabase";
}

/** Exactly the arguments of the deployment that succeeded on 2026-11-17 and 2026-11-18. */
export function supabaseCliDeployArgs(slug, projectRef) {
  if (!["api", "api-candidate"].includes(slug)) throw new Error("Unsupported API deployment slug.");
  if (!/^[a-z]{20}$/u.test(projectRef)) throw new Error("Invalid Supabase project ref.");
  return [
    "functions",
    "deploy",
    slug,
    `--remote=${projectRef}`,
    "--use-docker",
    "--no-verify-jwt",
    "--yes"
  ];
}

const installHint =
  "Install the Supabase CLI (https://supabase.com/docs/guides/local-development/cli/getting-started) " +
  "and put it on PATH, or set SUPABASE_CLI to its path. Docker must be running for --use-docker.";

/** Runs the CLI deployment. The access token goes only to the child's environment. */
export function deployWithSupabaseCli({
  slug,
  projectRef,
  token,
  env = process.env,
  spawn = spawnSync
}) {
  const command = supabaseCliCommand(env);
  const version = spawn(command, ["--version"], { encoding: "utf8" });
  if (version.error || version.status !== 0)
    throw new Error(`The Supabase CLI could not be run as "${command}". ${installHint}`);
  console.log(JSON.stringify({ supabaseCli: command, version: String(version.stdout).trim() }));
  const result = spawn(command, supabaseCliDeployArgs(slug, projectRef), {
    stdio: "inherit",
    env: { ...env, SUPABASE_ACCESS_TOKEN: token }
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`supabase functions deploy ${slug} exited with status ${result.status}.`);
}
