// Runs the real Supabase Edge API (supabase/functions/api) under Deno on localhost:8000, against
// two scratch databases on the docker-compose Postgres: one playing Neon, one playing Supabase's
// own Postgres (the daemon wake hint, with a stub where pg_net would call the job route). Rebuilds
// the domain bundle and recreates both databases on every start.
//
//   pnpm edge:local            then, in another terminal:   pnpm eval:daemon-lanes:local
//
// Model calls use OPENROUTER_API_KEY and PLATFORM_DEFAULT_MODEL_ID from .env.openrouter if present.
// EDGE_LOCAL_FAKE_MODEL_DELAY_MS=<ms> instead answers every OpenRouter call locally after that
// delay with a fixed fixture reply (free; scripts/eval-user-journey.mjs uses it to hold an agent
// turn open). EDGE_LOCAL_PORT and friends: see edge-local-config.mjs.
import { spawn, spawnSync } from "node:child_process";
import { URL } from "node:url";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  `drop database if exists ${edgeLocal.queueDatabase}`,
  `create database ${edgeLocal.queueDatabase}`,
  `drop database if exists ${edgeLocal.hintDatabase}`,
  `create database ${edgeLocal.hintDatabase}`
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
const fn = join(tmpdir(), `grogoni-edge-local-${edgeLocal.port}`, "fn");
await rm(fn, { recursive: true, force: true });
await mkdir(fn, { recursive: true });
await cp(join(root, "supabase/functions/api"), fn, { recursive: true });
// A local-only entry around index.ts: Deno.serve on the chosen port, and the optional fake model.
await writeFile(
  join(fn, "local-entry.ts"),
  `const port = Number(Deno.env.get("EDGE_LOCAL_PORT") ?? "8000");
const serve = Deno.serve.bind(Deno);
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (first: any, second?: any) =>
  typeof first === "function" ? serve({ port }, first) : serve({ ...first, port }, second);
const delay = Number(Deno.env.get("EDGE_LOCAL_FAKE_MODEL_DELAY_MS") ?? "0");
if (delay > 0) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input: Request | URL | string, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://openrouter.ai/api/v1/key") return Response.json({ data: {} });
    if (url === "https://openrouter.ai/api/v1/chat/completions") {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return Response.json({
        id: crypto.randomUUID(),
        model: "openai/gpt-6-luna",
        choices: [{ message: { content: JSON.stringify({ type: "response", message: "This is the fixture reply from the local stand-in." }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      });
    }
    return realFetch(input, init);
  };
}
await import("./index.ts");
`
);
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
    "local-entry.ts"
  ],
  {
    cwd: fn,
    stdio: "inherit",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...fromFile,
      ...(process.env.EDGE_LOCAL_FAKE_MODEL_DELAY_MS
        ? {
            EDGE_LOCAL_FAKE_MODEL_DELAY_MS: process.env.EDGE_LOCAL_FAKE_MODEL_DELAY_MS,
            OPENROUTER_API_KEY: "local-fake-model-key"
          }
        : {}),
      EDGE_LOCAL_PORT: String(edgeLocal.port),
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
      WEB_ORIGINS: edgeLocal.webOrigin,
      WEB_PUBLIC_URL: edgeLocal.webOrigin,
      // Production-mode checks demand an HTTPS passkey origin; nothing here uses passkeys.
      WEBAUTHN_RP_ID: "grogoni.test",
      WEBAUTHN_EXPECTED_ORIGINS: "https://grogoni.test"
    }
  }
);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
