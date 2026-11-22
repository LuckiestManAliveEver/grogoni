/**
 * Load test of the Edge message hint stream (`GET /v1/realtime/messages`) against a local
 * PostgreSQL. It runs the production code (`messageEventStream` and `findSessionUser` from
 * supabase/functions/api) for N concurrent streams, each with its own seeded account and session,
 * while a writer appends journal changes at a fixed rate. Every probe is the production pair: a
 * session check and a journal read in one query and one transaction (`sessionJournalProbe`).
 *
 * `--design separate` reproduces the earlier design (session check and journal read as two
 * transactions) for comparison. Reports probe rate, probe latency, delivery latency (journal write to `changed` event), pool
 * waits and the PostgreSQL container's CPU. Usage:
 *
 *   HINT_LOAD_DATABASE_URL=postgres://...@127.0.0.1:5432/grogoni_<name>_benchmark \
 *     pnpm exec tsx scripts/load-test-hint-stream.ts --streams 100 --seconds 30
 *
 * The database must be a local grogoni_*benchmark database: the script seeds and deletes rows.
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import type { Pool as PgPool } from "pg";
import {
  findSessionUser,
  sessionJournalProbe
} from "../supabase/functions/api/application-routes.ts";
import { messageEventStream } from "../supabase/functions/api/message-events.ts";
import type { SqlClient, Transaction } from "../supabase/functions/api/session-routes.ts";

const { values } = parseArgs({
  options: {
    streams: { type: "string", default: "100" },
    seconds: { type: "string", default: "30" },
    "writes-per-second": { type: "string", default: "20" },
    "pool-size": { type: "string", default: "40" },
    container: { type: "string", default: "grogoni-postgres-1" },
    // combined: the production probe (one transaction). separate: the earlier two transactions.
    design: { type: "string", default: "combined" }
  }
});
const streams = Number(values.streams);
const seconds = Number(values.seconds);
const writesPerSecond = Number(values["writes-per-second"]);
const poolSize = Number(values["pool-size"]);
const databaseUrl = process.env.HINT_LOAD_DATABASE_URL ?? "";
const parsed = new URL(databaseUrl);
if (
  !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
  !/^\/grogoni_[a-z0-9_]*benchmark$/u.test(parsed.pathname)
)
  throw new Error("HINT_LOAD_DATABASE_URL must be a local grogoni_*benchmark database.");

const requireApi = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Pool } = requireApi("pg") as { Pool: typeof PgPool };
const pool = new Pool({ connectionString: databaseUrl, max: poolSize });
let poolWaits = 0;
let transactions = 0;
const transaction: Transaction = async (action) => {
  if (pool.idleCount === 0 && pool.totalCount >= poolSize) poolWaits += 1;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await action(client as unknown as SqlClient);
    await client.query("commit");
    transactions += 1;
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

const runId = randomUUID().slice(0, 8);
const accounts: Array<{ accountId: string; sessionId: string }> = [];
async function seed() {
  for (let index = 0; index < streams; index++) {
    const accountId = randomUUID();
    const userId = randomUUID();
    const sessionId = randomUUID();
    await pool.query(
      `insert into accounts (id, primary_auth_channel, primary_auth_destination, created_at)
       values ($1, 'email', $2, now())`,
      [accountId, `hint-load-${runId}-${index}@example.invalid`]
    );
    await pool.query(
      `insert into users (id, account_id, display_name, language, created_at)
       values ($1, $2, 'Load test', 'en', now())`,
      [userId, accountId]
    );
    await pool.query(
      `insert into sessions (id, account_id, user_id, expires_at, created_at, device_id, device_name,
         platform, browser_or_app, user_agent_hash, refresh_token_hash, session_family_id,
         refresh_expires_at, last_used_at, inactivity_expires_at, absolute_expires_at, authenticated_at)
       values ($1, $2, $3, now() + interval '1 day', now(), 'load', 'load', 'web', 'load', 'x', $4,
         $5, now() + interval '1 day', now(), now() + interval '1 day', now() + interval '1 day', now())`,
      [sessionId, accountId, userId, `hash-${sessionId}`, randomUUID()]
    );
    accounts.push({ accountId, sessionId });
  }
}

async function cleanup() {
  const ids = accounts.map((account) => account.accountId);
  await pool.query("delete from account_sync_changes where account_id = any($1::uuid[])", [ids]);
  await pool.query("delete from sessions where account_id = any($1::uuid[])", [ids]);
  await pool.query("delete from users where account_id = any($1::uuid[])", [ids]);
  await pool.query("delete from accounts where id = any($1::uuid[])", [ids]);
}

const sequences = new Map<string, number>();
const deliveries: number[] = [];
let written = 0;
async function writeChange() {
  const account = accounts[Math.floor(Math.random() * accounts.length)]!;
  const sequence = (sequences.get(account.accountId) ?? 0) + 1;
  sequences.set(account.accountId, sequence);
  await pool.query(
    `insert into account_sync_changes (account_id, sequence, cursor, collection, entity_id, operation, entity, changed_at)
     values ($1, $2, $3, 'conversation_messages', $4, 'upsert', $5, now())`,
    [account.accountId, sequence, randomUUID(), randomUUID(), { conversationId: `c-${Date.now()}` }]
  );
  written += 1;
}

async function followStream(
  account: { accountId: string; sessionId: string },
  signal: AbortSignal
) {
  const request = new Request("https://grogoni.invalid/v1/realtime/messages", {
    headers: { cookie: `grogoni_session=${account.sessionId}` },
    signal
  });
  const response = await messageEventStream(
    request,
    transaction,
    async () => {
      const user = await transaction((client) => findSessionUser(client, request));
      if (user === null) throw new Error("session rejected");
      return user.accountId;
    },
    {
      durationMs: seconds * 1000 + 5_000,
      ...(values.design === "separate" ? {} : { probe: sessionJournalProbe(request) })
    }
  );
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (!event.includes("event: changed")) continue;
        const data = JSON.parse(event.split("data: ")[1]!) as { conversationIds: string[] };
        for (const id of data.conversationIds) deliveries.push(Date.now() - Number(id.slice(2)));
      }
    }
  } catch {
    /* Aborted at the end of the run. */
  }
}

