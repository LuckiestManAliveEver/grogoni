// Paid eval: agent replies stay correct across the send/turn split (instant-messaging checklist,
// Phase 5). On Edge a message is accepted at once and its agent turn runs afterwards; the client
// long-polls /v1/agent-turns/:id for the reply. This drives that exact path, the real Edge
// pipeline (createEdgeDomainRoutes) on PostgreSQL with the platform default model through
// OpenRouter, and scores every reply with deterministic checks.
//
// Run: pnpm eval:agent-turn-split [--report <path>]
//   OPENROUTER_API_KEY            from .env.openrouter (as the other paid evals)
//   EVAL_DATABASE_URL             a disposable, migrated PostgreSQL database
//                                 (default CP2_POSTGRES_TEST_DATABASE_URL); a remote host is
//                                 refused unless EVAL_ALLOW_REMOTE_DATABASE=true
// Exit 0 = pass, 1 = below threshold or an integrity case failed, 2 = not run.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { Pool as PgPool, PoolClient } from "pg";
import { createCp2Store } from "../services/api/src/cp2/store.ts";
import { saveTransactionalCp2Snapshot } from "../services/api/src/cp2/postgres-store.ts";
import { createEdgeDomainRoutes } from "../services/api/src/edge-domain-routes.ts";

const passThreshold = 0.8;
const replyLimitMs = 120_000;
const reportFlag = process.argv.indexOf("--report");
const reportPath =
  reportFlag === -1 ? "/tmp/agent-turn-split/eval/report.json" : process.argv[reportFlag + 1]!;
const write = (report: unknown) => {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${reportPath}`);
};

const databaseUrl =
  process.env.EVAL_DATABASE_URL?.trim() || process.env.CP2_POSTGRES_TEST_DATABASE_URL?.trim();
if (!process.env.OPENROUTER_API_KEY?.trim()) {
  write({ status: "not_run", reason: "OPENROUTER_API_KEY is not set." });
  process.exit(2);
}
if (!databaseUrl) {
  write({
    status: "not_run",
    reason: "EVAL_DATABASE_URL (or CP2_POSTGRES_TEST_DATABASE_URL) is not set."
  });
  process.exit(2);
}
const host = new URL(databaseUrl).hostname;
if (
  !["localhost", "127.0.0.1", "::1"].includes(host) &&
  process.env.EVAL_ALLOW_REMOTE_DATABASE !== "true"
) {
  // It writes a shop, an account and conversations: never against a shared database by accident.
  write({ status: "not_run", reason: `Refusing remote database host ${host}.` });
  process.exit(2);
}

const requireApi = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Pool } = requireApi("pg") as { Pool: typeof PgPool };
const pool = new Pool({ connectionString: databaseUrl, max: 6 });
async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout = '10s'");
    await client.query(
      "select pg_advisory_xact_lock_shared(hashtext('grogoni.cp2.normalized_store'))"
    );
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

// A shop with known stock: Blueband in stock at a known price, sugar sold out.
const store = createCp2Store();
const baseline = store.snapshot();
const owner = store.continueWithChannelPin({
  channel: "email",
  destination: `turn-split-eval-${randomUUID()}@example.invalid`,
  pin: "3927"
});
const businessId = store.createBusiness({
  sessionId: owner.session.id,
  name: `Turn split eval ${randomUUID().slice(0, 8)}`,
  language: "en",
  phoneNumber: `+2547${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
  phoneCountry: "KE"
}).business.id;
const newChat = () =>
  store.createConversation({
    sessionId: owner.session.id,
    kind: "personal",
    activeShopId: businessId
  }).conversation.id;
const chats = { stock: newChat(), soldOut: newChat(), burst: newChat() };
await transaction((client) => saveTransactionalCp2Snapshot(client, store.snapshot(), baseline));
const edge = await createEdgeDomainRoutes({ transaction });

/** The parts of a message or agent-turn response this eval reads. */
interface TurnBody {
  id?: string;
  agentMessage?: { id?: string; content?: { text?: string } };
  processing?: { status?: string; turnId?: string };
}

