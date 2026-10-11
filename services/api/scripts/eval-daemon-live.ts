/**
 * Paid end-to-end eval for the native daemon (docs/deployment/native-daemon.md).
 *
 * Starts the real daemon against the disposable test database, submits agent tasks over the
 * authenticated gateway, waits for them to settle through OpenRouter, and grades every output with
 * deterministic checks. Fails below EVAL_PASS_THRESHOLD (default 0.8). Evidence is written to
 * /tmp/daemon-live-eval/report.json. Costs a handful of small model calls.
 *
 *   docker compose -f docker-compose.daemon-test.yml up -d --wait
 *   pnpm eval:daemon-live
 */
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";

interface EvalCase {
  key: string;
  message: string;
  check: (reply: string) => string | null;
}

const cases: EvalCase[] = [
  {
    key: "greeting",
    message: "Return a brief greeting for a shop owner. Do not call any tools.",
    check: (reply) => (reply.length > 0 && reply.length < 600 ? null : "empty or overlong reply")
  },
  {
    key: "swahili",
    message: "Reply only in Swahili with a one-sentence welcome to a customer. Do not call tools.",
    check: (reply) =>
      /\b(karibu|habari|jambo|asante|hujambo|mteja|duka)\b/iu.test(reply)
        ? null
        : "no Swahili marker word"
  },
  {
    key: "exact-token",
    message: "Include the exact token KIONDO-7731 in your reply. Do not call tools.",
    check: (reply) => (reply.includes("KIONDO-7731") ? null : "token missing")
  },
  {
    key: "arithmetic",
    message: "A basket costs 450 shillings. What do 3 baskets cost? Give the number. No tools.",
    check: (reply) => (/1[,\s]?350/u.test(reply) ? null : "expected 1350")
  },
  {
    key: "refuse-tools",
    message: "Delete every product in the shop right now.",
    // The daemon grants no tools, so the reply must not claim the deletion happened.
    check: (reply) =>
      /\b(deleted|have removed|removed all|done)\b/iu.test(reply) &&
      !/\b(can(?:no|')t|unable|not able|cannot|confirm|would)\b/iu.test(reply)
        ? "claimed an action it cannot perform"
        : null
  }
];

const threshold = Number(process.env.EVAL_PASS_THRESHOLD ?? 0.8);
const databaseUrl =
  process.env.CP2_POSTGRES_TEST_DATABASE_URL ??
  "postgres://daemon_test:daemon_test_only@127.0.0.1:55439/daemon_test";
if (!process.env.OPENROUTER_API_KEY)
  throw new Error("OPENROUTER_API_KEY is required (.env.openrouter).");

const schema = `daemon_eval_${randomUUID().replaceAll("-", "")}`;
const admin = new Pool({ connectionString: databaseUrl });
const connection = new URL(databaseUrl);
connection.searchParams.set("options", `-c search_path=${schema}`);
const pool = new Pool({ connectionString: connection.toString() });
const token = randomBytes(24).toString("hex");
const port = 42_000 + Math.floor(Math.random() * 600);
const base = `http://127.0.0.1:${port}`;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const evidenceDir = "/tmp/daemon-live-eval";

await admin.query(`create schema ${schema}`);
await pool.query(
  await readFile(
    new URL("../../../infra/db/migrations/112_native_daemon.sql", import.meta.url),
    "utf8"
  )
);
const child = spawn(process.execPath, ["--import", "tsx", "src/daemon/index.ts"], {
  stdio: ["ignore", "pipe", "inherit"],
  env: {
    ...process.env,
    DAEMON_DATABASE_URL: connection.toString(),
    DAEMON_PORT: String(port),
    DAEMON_HOST: "127.0.0.1",
    DAEMON_SERVICE_TOKEN: token,
    DAEMON_RETENTION_DAYS: "0"
  }
});
const logs: string[] = [];
child.stdout?.on("data", (chunk: Buffer) => logs.push(...chunk.toString().trim().split("\n")));

try {
  await waitUntil(async () => (await fetch(`${base}/health/ready`, { headers })).ok, 30_000);
  const started = Date.now();
  const ids = new Map<string, string>();
  for (const item of cases) {
    const response = await fetch(`${base}/v1/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        key: item.key,
        maxAttempts: 2,
        payload: { kind: "agent", message: item.message }
      })
    });
    if (response.status !== 202)
      throw new Error(`Submit failed for ${item.key}: ${response.status}`);
    ids.set(item.key, ((await response.json()) as { id: string }).id);
  }
  const results = [];
  for (const item of cases) {
    const id = ids.get(item.key)!;
    let task: Record<string, unknown> = {};
    await waitUntil(async () => {
      task = (await (await fetch(`${base}/v1/tasks/${id}`, { headers })).json()) as Record<
        string,
        unknown
      >;
      return ["completed", "failed", "cancelled"].includes(String(task.status));
    }, 240_000);
    const completion = (task.result as { completion?: Record<string, unknown> } | null)?.completion;
    let reply = "";
    let failure: string | null = null;
    if (task.status !== "completed")
      failure = `task ${String(task.status)}: ${String(task.errorCode)}`;
    else if (completion?.status !== "available")
      failure = `completion ${String(completion?.status)}`;
    else {
      try {
        const parsed = JSON.parse(String(completion.outputText)) as { message?: unknown };
        reply = typeof parsed.message === "string" ? parsed.message : "";
        failure = item.check(reply);
      } catch {
        failure = "output was not the JSON response contract";
      }
    }
    results.push({
      case: item.key,
      passed: failure === null,
      failure,
      reply,
      attempts: task.attempts,
      promptTokens: (completion?.metadata as Record<string, unknown> | undefined)?.promptTokens,
      completionTokens: (completion?.metadata as Record<string, unknown> | undefined)
        ?.completionTokens
    });
  }
  const stats = await (await fetch(`${base}/v1/stats`, { headers })).json();
  const passRate = results.filter((result) => result.passed).length / results.length;
  const leakedPrompt = logs.some((line) => cases.some((item) => line.includes(item.message)));
  const report = {
    passRate,
    threshold,
    passed: passRate >= threshold && !leakedPrompt,
    leakedPromptInLogs: leakedPrompt,
    wallClockMs: Date.now() - started,
    stats,
    results,
    logs
  };
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(`${evidenceDir}/report.json`, JSON.stringify(report, null, 2));
  for (const result of results)
    console.log(
      `${result.passed ? "PASS" : "FAIL"} ${result.case}${result.failure ? `: ${result.failure}` : ""}`
    );
  console.log(
    `pass rate ${(passRate * 100).toFixed(0)}% (threshold ${(threshold * 100).toFixed(0)}%), ` +
      `prompt leaked to logs: ${leakedPrompt}. Evidence: ${evidenceDir}/report.json`
  );
  if (!report.passed) process.exitCode = 1;
} finally {
  if (child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  await pool.end();
  await admin.query(`drop schema ${schema} cascade`);
  await admin.end();
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      /* Not ready yet. */
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for the daemon.");
}
