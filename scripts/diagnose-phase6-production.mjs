/** Focused live diagnostics. Extra scope hints below are probes, not client behavior fixes. */
import assert from "node:assert/strict";
import { randomInt, randomUUID, webcrypto as crypto } from "node:crypto";
import { createRequire } from "node:module";
import { URL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { encryptDirectMessage, decryptDirectMessage } from "../apps/web/src/e2ee.ts";
import { deleteLiveFixtureAccounts } from "./live-fixture-cleanup.mjs";
if (!process.argv.includes("--live"))
  throw new Error("Pass --live for disposable production diagnostics.");
const base = "https://grogoni.com/api",
  runId = randomUUID(),
  device = `phase6-diagnostic-${runId}`;
const dir = `/tmp/phase6-production/${runId}`;
const { Client } = createRequire(new URL("../services/api/package.json", import.meta.url))("pg");
const accounts = new Set(),
  businesses = new Set(),
  steps = [];
let browser;
async function call(cookie, path, method = "GET", body) {
  const r = await fetch(base + path, {
    method,
    headers: {
      cookie,
      origin: "https://grogoni.com",
      "content-type": "application/json",
      "x-grogoni-device-id": device,
      "x-region": "us-east-1"
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: globalThis.AbortSignal.timeout(90000)
  });
  return {
    status: r.status,
    path,
    json: await r.json().catch(() => ({})),
    cookie: r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ")
  };
}
function ok(r) {
  assert.equal(r.status, 200, `${r.path}: HTTP ${r.status} ${r.json.code ?? ""}`);
  return r.json;
}
async function probe(name, action) {
  try {
    const detail = await action();
    steps.push({ name, status: "pass", detail });
    console.log(`PASS ${name}`);
    return detail;
  } catch (e) {
    steps.push({ name, status: "fail", detail: e.message });
    console.log(`FAIL ${name}: ${e.message}`);
    return null;
  }
}
async function signup() {
  const phone = `+442079460${String(randomInt(1000)).padStart(3, "0")}`;
  const response = await call("", "/auth/pin/signup", "POST", {
    method: "phone",
    contact: phone,
    pin: String(randomInt(1000, 9999))
  });
  const data = ok(response);
  accounts.add(data.account.id);
  return { ...data, phone, cookie: response.cookie };
}
async function identity(cookie) {
  const keys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits"
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const publicKey = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true };
  const deviceId = `phase6-${randomUUID()}`;
  const registered = ok(
    await call(cookie, "/v1/e2ee/devices", "POST", {
      deviceId,
      label: "Disposable diagnostic device",
      publicKey
    })
  );
  return {
    deviceId: registered.id ?? deviceId,
    privateKey: keys.privateKey,
    publicKey,
    registeredDevice: registered
  };
}
await mkdir(dir, { recursive: true });
try {
  const a = await signup(),
    b = await signup();
  const context = ok(await call(a.cookie, "/v1/session/context"));
  const direct = ok(
    await call(a.cookie, "/v1/conversations", "POST", {
      kind: "personal",
      activeShopId: null,
      recipient: b.phone,
      title: `Diagnostic direct ${runId}`
    })
  );
  const id = direct.conversation.id;
  const aKey = await identity(a.cookie),
    bKey = await identity(b.cookie);
  const aDevices = ok(await call(a.cookie, `/v1/conversations/${id}/encryption-devices`)).devices;
  const bEnumeration = await call(b.cookie, `/v1/conversations/${id}/encryption-devices`);
  const bDevices = bEnumeration.status === 200 ? bEnumeration.json.devices : [];
  steps.push({
    name: "recipient encryption-device access",
    status: bEnumeration.status === 200 ? "pass" : "fail",
    detail: { status: bEnumeration.status, code: bEnumeration.json.code }
  });
  await probe("encryption device enumeration includes both authorized accounts", async () => {
    const detail = {
      aCount: aDevices.length,
      bCount: bDevices.length,
      aAccounts: aDevices.map((d) => d.accountId),
      bAccounts: bDevices.map((d) => d.accountId)
    };
    steps.push({ name: "encryption enumeration observation", status: "observation", detail });
    assert.ok(
      aDevices.some((d) => d.accountId === b.account.id),
      "Sender cannot enumerate recipient's registered device"
    );
    assert.ok(
      bDevices.some((d) => d.accountId === a.account.id),
      "Recipient cannot enumerate sender's registered device"
    );
    return detail;
  });
  await probe(
    "diagnostic recipient scope hint allows encrypted exchange and message deduplication",
    async () => {
      const devices = [
        ...new Map(
          [...aDevices, ...bDevices, aKey.registeredDevice, bKey.registeredDevice].map((d) => [
            d.id,
            d
          ])
        ).values()
      ];
      const text = `Scoped encrypted probe ${runId}`;
      const content = await encryptDirectMessage({
        conversationId: id,
        devices,
        message: { text, attachments: [] }
      });
      const payload = {
        conversationId: id,
        recipient: b.phone,
        clientMessageId: `scope-hint-${runId}`,
        idempotencyKey: `scope-hint-${runId}`,
        content
      };
      const sent = ok(await call(a.cookie, "/v1/messages", "POST", payload));
      const received = ok(await call(b.cookie, `/v1/conversations/${id}`));
      assert.equal(
        (
          await decryptDirectMessage({
            conversationId: id,
            content: received.messages.find((m) => m.id === sent.id).content,
            identity: bKey
          })
        ).text,
        text
      );
      const repeated = await Promise.all([
        call(a.cookie, "/v1/messages", "POST", payload),
        call(a.cookie, "/v1/messages", "POST", payload)
      ]);
      assert.ok(repeated.every((r) => ok(r).id === sent.id));
      const replyContent = await encryptDirectMessage({
        conversationId: id,
        devices,
        message: { text: `reply ${text}`, attachments: [] }
      });
      const reply = ok(
        await call(b.cookie, "/v1/messages", "POST", {
          conversationId: id,
          recipient: a.phone,
          clientMessageId: `scope-reply-${runId}`,
          content: replyContent
        })
      );
      const restored = ok(await call(a.cookie, `/v1/conversations/${id}`));
      assert.equal(
        (
          await decryptDirectMessage({
            conversationId: id,
            content: restored.messages.find((m) => m.id === reply.id).content,
            identity: aKey
          })
        ).text,
        `reply ${text}`
      );
      return { scopeHintRequired: true, decryptionBothDirections: true, idempotentReplay: true };
    }
  );
  const shop = ok(
    await call(b.cookie, "/businesses", "POST", {
      name: `Disposable diagnostic ${runId.slice(0, 8)}`,
      language: "en"
    })
  ).business;
  businesses.add(shop.id);
  const standard = await call(a.cookie, "/v1/conversations", "POST", {
    kind: "storefront",
    activeShopId: shop.id,
    title: "Diagnostic customer thread"
  });
  steps.push({
    name: "standard customer business creation",
    status: standard.status === 200 ? "pass" : "fail",
    detail: { status: standard.status, code: standard.json.code }
  });
  const scoped = await call(a.cookie, "/v1/conversations", "POST", {
    kind: "storefront",
    activeShopId: shop.id,
    businessId: shop.id,
    title: "Diagnostic scoped customer thread"
  });
  await probe(
    "diagnostic business scope hint resolves the existing registered business",
    async () => {
      const body = ok(scoped);
      return { scopeHintRequired: standard.status !== 200, conversationId: body.conversation.id };
    }
  );
  if (scoped.status === 200) {
    const businessId = scoped.json.conversation.id;
    await probe("customer sends into diagnostically scoped business conversation", async () => {
      const sent = ok(
        await call(a.cookie, "/v1/messages", "POST", {
          conversationId: businessId,
          businessId: shop.id,
          clientMessageId: `diagnostic-customer-${runId}`,
          content: { type: "text", text: "Disposable customer message" }
        })
      );
      return { messageId: sent.id };
    });
    await probe("business owner can read and reply to customer's scoped conversation", async () => {
      const inbox = ok(await call(b.cookie, "/v1/conversations"));
      const thread = await call(b.cookie, `/v1/conversations/${businessId}`);
      steps.push({
        name: "business owner access observation",
        status: "observation",
        detail: {
          inInbox: inbox.conversations.some((c) => c.id === businessId),
          readStatus: thread.status,
          readCode: thread.json.code
        }
      });
      ok(thread);
      ok(
        await call(b.cookie, "/v1/messages", "POST", {
          conversationId: businessId,
          businessId: shop.id,
          clientMessageId: `diagnostic-owner-${runId}`,
          content: { type: "text", text: "Disposable owner reply" }
        })
      );
      return { readAndReply: true };
    });
  }
  await probe(
    "authorized business runtime generates a real response in an owner session",
    async () => {
      const own = ok(
        await call(b.cookie, "/v1/conversations", "POST", {
          kind: "personal",
          activeShopId: shop.id,
          title: "Diagnostic owner runtime"
        })
      );
      const text = "Reply with the exact token PHASE6-OWNER-RUNTIME. Do not call tools.";
      const result = ok(
        await call(b.cookie, "/v1/messages", "POST", {
          conversationId: own.conversation.id,
          businessId: shop.id,
          clientMessageId: `owner-model-${runId}`,
          content: { type: "text", text },
          agent: { businessId: shop.id, message: text }
        })
      );
      assert.ok(
        result.agentMessage?.content?.text?.includes("PHASE6-OWNER-RUNTIME"),
        "No real authorized business model response"
      );
      return {
        text: result.agentMessage.content.text,
        modelId: result.runtime?.turn?.model?.modelId,
        scope: "owner session, not shared customer thread"
      };
    }
  );
  await probe("authenticated production browser loads and reloads actual inbox data", async () => {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      extraHTTPHeaders: { "x-grogoni-device-id": device }
    });
    await ctx.addCookies(
      a.cookie.split("; ").map((entry) => {
        const at = entry.indexOf("=");
        return {
          name: entry.slice(0, at),
          value: entry.slice(at + 1),
          domain: "grogoni.com",
          path: "/",
          httpOnly: true,
          secure: true,
          sameSite: "Lax"
        };
      })
    );
    await ctx.addInitScript(
      ({ device }) => {
        globalThis.localStorage.setItem("grogoni.device-id.v1", device);
        globalThis.localStorage.setItem("grogoni.marketplace-intro.completed.v1", "true");
      },
      { device }
    );
    const page = await ctx.newPage();
    const calls = [];
    page.on("response", (r) => {
      const path = new URL(r.url()).pathname;
      if (
        path.includes("/api/") &&
        (path.includes("bootstrap") || path.endsWith("/v1/conversations"))
      )
        calls.push({ path, status: r.status() });
    });
    await page.goto(`https://grogoni.com/marketplace/conversations/${context.conversationId}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });
    const first = await page.request.get(`${base}/v1/conversations`);
    assert.equal(first.status(), 200, "Browser's authenticated API request failed");
    const firstInbox = await first.json();
    assert.ok(firstInbox.conversations.some((c) => c.id === id));
    // Wait for the UI to receive data instead of assuming its search field signals readiness.
    await page
      .waitForFunction(
        () => globalThis.document.querySelectorAll(".conversation-item").length > 0,
        {},
        { timeout: 30000 }
      )
      .catch(() => {});
    await page.screenshot({ path: `${dir}/before-reload.png`, fullPage: true });
    const before = await page.locator(".conversation-item").count();
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    const second = await page.request.get(`${base}/v1/conversations`);
    assert.equal(second.status(), 200);
    await page
      .waitForFunction(
        () => globalThis.document.querySelectorAll(".conversation-item").length > 0,
        {},
        { timeout: 30000 }
      )
      .catch(() => {});
    const after = await page.locator(".conversation-item").count();
    const labels = await page.locator(".session-badge").allTextContents();
    await page.screenshot({ path: `${dir}/after-reload.png`, fullPage: true });
    steps.push({
      name: "browser settled state observation",
      status: "observation",
      detail: {
        before,
        after,
        labels,
        calls,
        apiConversationCount: firstInbox.conversations.length
      }
    });
    assert.ok(
      before > 0 && after > 0,
      "Authenticated API inbox exists but the browser did not render conversation rows within 30 seconds"
    );
    return { before, after, labels, calls };
  });
} catch (e) {
  steps.push({ name: "diagnostic setup or continuation", status: "fail", detail: e.message });
  console.log(`STOP ${e.message}`);
} finally {
  await browser?.close().catch(() => {});
  await probe("remove and verify diagnostic fixtures", async () => {
    if (!accounts.size) return { accounts: 0 };
    const client = new Client({
      connectionString: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL,
      connectionTimeoutMillis: 15000
    });
    await client.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('grogoni.cp2.normalized_store'))");
      await deleteLiveFixtureAccounts(client, {
        accountIds: [...accounts],
        businessIds: [...businesses]
      });
      await client.query("commit");
      const left = await client.query(
        "select count(*)::int as n from accounts where id=any($1::uuid[])",
        [[...accounts]]
      );
      assert.equal(left.rows[0].n, 0);
      return { accounts: accounts.size, businesses: businesses.size };
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw e;
    } finally {
      await client.end();
    }
  });
  const report = { runId, base, completedAt: new Date().toISOString(), steps };
  await writeFile(`${dir}/diagnostics.json`, JSON.stringify(report, null, 2));
  console.log(`Evidence: ${dir}/diagnostics.json`);
  if (steps.some((s) => s.status === "fail")) process.exitCode = 1;
}