async function containerCpu(): Promise<number | null> {
  try {
    const { stdout } = await promisify(execFile)("docker", [
      "stats",
      "--no-stream",
      "--format",
      "{{.CPUPerc}}",
      values.container!
    ]);
    return Number.parseFloat(stdout.trim());
  } catch {
    return null;
  }
}

const percentile = (items: number[], p: number) => {
  if (items.length === 0) return null;
  const sorted = [...items].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};

await seed();
const idleCpu = await containerCpu();
const controller = new AbortController();
const started = Date.now();
const followers = accounts.map((account) => followStream(account, controller.signal));
const writer = setInterval(() => void writeChange().catch(() => undefined), 1000 / writesPerSecond);
const cpu: number[] = [];
const warmUpMs = Math.min(5_000, (seconds * 1000) / 4);
let transactionsAtWarm = 0;
let warmAt = 0;
while (Date.now() - started < seconds * 1000) {
  const sample = await containerCpu();
  const elapsed = Date.now() - started;
  if (warmAt === 0 && elapsed >= warmUpMs) {
    warmAt = Date.now();
    transactionsAtWarm = transactions;
  }
  if (sample !== null && elapsed >= warmUpMs) cpu.push(sample);
}
const steadySeconds = (Date.now() - warmAt) / 1000;
const steadyTransactions = transactions - transactionsAtWarm;
clearInterval(writer);
controller.abort();
await Promise.allSettled(followers);
await cleanup();
await pool.end();

console.log(
  JSON.stringify(
    {
      streams,
      seconds,
      writesPerSecond,
      poolSize,
      transactionsPerSecond: Math.round(steadyTransactions / steadySeconds),
      design: values.design,
      probesPerSecond: Math.round(
        steadyTransactions / (values.design === "separate" ? 2 : 1) / steadySeconds
      ),
      changesWritten: written,
      changesDelivered: deliveries.length,
      deliveryMs: { p50: percentile(deliveries, 50), p95: percentile(deliveries, 95) },
      poolWaits,
      postgresCpuPercent: {
        idle: idleCpu,
        median: percentile(cpu, 50),
        max: cpu.length ? Math.max(...cpu) : null
      }
    },
    null,
    2
  )
);
