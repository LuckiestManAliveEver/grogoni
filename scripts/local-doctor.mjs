import net from "node:net";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { URL } from "node:url";

const apiRequire = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Pool } = apiRequire("pg");

const rootEnv = readEnvFile(".env.local");
const env = { ...rootEnv, ...process.env };
const apiPort = Number(env.API_PORT || env.PORT || 4000);
const webPort = Number(env.WEB_PORT || env.VITE_PORT || 5173);
const ollamaBaseUrl = (env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/u, "");
const ollamaModel = env.OLLAMA_MODEL || "smollm2:360m";

const checks = [];
const optional = [];

console.log("Grogoni Local Doctor\n");

await record(checks, "Node 22.19+", async () => {
  const major = Number(process.versions.node.split(".")[0]);
  if (major !== 22) throw new Error(`found ${process.versions.node}`);
  return process.versions.node;
});

await record(checks, "pnpm", async () => {
  const userAgent = process.env.npm_config_user_agent || "";
  const match = userAgent.match(/pnpm\/([^\s]+)/u);
  if (match) return match[1];
  return execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim();
});

await record(checks, ".env.local", async () => {
  if (!existsSync(".env.local")) throw new Error("copy .env.local.example to .env.local");
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is missing");
  return "present";
});

await record(checks, "Neon Postgres", async () => {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is missing");
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000
  });
  try {
    await pool.query("select 1");
    return "reachable";
  } finally {
    await pool.end();
  }
});

await record(checks, "Ollama", async () => {
  const response = await fetch(new URL("/api/tags", ollamaBaseUrl), {
    signal: globalThis.AbortSignal.timeout(3000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return ollamaBaseUrl;
});

await record(checks, ollamaModel, async () => {
  const response = await fetch(new URL("/api/tags", ollamaBaseUrl), {
    signal: globalThis.AbortSignal.timeout(3000)
  });
  const body = await response.json();
  const installed = (body.models || []).some((model) => model.name === ollamaModel);
  if (!installed) throw new Error(`run: ollama pull ${ollamaModel}`);
  return "installed";
});

await record(checks, `API port ${apiPort}`, () => assertPortAvailable(apiPort));
await record(checks, `Web port ${webPort}`, () => assertPortAvailable(webPort));

await record(optional, "cache", async () => "memory");

print(checks);
console.log("\nOptional capabilities\n");
print(optional, true);

const failed = checks.filter((check) => !check.ok);
console.log(failed.length === 0 ? "\nREADY" : "\nNOT READY");
process.exitCode = failed.length === 0 ? 0 : 1;

async function record(list, label, fn) {
  try {
    list.push({ label, ok: true, detail: await fn() });
  } catch (error) {
    list.push({ label, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

function print(list, optional = false) {
  for (const item of list) {
    const mark = item.ok ? "✓" : optional ? "○" : "✗";
    console.log(`${mark} ${item.label}${item.detail ? ` - ${item.detail}` : ""}`);
  }
}

function assertPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => reject(new Error("already in use")));
    server.once("listening", () => server.close(() => resolve("available")));
    server.listen(port, "127.0.0.1");
  });
}

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1).replace(/^"|"$/gu, "")];
      })
  );
}
