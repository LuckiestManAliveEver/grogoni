/**
 * Local load measurement for the account hint stream (supabase/functions/api/message-events.ts).
 * Opens N concurrent streams against a PostgreSQL database and reports database transactions
 * per second and journal-probe latency. It measures this machine's PostgreSQL, not Neon or the
 * Edge runtime: use it to compare designs, not to predict production cost.
 *
 *   DATABASE_URL=postgres://... pnpm exec tsx scripts/measure-hint-stream-load.ts 100 1000
 */
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { messageEventStream } from "../supabase/functions/api/message-events";
import type { Transaction } from "../supabase/functions/api/session-routes";

const requireApi = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Pool } = requireApi("pg");
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required.");
const counts = process.argv
  .slice(2)
  .map(Number)
  .filter((value) => value > 0);
const durationMs = Number(process.env.HINT_LOAD_DURATION_MS ?? 10_000);

for (const streams of counts.length ? counts : [100, 1000]) {
  for (const [label, reauthorizeEveryMs] of [
    ["recheck session every probe", 0],
    ["recheck session every 5 s", 5_000]
  ] as const) {
    const pool = new Pool({ connectionString: url, max: 40 });
    let transactions = 0;
    const probeMs: number[] = [];
    const transaction: Transaction = async (work) => {
      const client = await pool.connect();
      const started = performance.now();
      try {
        await client.query("begin");
        const result = await work(client);
        await client.query("commit");
        transactions += 1;
        probeMs.push(performance.now() - started);
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    };
    const accounts = Array.from({ length: streams }, () => randomUUID());
    // The session check the Edge stream runs (actor()): one indexed lookup per recheck.
    const authorize = (accountId: string) => async () =>
      (await transaction((db) => db.query("select $1::text as id", [accountId]))).rows[0].id;
    const controller = new AbortController();
    const started = performance.now();
    const responses = await Promise.all(
      accounts.map((accountId) =>
        messageEventStream(
          new Request("https://load.invalid/v1/realtime/messages?since=0", {
            signal: controller.signal
          }),
          transaction,
          authorize(accountId),
          { durationMs, intervalMs: 500, reauthorizeEveryMs }
        )
      )
    );
    await Promise.all(responses.map((response) => response.text()));
    const seconds = (performance.now() - started) / 1000;
    probeMs.sort((a, b) => a - b);
    const pct = (p: number) =>
      probeMs[Math.min(probeMs.length - 1, Math.floor(probeMs.length * p))]!;
    console.log(
      JSON.stringify({
        streams,
        design: label,
        seconds: Number(seconds.toFixed(1)),
        transactionsPerSecond: Math.round(transactions / seconds),
        perStreamPerSecond: Number((transactions / seconds / streams).toFixed(2)),
        txP50Ms: Number(pct(0.5).toFixed(1)),
        txP95Ms: Number(pct(0.95).toFixed(1)),
        txP99Ms: Number(pct(0.99).toFixed(1))
      })
    );
    await pool.end();
  }
}
