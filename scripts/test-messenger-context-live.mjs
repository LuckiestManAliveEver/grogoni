/** Full queue -> runtime -> real provider -> durable origin reply, on disposable LOCAL data only. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { URL } from "node:url";
import { writeFile, mkdir } from "node:fs/promises";
import { createCp2Store } from "../services/api/src/cp2/store.ts";
import { saveTransactionalCp2Snapshot } from "../services/api/src/cp2/postgres-store.ts";
import { createEdgeStoreDependencies } from "../services/api/src/edge-store-dependencies.ts";
import { createEdgeDomainRoutes } from "../services/api/src/edge-domain-routes.ts";
import { deleteLiveFixtureAccounts } from "./live-fixture-cleanup.mjs";
if (!process.argv.includes("--live")) throw new Error("Pass --live to invoke the real model provider.");
const url = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
if (!url || !["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname)) throw new Error("A disposable local PostgreSQL test database is required.");
if (!process.env.OPENROUTER_API_KEY) throw new Error("The existing provider credential is required.");
const { Pool } = createRequire(new URL("../services/api/package.json", import.meta.url))("pg");
const pool = new Pool({ connectionString: url, max: 3 });
const runId = randomUUID(); const evidence = { runId, checks: [] }; let actor;
async function transaction(action) {
  const client = await pool.connect();
  try { await client.query("begin"); const result = await action(client); await client.query("commit"); return result; }
  catch (error) { await client.query("rollback").catch(() => {}); throw error; }
  finally { client.release(); }
}
async function app() { return createEdgeDomainRoutes({ transaction, approvalTransaction: transaction, daemon: { queue: pool, hint: null, findUser: async () => ({ userId: actor.user.id }) } }); }
async function call(runtime, path, body, daemon = false) {
  const request = new Request("http://localhost/api" + path, { method: body ? "POST" : "GET", headers: { cookie: `grogoni_session=${actor.session.id}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const response = await (daemon ? runtime.daemonRoutes : runtime.routes)(request, path);
  assert.ok(response, "No route for " + path); const data = await response.json();
  assert.ok(response.ok, `${path} HTTP ${response.status}: ${data.code ?? ""}`); return data;
}
async function turn(runtime, id, message, key) {
  await call(runtime, "/v1/messages", { conversationId: id, clientMessageId: key, content: { type: "text", text: message } });
  const { task } = await call(runtime, "/v1/daemon/tasks", { key, message, conversation: { id, clientMessageId: key, scope: JSON.stringify(["marketplace", null, id]), kind: "reply" } }, true);
  const { claim } = await call(runtime, "/v1/daemon/claims", {}, true); assert.equal(claim.task.id, task.id);
  const { task: result } = await call(runtime, `/v1/daemon/claims/${task.id}/execute`, { leaseToken: claim.leaseToken }, true);
  assert.equal(result.status, "completed", result.errorCode); return result;
}
let failure;
try {
  const store = createCp2Store(createEdgeStoreDependencies()); const baseline = store.snapshot();
  actor = store.continueWithChannelPin({ channel: "email", destination: `context-${runId}@example.invalid`, pin: "1234" });
  const id = store.getGrogoniSessionContext({ sessionId: actor.session.id }).conversationId;
  await transaction((client) => saveTransactionalCp2Snapshot(client, store.snapshot(), baseline));
  const code = `BLUE-${runId.slice(0, 8)}`;
  const firstRuntime = await app();
  const first = await turn(firstRuntime, id, `Remember the code ${code}. Reply briefly to confirm. Do not call tools.`, `context-first-${runId}`);
  evidence.checks.push({ check: "real daemon inference", modelId: first.result.modelId, passed: true });
  // A fresh domain/runtime must reconstruct context solely from persisted messaging records.
  const restarted = await app();
  const second = await turn(restarted, id, "What exact code did I ask you to remember? Reply with the code only. Do not call tools.", `context-second-${runId}`);
  assert.ok(second.result.text.includes(code), "Restarted model did not recall the persisted code.");
  const thread = await call(restarted, `/v1/conversations/${id}`);
  assert.ok(thread.messages.some((message) => message.author === "agent" && message.content?.text?.includes(code)), "Durable reply is absent.");
  evidence.checks.push({ check: "semantic context recall after runtime restart and server projection", modelId: second.result.modelId, passed: true });
} catch (error) { failure = error; evidence.error = error.message; }
finally {
  if (actor) await transaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext('grogoni.cp2.normalized_store'))");
    await deleteLiveFixtureAccounts(client, { accountIds: [actor.account.id] });
    const remaining = await client.query("select count(*)::int n from accounts where id=$1", [actor.account.id]);
    assert.equal(remaining.rows[0].n, 0); evidence.cleanupVerified = true;
  });
  await pool.end(); await mkdir("/tmp/grogoni-messenger-context-live", { recursive: true });
  await writeFile("/tmp/grogoni-messenger-context-live/report.json", JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify(evidence)); if (failure) throw failure;
