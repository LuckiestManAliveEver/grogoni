/** Live acceptance checks using only accounts created by this run. */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
/* global AbortSignal */
import { generateKeyPairSync, randomBytes, randomInt, randomUUID, sign } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { databasePoolConfig } from "../services/api/scripts/database-connection.mjs";
import { deleteLiveFixtureAccounts } from "./live-fixture-cleanup.mjs";
if (!process.argv.includes("--live"))
  throw new Error("Pass --live to run disposable live fixtures.");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for fixture cleanup.");
const base = process.env.SMOKE_API_URL ?? "https://grogoni.com/api";
const out = process.env.SMOKE_OUT ?? "/tmp/grogoni-recovery-chat-live";
const require = createRequire(new URL("../services/api/package.json", import.meta.url));
const { Pool } = require("pg");
const pool = new Pool({ ...databasePoolConfig(process.env.DATABASE_URL), max: 1 });
const accounts = new Set();
const checks = [];
await mkdir(out, { recursive: true });
const device = `live-recovery-${randomUUID()}`;
const report = { base, startedAt: new Date().toISOString(), checks };
async function call(cookie, path, payload) {
  const options = {
    method: payload === undefined ? "GET" : "POST",
    headers: {
      origin: "https://grogoni.com",
      cookie,
      "x-grogoni-device-id": device,
      "idempotency-key": randomBytes(32).toString("base64url"),
      ...(payload === undefined ? {} : { "content-type": "application/json" })
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(120000)
  };
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetch(base + path, options);
      break;
    } catch (error) {
      // Continue's stable idempotency key makes a transport retry safe.
      if (path !== "/auth/continue" || attempt === 2) throw error;
    }
  }
  return {
    status: response.status,
    data: await response.json(),
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ")
  };
}
function ok(response) {
  assert.ok(
    response.status === 200 || response.status === 201,
    `HTTP ${response.status}: ${JSON.stringify(response.data).slice(0, 500)}`
  );
  return response.data;
}
async function check(name, fn) {
  try {
    const detail = await fn();
    checks.push({ name, passed: true, detail });
    console.log("PASS", name, JSON.stringify(detail));
  } catch (error) {
    checks.push({ name, passed: false, error: error.message });
    console.log("FAIL", name, error.message);
  }
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
}
function keyPair() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { ...pair, publicKeyJwk: pair.publicKey.export({ format: "jwk" }) };
}
function assertion(pair, credentialId) {
  const issuedAt = Date.now(),
    nonce = randomBytes(24).toString("base64url");
  return {
    credentialId,
    issuedAt,
    nonce,
    signature: sign(
      "sha256",
      Buffer.from(`grogoni-device-recovery:v1:${credentialId}:${issuedAt}:${nonce}`),
      { key: pair.privateKey, dsaEncoding: "ieee-p1363" }
    ).toString("base64url")
  };
}
let guest,
  guestCookie,
  guestCredentialId,
  conversationId,
  phone,
  phoneCookie,
  phoneId,
  phoneCredentialId;
const guestPair = keyPair(),
  phonePair = keyPair();
