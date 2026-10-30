/** Live guest model smoke test. Creates one disposable device account and removes it afterward. */
import assert from "node:assert/strict";
import { randomUUID, webcrypto } from "node:crypto";
import { URL } from "node:url";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { deleteLiveFixtureAccounts } from "./live-fixture-cleanup.mjs";

if (!process.argv.includes("--live")) throw new Error("Pass --live to verify production.");
const databaseUrl = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
assert.ok(databaseUrl, "A database connection is required to remove the disposable account.");
const { Client } = createRequire(new URL("../services/api/package.json", import.meta.url))("pg");
const base = process.env.SMOKE_API_URL ?? "https://grogoni.com/api";
const runId = randomUUID();
const out = `/tmp/guest-chat-production/${runId}`;
const report = { runId, base, startedAt: new Date().toISOString(), steps: [] };
let cookie = "";
let accountId;
let conversationId;

async function call(path, body) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      origin: "https://grogoni.com",
      cookie,
      "content-type": "application/json",
      "x-grogoni-device-id": `guest-smoke-${runId}`,
      "idempotency-key": randomUUID()
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: globalThis.AbortSignal.timeout(120_000)
  });
  const json = await response.json();
  assert.ok(response.ok, `${path}: HTTP ${response.status} ${json.code ?? json.message ?? ""}`);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) {
    const jar = new Map(
      cookie
        .split("; ")
        .filter(Boolean)
        .map((value) => {
          const at = value.indexOf("=");
          return [value.slice(0, at), value.slice(at + 1)];
        })
    );
    for (const value of cookies) {
      const pair = value.split(";")[0];
      const at = pair.indexOf("=");
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    cookie = [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
  }
  return json;
}

async function step(name, action) {
  try {
    const detail = await action();
    report.steps.push({ name, passed: true, detail });
    console.log(`PASS ${name}: ${JSON.stringify(detail)}`);
    return detail;
  } catch (error) {
    report.steps.push({ name, passed: false, error: error.message });
    throw error;
  }
}

async function turn(message, label) {
  const clientMessageId = `guest-smoke-${label}-${runId}`;
  await call("/v1/messages", {
    conversationId,
    clientMessageId,
    content: { type: "text", text: message }
  });
  const { task } = await call("/v1/daemon/tasks", {
    key: clientMessageId,
    message,
    conversation: {
      id: conversationId,
      clientMessageId,
      scope: JSON.stringify(["marketplace", null, conversationId]),
      kind: "reply"
    }
  });
  assert.equal(task.payload.conversation.id, conversationId);
  const { claim } = await call("/v1/daemon/claims", {});
  assert.equal(claim?.task?.id, task.id);
  const { task: completed } = await call(`/v1/daemon/claims/${task.id}/execute`, {
    leaseToken: claim.leaseToken
  });
  assert.equal(completed.status, "completed", completed.errorCode);
  assert.equal(completed.result.executedBy, "server");
  assert.ok(completed.result.text?.trim());
  const restored = await call(`/v1/daemon/tasks/${task.id}`);
  assert.equal(restored.task.result.text, completed.result.text);
  const thread = await call(`/v1/conversations/${conversationId}`);
  assert.equal(
    thread.messages.filter((item) => item.clientMessageId === clientMessageId).length,
    1
  );
  assert.ok(
    thread.messages.some(
      (item) => item.author === "agent" && item.content?.text === completed.result.text
    )
  );
  return {
    modelId: completed.result.modelId,
    text: completed.result.text,
    executedBy: completed.result.executedBy
  };
}

await mkdir(out, { recursive: true });
try {
  await step("device account without signup or shop", async () => {
    const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify"
    ]);
    const devicePublicKeyJwk = await webcrypto.subtle.exportKey("jwk", keys.publicKey);
    const session = await call("/auth/continue", { devicePublicKeyJwk });
    accountId = session.account.id;
    assert.equal(session.account.identityLevel, "device");
    const context = await call("/v1/session/context");
    conversationId = context.conversationId;
    assert.ok(conversationId);
    return { accountId, conversationId };
  });
  const marker = `RAINBOW-${runId.slice(0, 8)}`;
  await step("real model explains a question and persists its reply", async () => {
    const result = await turn(
      `Remember the token ${marker}. Briefly explain why a rainbow forms, and include the token in your answer.`,
      "question"
    );
    assert.ok(result.text.includes(marker));
    assert.match(result.text, /light|refract|reflect|water|droplet/i);
    return result;
  });
  await step("follow-up restores conversation context through the real model", async () => {
    const result = await turn(
      "What exact token did I ask you to remember? Reply with only that token.",
      "followup"
    );
    assert.ok(result.text.includes(marker));
    return result;
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (accountId) {
    await step("remove disposable account and its conversations and tasks", async () => {
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query("begin");
        await client.query(
          "select pg_advisory_xact_lock(hashtext('grogoni.cp2.normalized_store'))"
        );
        await deleteLiveFixtureAccounts(client, { accountIds: [accountId] });
        await client.query("commit");
        const remaining = await client.query("select id from accounts where id = $1", [accountId]);
        assert.equal(remaining.rowCount, 0);
        return { removed: true };
      } finally {
        await client.end();
      }
    }).catch((error) => {
      console.error(`Cleanup failed: ${error.message}`);
      process.exitCode = 1;
    });
  }
  report.passed = !process.exitCode;
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(`Evidence: ${out}/report.json`);
}
