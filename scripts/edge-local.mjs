// Runs the real Supabase Edge API (supabase/functions/api) under Deno on localhost:8000, against
// two scratch databases on the docker-compose Postgres: one playing Neon, one playing Supabase's
// own Postgres (the daemon wake hint, with a stub where pg_net would call the job route). Rebuilds
// the domain bundle and recreates both databases on every start.
//
//   pnpm edge:local            then, in another terminal:   pnpm eval:daemon-lanes:local
//
// Model calls use OPENROUTER_API_KEY and PLATFORM_DEFAULT_MODEL_ID from .env.openrouter if present.
import { spawn, spawnSync } from "node:child_process";
import { URL } from "node:url";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { edgeLocal } from "./edge-local-config.mjs";
import { daemonWakeSql } from "../services/api/src/edge-job-schedule.ts";

const root = new URL("..", import.meta.url).pathname;
const { Client } = createRequire(join(root, "services/api/package.json"))("pg");
const sql = async (url, statements) => {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    for (const statement of statements) await client.query(statement);
  } finally {
    await client.end();
  }
};

await sql(edgeLocal.adminUrl, [
  "drop database if exists grogoni_lanes_smoke",
  "create database grogoni_lanes_smoke",
  "drop database if exists grogoni_lanes_hint",
  "create database grogoni_lanes_hint"
]);
// A clean environment: never let a root .env point this at a real database.
const migrated = spawnSync(process.execPath, ["scripts/migrate-db.mjs"], {
  cwd: join(root, "services/api"),
  stdio: "inherit",
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DATABASE_URL: edgeLocal.queueUrl,
    PGOPTIONS: "-c grogoni.allow_108=yes"
  }
});
if (migrated.status !== 0) process.exit(migrated.status ?? 1);
await sql(edgeLocal.hintUrl, [
  ...["anon", "authenticated"].map(
    (role) =>
      `do $r$ begin create role ${role} nologin; exception when duplicate_object then null; end $r$`
  ),
  "create table wake_calls (job text, at timestamptz default now())",
  `create function public.grogoni_run_background_job(job text) returns bigint language sql
   as $f$ insert into public.wake_calls (job) values (job) returning 1::bigint $f$`,
  ...daemonWakeSql()
]);
const built = spawnSync(process.execPath, ["scripts/build-supabase-domain.mjs"], {
  cwd: root,
  stdio: "inherit"
});
if (built.status !== 0) process.exit(built.status ?? 1);
// Deno must not see the repository's node_modules: Supabase resolves npm: imports itself.
const fn = join(tmpdir(), "grogoni-edge-local", "fn");
await rm(fn, { recursive: true, force: true });
await mkdir(fn, { recursive: true });
await cp(join(root, "supabase/functions/api"), fn, { recursive: true });
const openrouter = await readFile(join(root, ".env.openrouter"), "utf8").catch(() => "");
const fromFile = Object.fromEntries(
  openrouter
    .split("\n")
    .map((line) => /^(OPENROUTER_API_KEY|PLATFORM_DEFAULT_MODEL_ID)=(.*)$/u.exec(line.trim()))
    .filter(Boolean)
    .map((match) => [match[1], match[2]])
);
const child = spawn(
  "npx",
  [
    "--yes",
    `deno@${edgeLocal.denoVersion}`,
    "run",
    "-A",
    "--no-lock",
    "--node-modules-dir=none",
    "index.ts"
  ],
  {
    cwd: fn,
    stdio: "inherit",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...fromFile,
      NODE_ENV: "production",
      DATABASE_URL: edgeLocal.queueUrl,
      SUPABASE_DB_URL: edgeLocal.hintUrl,
      PIN_HASH_SECRET: "local-pin-secret-0123456789abcdef0123456789",
      PASSWORD_HASH_SECRET: "local-pw-secret-0123456789abcdef0123456789",
      AUTH_AUDIT_HMAC_SECRET: "local-audit-secret-0123456789abcdef01234567",
      AUTH_TOKEN_ENCRYPTION_KEY: "0".repeat(63) + "7",
      OTP_HMAC_SECRET: "local-otp-secret-0123456789abcdef0123456789",
      BACKGROUND_JOB_TOKEN: edgeLocal.backgroundJobToken,
      DAEMON_SERVICE_TOKEN: edgeLocal.daemonServiceToken,
      WEB_ORIGINS: "http://localhost:5173",
      WEB_PUBLIC_URL: "http://localhost:5173",
      // Production-mode checks demand an HTTPS passkey origin; nothing here uses passkeys.
      WEBAUTHN_RP_ID: "grogoni.test",
      WEBAUTHN_EXPECTED_ORIGINS: "https://grogoni.test"
    }
  }
);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