async function call(path: string, method: string, body?: unknown) {
  const response = await edge.routes(
    new Request(`https://grogoni.com${path}`, {
      method,
      headers: {
        cookie: `grogoni_session=${owner.session.id}`,
        "content-type": "application/json"
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }),
    path.split("?")[0]!
  );
  if (response === null) throw new Error(`No route for ${method} ${path}`);
  return {
    status: response.status,
    body: (await response.json().catch(() => null)) as TurnBody | null
  };
}

// Created through the Edge API, as the app does: writing them in the in-memory store first would
// number their sync-journal rows from 1 and collide with an earlier run's in a shared database.
for (const product of [
  {
    name: "Blueband 500g",
    sku: `BLUEBAND-${randomUUID().slice(0, 6)}`,
    quantity: 12,
    sellingPrice: 250
  },
  { name: "Sugar 2kg", sku: `SUGAR-${randomUUID().slice(0, 6)}`, quantity: 0, sellingPrice: 380 }
]) {
  const created = await call(`/businesses/${businessId}/products`, "POST", {
    ...product,
    unit: "item",
    buyingPrice: Math.round(product.sellingPrice * 0.8)
  });
  if (created.status !== 200) throw new Error(`product setup answered ${created.status}`);
}

interface Sent {
  clientMessageId: string;
  ackMs: number;
  accepted: TurnBody | null;
}
async function send(
  conversationId: string,
  text: string,
  clientMessageId: string = randomUUID()
): Promise<Sent> {
  const started = Date.now();
  const response = await call("/v1/messages", "POST", {
    conversationId,
    clientMessageId,
    content: { type: "text", text },
    agent: { businessId, message: text }
  });
  if (response.status !== 200) throw new Error(`send answered ${response.status}`);
  return { clientMessageId, ackMs: Date.now() - started, accepted: response.body };
}
/** The reply text, long-polling the turn as the web client does. */
async function reply(
  sent: Sent
): Promise<{ text: string; replyMs: number; replyId: string | null }> {
  const started = Date.now();
  const immediate = sent.accepted?.agentMessage;
  if (immediate)
    return {
      text: String(immediate.content?.text ?? ""),
      replyMs: 0,
      replyId: immediate.id ?? null
    };
  const turnId = sent.accepted?.processing?.turnId;
  if (!turnId) return { text: "", replyMs: 0, replyId: null };
  while (Date.now() - started < replyLimitMs) {
    const polled = await call(`/v1/agent-turns/${turnId}?waitMs=10000`, "GET");
    const status = polled.body?.processing?.status;
    if (status === "completed")
      return {
        text: String(polled.body?.agentMessage?.content?.text ?? ""),
        replyMs: Date.now() - started,
        replyId: polled.body?.agentMessage?.id ?? null
      };
    if (status === "failed") return { text: "", replyMs: Date.now() - started, replyId: null };
  }
  return { text: "", replyMs: Date.now() - started, replyId: null };
}

const refusal =
  /\b(not|no|out of stock|sold out|unavailable|don'?t|do not|isn'?t|aren'?t|none|zero|0)\b/iu;
interface Result {
  id: string;
  integrity: boolean;
  passed: boolean;
  failure: string | null;
  ackMs: number[];
  replyMs: number[];
  replies: string[];
}
const results: Result[] = [];
async function evaluate(
  id: string,
  integrity: boolean,
  run: () => Promise<Omit<Result, "id" | "integrity" | "passed">>
) {
  try {
    const outcome = await run();
    results.push({ id, integrity, passed: outcome.failure === null, ...outcome });
  } catch (error) {
    results.push({
      id,
      integrity,
      passed: false,
      failure: `error: ${error instanceof Error ? error.message : String(error)}`,
      ackMs: [],
      replyMs: [],
      replies: []
    });
  }
  const last = results.at(-1)!;
  console.log(`${last.passed ? "PASS" : "FAIL"} ${id}${last.failure ? ` (${last.failure})` : ""}`);
}

let stockQuestion: Sent | null = null;
let stockReplyId: string | null = null;
await evaluate("stock-and-price", false, async () => {
  stockQuestion = await send(chats.stock, "What is the selling price of Blueband 500g?");
  const answer = await reply(stockQuestion);
  stockReplyId = answer.replyId;
  const text = answer.text.toLowerCase();
  return {
    failure: !text ? "no reply" : !text.includes("250") ? "price 250 missing" : null,
    ackMs: [stockQuestion.ackMs],
    replyMs: [answer.replyMs],
    replies: [answer.text]
  };
});

await evaluate("follow-up-uses-previous-turn", false, async () => {
  // "it" only makes sense with the previous turn in the model's history, and that turn asked for
  // the price only, so the quantity is not already in the conversation.
  const sent = await send(chats.stock, "How many of it are left?");
  const answer = await reply(sent);
  return {
    failure: !answer.text
      ? "no reply"
      : !/\b12\b|twelve/iu.test(answer.text)
        ? "quantity 12 missing"
        : null,
    ackMs: [sent.ackMs],
    replyMs: [answer.replyMs],
    replies: [answer.text]
  };
});

await evaluate("sold-out", false, async () => {
  const sent = await send(chats.soldOut, "Can I sell a customer Sugar 2kg right now?");
  const answer = await reply(sent);
  return {
    failure: !answer.text
      ? "no reply"
      : !refusal.test(answer.text)
        ? "does not say it is out of stock"
        : null,
    ackMs: [sent.ackMs],
    replyMs: [answer.replyMs],
    replies: [answer.text]
  };
});

await evaluate("two-quick-sends-keep-order", false, async () => {
  // The second send goes before the first reply arrives, as a fast typist's would.
  const first = await send(chats.burst, "Please remember this: my supplier's name is Wanjiru.");
  const second = await send(chats.burst, "What is my supplier's name?");
  const [, answer] = await Promise.all([reply(first), reply(second)]);
  return {
    failure: !answer.text
      ? "no reply"
      : !/wanjiru/iu.test(answer.text)
        ? "name from the earlier send missing"
        : null,
    ackMs: [first.ackMs, second.ackMs],
    replyMs: [answer.replyMs],
    replies: [answer.text]
  };
});

await evaluate("resend-runs-no-second-turn", true, async () => {
  // A resend of an answered message (the outbox after a dropped connection) returns that reply.
  if (stockQuestion === null || stockReplyId === null)
    return { failure: "no first reply to resend", ackMs: [], replyMs: [], replies: [] };
  const original = stockQuestion as Sent;
  const resent = await send(
    chats.stock,
    "What is the selling price of Blueband 500g?",
    original.clientMessageId
  );
  const again = await reply(resent);
  const turns = await pool.query<{ n: number }>(
    "select count(*)::int as n from agent_chat_turns where message_id = $1",
    [original.accepted?.id]
  );
  return {
    failure:
      again.replyId !== stockReplyId
        ? "resend got a different reply"
        : turns.rows[0]!.n !== 1
          ? `${turns.rows[0]!.n} turns for one message`
          : null,
    ackMs: [resent.ackMs],
    replyMs: [again.replyMs],
    replies: [again.text]
  };
});

await edge.settled();
await pool.end();
const passed = results.filter((result) => result.passed).length;
const passRate = passed / results.length;
const integrityFailed = results.some((result) => result.integrity && !result.passed);
const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
const median = (values: number[]) =>
  values.length ? sorted(values)[Math.floor(values.length / 2)]! : null;
const status = passRate >= passThreshold && !integrityFailed ? "pass" : "fail";
write({
  status,
  passRate,
  passThreshold,
  integrityFailed,
  medianAckMs: median(results.flatMap((result) => result.ackMs)),
  medianReplyMs: median(results.flatMap((result) => result.replyMs)),
  results,
  checkedAt: new Date().toISOString()
});
console.log(
  `Agent turn split eval: ${status} (${passed}/${results.length}, threshold ${passThreshold})`
);
process.exit(status === "pass" ? 0 : 1);