try {
  await check("fresh guest receives a device account and recovery credential", async () => {
    const response = await call("", "/auth/continue", {
      devicePublicKeyJwk: guestPair.publicKeyJwk
    });
    guest = ok(response);
    guestCookie = response.cookie;
    accounts.add(guest.account.id);
    guestCredentialId = guest.deviceRecoveryCredentialId;
    assert.ok(guestCredentialId);
    assert.equal(guest.account.identityLevel, "device");
    return { status: response.status, identityLevel: guest.account.identityLevel };
  });
  await check("guest opens a persistent assistant conversation", async () => {
    assert.ok(guestCookie);
    const response = await call(guestCookie, "/v1/conversations", {
      kind: "personal",
      activeShopId: null,
      title: "Live model verification"
    });
    const view = ok(response);
    conversationId = view.conversation.id;
    assert.equal(view.conversation.conversationType, "DAEMON");
    return { conversationId, type: view.conversation.conversationType };
  });
  await check("passkey recovery ceremonies and routes are disabled", async () => {
    const ceremony = await call(guestCookie, "/auth/passkeys/login/options", {
      purpose: "pin_recovery"
    });
    assert.equal(ceremony.status, 400);
    for (const path of ["/auth/pin/recover/passkey", "/auth/password/recover/passkey"])
      assert.equal((await call(guestCookie, path, { pin: "7391" })).status, 404);
    return { ceremonyStatus: ceremony.status, retiredRoutesStatus: 404 };
  });
  await check("device proof restores the same guest without cookies", async () => {
    assert.ok(guestCredentialId);
    const response = await call(
      "",
      "/auth/device/recover",
      assertion(guestPair, guestCredentialId)
    );
    const data = ok(response);
    assert.equal(data.account.id, guest.account.id);
    guestCookie = response.cookie;
    const inbox = ok(await call(guestCookie, "/v1/conversations"));
    assert.ok(
      inbox.conversations.some(
        (item) => item.conversation?.id === conversationId || item.id === conversationId
      )
    );
    return { sameAccount: true, conversationPreserved: true };
  });
  await check("phone account enrolls a device key after signup", async () => {
    for (let i = 0; i < 3; i++) {
      phone = `+442079460${String(randomInt(1000)).padStart(3, "0")}`;
      const response = await call("", "/auth/pin/signup", {
        method: "phone",
        contact: phone,
        pin: "7391"
      });
      if (response.status === 409) continue;
      const data = ok(response);
      phoneCookie = response.cookie;
      phoneId = data.account.id;
      accounts.add(phoneId);
      break;
    }
    assert.ok(phoneId);
    const response = await call(phoneCookie, "/auth/continue", {
      devicePublicKeyJwk: phonePair.publicKeyJwk
    });
    phoneCredentialId = ok(response).deviceRecoveryCredentialId;
    assert.ok(phoneCredentialId);
    return { registered: true };
  });
  await check("ordinary sessions and invalid signatures cannot reset credentials", async () => {
    assert.ok(phoneId);
    const denied = await call(phoneCookie, "/auth/pin/recover/device", { pin: "4826" });
    assert.equal(denied.status, 401);
    const proof = assertion(phonePair, phoneCredentialId);
    proof.signature = randomBytes(64).toString("base64url");
    assert.equal((await call("", "/auth/device/recover", proof)).status, 401);
    return { sessionDenied: true, invalidSignatureDenied: true };
  });
  await check("signed device proof resets PIN once and preserves account", async () => {
    assert.ok(phoneId);
    const proof = assertion(phonePair, phoneCredentialId);
    const recovered = await call("", "/auth/device/recover", proof);
    assert.equal(ok(recovered).account.id, phoneId);
    phoneCookie = recovered.cookie;
    ok(
      await call(phoneCookie, "/auth/pin/recover/device", { pin: "4826", pinConfirmation: "4826" })
    );
    const reused = await call(phoneCookie, "/auth/pin/recover/device", { pin: "1111" });
    assert.equal(reused.status, 401);
    ok(await call("", "/auth/device/recover", proof));
    assert.equal(
      (await call(phoneCookie, "/auth/pin/recover/device", { pin: "1111" })).status,
      401
    );
    assert.equal(
      ok(await call("", "/auth/pin/login", { method: "phone", contact: phone, pin: "4826" }))
        .account.id,
      phoneId
    );
    return { reset: true, oneUse: true, replayCannotReplenish: true };
  });
  await check("fresh device proof resets password and permits password login", async () => {
    assert.ok(phoneId);
    const recovered = await call(
      "",
      "/auth/device/recover",
      assertion(phonePair, phoneCredentialId)
    );
    ok(recovered);
    phoneCookie = recovered.cookie;
    const password = `Live-test-${randomUUID()}`;
    ok(
      await call(phoneCookie, "/auth/password/recover/device", {
        password,
        passwordConfirmation: password
      })
    );
    assert.equal(
      ok(await call("", "/auth/login/password", { type: "phone", identifier: phone, password }))
        .account.id,
      phoneId
    );
    return { reset: true, login: true };
  });
  await check("guest message reaches model and returns generated content", async () => {
    assert.ok(conversationId);
    const clientMessageId = `live-${randomUUID()}`,
      marker = `LIVE_${randomBytes(5).toString("hex")}`;
    const message = `Reply with exactly ${marker}. This is a connectivity test. Do not perform any actions.`;
    ok(
      await call(guestCookie, "/v1/messages", {
        conversationId,
        clientMessageId,
        content: { type: "text", text: message },
        clientTimestamp: new Date().toISOString()
      })
    );
    const submitted = await call(guestCookie, "/v1/daemon/tasks", {
      key: `chat:${clientMessageId}`,
      message,
      conversation: {
        id: conversationId,
        clientMessageId,
        scope: JSON.stringify(["marketplace", null, conversationId]),
        kind: "reply"
      }
    });
    const task = ok(submitted).task;
    assert.ok(task.id);
    report.taskId = task.id;
    const claim = ok(await call(guestCookie, "/v1/daemon/claims", {})).claim;
    assert.ok(claim, "No task was claimable");
    assert.equal(claim.task.id, task.id);
    const executed = ok(
      await call(guestCookie, `/v1/daemon/claims/${task.id}/execute`, {
        leaseToken: claim.leaseToken
      })
    );
    await writeFile(`${out}/model-execution.json`, JSON.stringify(executed, null, 2));
    assert.equal(
      executed.task.status,
      "completed",
      JSON.stringify({ status: executed.task.status, errorCode: executed.task.errorCode })
    );
    const result = executed.task.result;
    assert.ok(
      JSON.stringify(result).includes(marker),
      "Generated reply did not contain the unique requested marker"
    );
    assert.equal(result.completion?.status, "available");
    return {
      taskId: task.id,
      modelId: task.payload.modelId,
      completion: result.completion,
      marker,
      generatedText:
        result.completion?.outputText ?? result.assistant?.text ?? result.text ?? result.output
    };
  });
} finally {
  try {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('grogoni.cp2.normalized_store'))");
      await deleteLiveFixtureAccounts(client, { accountIds: accounts });
      await client.query("commit");
      report.cleanup = { passed: true, accounts: accounts.size };
    } catch (error) {
      await client.query("rollback");
      report.cleanup = { passed: false, error: error.message };
      process.exitCode = 1;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
    report.finishedAt = new Date().toISOString();
    await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  }
}
if (checks.some((check) => !check.passed)) process.exitCode = 1;
