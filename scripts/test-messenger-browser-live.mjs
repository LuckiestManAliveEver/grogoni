/** Real two-browser production messaging. Writes only disposable fixtures, then verifies cleanup. */
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { URL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { deleteLiveFixtureAccounts } from "./live-fixture-cleanup.mjs";
if (!process.argv.includes("--live")) throw new Error("Pass --live to create disposable fixtures.");
const databaseUrl = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Database access is required for verified fixture cleanup.");
const frontend = "https://grogoni.com";
const base = `${frontend}/api`;
const runId = randomUUID();
const device = `browser-messenger-${runId}`;
const dir = `/tmp/messenger-browser-live/${runId}`;
const accountIds = new Set(),
  businessIds = new Set(),
  checks = [],
  pageErrors = [];
const { Client } = createRequire(new URL("../services/api/package.json", import.meta.url))("pg");
let browser;
const browserState = [];
async function call(cookie, path, method = "GET", body) {
  const start = globalThis.performance.now();
  const response = await fetch(base + path, {
    method,
    headers: {
      cookie,
      origin: frontend,
      "x-grogoni-device-id": device,
      "x-region": "us-east-1",
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: globalThis.AbortSignal.timeout(90000)
  });
  return {
    status: response.status,
    requestId: response.headers.get("x-request-id"),
    durationMs: Math.round(globalThis.performance.now() - start),
    json: await response.json(),
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ")
  };
}
function ok(result) {
  assert.equal(
    result.status,
    200,
    JSON.stringify({ status: result.status, code: result.json.code, requestId: result.requestId })
  );
  return result.json;
}
async function check(name, action) {
  console.log(`RUN ${name}`);
  const detail = await action();
  checks.push({ name, status: "pass", detail });
  console.log(`PASS ${name}`);
  return detail;
}
async function signup() {
  const result = await call("", "/auth/pin/signup", "POST", {
    method: "phone",
    contact: `+442079460${String(randomInt(1000)).padStart(3, "0")}`,
    pin: String(randomInt(1000, 9999))
  });
  const body = ok(result);
  accountIds.add(body.account.id);
  assert.ok(result.cookie);
  return { ...body, cookie: result.cookie };
}
async function open(actor, width, conversationId) {
  const context = await browser.newContext({
    viewport: { width, height: 844 },
    extraHTTPHeaders: { "x-grogoni-device-id": device }
  });
  await context.addCookies(
    actor.cookie.split("; ").map((value) => {
      const split = value.indexOf("=");
      return {
        name: value.slice(0, split),
        value: value.slice(split + 1),
        domain: "grogoni.com",
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax"
      };
    })
  );
  await context.addInitScript(
    ({ device }) => {
      globalThis.localStorage.setItem("grogoni.device-id.v1", device);
      globalThis.localStorage.setItem("grogoni.marketplace-intro.completed.v1", "true");
    },
    { device }
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push({ width, message: error.message }));
  const registered = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/v1/e2ee/devices") &&
      response.request().method() === "POST",
    { timeout: 60000 }
  );
  await page.goto(`${frontend}/marketplace/conversations/${conversationId}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });
  assert.equal((await registered).status(), 200, "Browser encryption-device registration failed");
  await selected(page, conversationId);
  return page;
}
async function selected(page, id) {
  const compact = (page.viewportSize()?.width ?? 1280) < 760;
  if (compact) {
    await page.locator(".messenger-thread").waitFor({ state: "visible", timeout: 60000 });
    await swipeInbox(page, "open");
  }
  await page
    .locator(`[data-conversation-id="${id}"].active`)
    .waitFor({ state: "attached", timeout: 60000 });
  if (compact) await swipeInbox(page, "close");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .waitFor({ state: "visible", timeout: 60000 });
  await page.locator(".messenger-thread-header").waitFor({ state: "visible", timeout: 60000 });
  assert.equal(
    await page.getByRole("textbox", { name: "Message", exact: true }).getAttribute("placeholder"),
    "Write a message"
  );
  assert.equal(await page.getByTestId("home-welcome").count(), 0);
  assert.equal(
    await page.getByRole("button", { name: "Open model library", exact: true }).count(),
    0
  );
  assert.equal(
    await page.getByRole("button", { name: "Switch model or runtime", exact: true }).count(),
    0
  );
}
async function swipeInbox(page, direction) {
  await page.locator(".messenger-thread").evaluate((thread, direction) => {
    const target = thread.querySelector(".message-list") ?? thread;
    const start = direction === "open" ? 80 : 310,
      end = direction === "open" ? 310 : 80;
    target.dispatchEvent(
      new globalThis.TouchEvent("touchstart", {
        bubbles: true,
        touches: [new globalThis.Touch({ identifier: 1, target, clientX: start, clientY: 250 })]
      })
    );
    target.dispatchEvent(
      new globalThis.TouchEvent("touchend", {
        bubbles: true,
        touches: [],
        changedTouches: [
          new globalThis.Touch({ identifier: 1, target, clientX: end, clientY: 255 })
        ]
      })
    );
  }, direction);
}
async function send(page, id, text, encrypted) {
  await selected(page, id);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  const pending = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/v1/messages") &&
      response.request().method() === "POST",
    { timeout: 60000 }
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const response = await pending;
  const payload = response.request().postDataJSON();
  const body = await response.json();
  assert.equal(
    response.status(),
    200,
    JSON.stringify({
      status: response.status(),
      code: body.code,
      requestId: response.headers()["x-request-id"]
    })
  );
  assert.equal(payload.conversationId, id);
  assert.equal(payload.agent, undefined, "Human messaging must not invoke agent inference");
  assert.equal(payload.content.type, encrypted ? "encrypted" : "text");
  if (encrypted)
    assert.ok(
      !JSON.stringify(payload).includes(text),
      "Plaintext leaked into direct message request"
    );
  assert.ok(body.id);
  return body.id;
}
async function visibleMessage(page, text) {
  await page
    .locator(".message-list")
    .getByText(text, { exact: true })
    .waitFor({ state: "visible", timeout: 60000 });
}
async function cleanup() {
  if (!accountIds.size) return;
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 15000 });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('grogoni.cp2.normalized_store'))");
    const started = globalThis.performance.now();
    await deleteLiveFixtureAccounts(client, {
      accountIds: [...accountIds],
      businessIds: [...businessIds]
    });
    await client.query("commit");
    const lockHeldMs = Math.round(globalThis.performance.now() - started);
    const result = await client.query(
      "select count(*)::int as count from accounts where id=any($1::uuid[])",
      [[...accountIds]]
    );
    assert.equal(result.rows[0].count, 0);
    return { removedAccounts: accountIds.size, removedBusinesses: businessIds.size, lockHeldMs };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}
await mkdir(dir, { recursive: true });
try {
  const alice = await signup(),
    bob = await signup();
  const directId = ok(
    await call(alice.cookie, "/v1/conversations", "POST", {
      kind: "personal",
      activeShopId: null,
      recipient: bob.account.primaryAuthDestination
    })
  ).conversation.id;
  const shop = ok(
    await call(bob.cookie, "/businesses", "POST", {
      name: `Browser messaging ${runId.slice(0, 8)}`,
      language: "en"
    })
  ).business;
  businessIds.add(shop.id);
  const businessId = ok(
    await call(alice.cookie, "/v1/conversations", "POST", {
      kind: "storefront",
      activeShopId: shop.id
    })
  ).conversation.id;
  browser = await chromium.launch({ headless: true });
  const a = await open(alice, 390, directId),
    b = await open(bob, 1280, directId);
  await check("two browsers send and decrypt direct messages in both directions", async () => {
    const first = `Private A ${runId}`,
      reply = `Private B ${runId}`;
    const firstId = await send(a, directId, first, true);
    await visibleMessage(b, first);
    const replyId = await send(b, directId, reply, true);
    await visibleMessage(a, reply);
    const persisted = ok(await call(alice.cookie, `/v1/conversations/${directId}`));
    for (const id of [firstId, replyId])
      assert.equal(
        persisted.messages.find((message) => message.id === id)?.content.type,
        "encrypted"
      );
    for (const page of [a, b]) {
      await page.reload({ waitUntil: "domcontentloaded" });
      await selected(page, directId);
      await visibleMessage(page, first);
      await visibleMessage(page, reply);
    }
    await a.screenshot({ path: `${dir}/direct-phone.png`, fullPage: true });
    await b.screenshot({ path: `${dir}/direct-desktop.png`, fullPage: true });
    return {
      encryptedAtRequestAndStorage: true,
      bothBrowsersDecrypted: true,
      reloadVerified: true
    };
  });
  await check(
    "customer and business owner exchange browser replies in one business thread",
    async () => {
      for (const page of [a, b]) {
        await page.goto(`${frontend}/marketplace/conversations/${businessId}`, {
          waitUntil: "domcontentloaded"
        });
        await selected(page, businessId);
      }
      const question = `Customer ${runId}`,
        answer = `Owner ${runId}`;
      await send(a, businessId, question, false);
      await visibleMessage(b, question);
      await send(b, businessId, answer, false);
      await visibleMessage(a, answer);
      await a.reload({ waitUntil: "domcontentloaded" });
      await selected(a, businessId);
      await visibleMessage(a, question);
      await visibleMessage(a, answer);
      await a.screenshot({ path: `${dir}/business-phone.png`, fullPage: true });
      await b.screenshot({ path: `${dir}/business-desktop.png`, fullPage: true });
      return {
        sameConversation: true,
        customerReceivedOwnerReply: true,
        noAgentInference: true,
        reloadVerified: true
      };
    }
  );
  await check("bounded parallel session and inbox reads remain available", async () => {
    const samples = [];
    for (let round = 0; round < 3; round++) {
      const results = await Promise.all([
        call(alice.cookie, "/v1/session/context"),
        call(bob.cookie, "/v1/conversations")
      ]);
      for (const result of results) {
        samples.push({
          round,
          status: result.status,
          durationMs: result.durationMs,
          requestId: result.requestId,
          code: result.json.code ?? null
        });
        ok(result);
      }
    }
    return { samples };
  });
  await check("browser workflows produced no page errors", async () => {
    assert.deepEqual(pageErrors, []);
    return { pageErrors };
  });
} catch (error) {
  checks.push({ name: "browser messaging workflow", status: "fail", detail: error.message });
  console.log(`FAIL ${error.message}`);
  process.exitCode = 1;
} finally {
  if (browser) {
    for (const context of browser.contexts())
      for (const page of context.pages()) {
        browserState.push({
          width: page.viewportSize()?.width,
          path: new URL(page.url()).pathname,
          activeRows: await page
            .locator(".conversation-item.active")
            .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-conversation-id")))
            .catch(() => [])
        });
      }
    for (const context of browser.contexts())
      for (const page of context.pages())
        await page
          .screenshot({
            path: `${dir}/final-${page.viewportSize()?.width ?? 0}.png`,
            fullPage: true
          })
          .catch(() => {});
    await browser.close();
  }
  try {
    await check("remove and verify all disposable messaging fixtures", cleanup);
  } catch (error) {
    checks.push({ name: "cleanup", status: "fail", detail: error.message });
    process.exitCode = 1;
  }
  await writeFile(
    `${dir}/report.json`,
    JSON.stringify(
      {
        runId,
        base,
        checks,
        pageErrors,
        browserState,
        fixtures: { accountIds: [...accountIds], businessIds: [...businessIds] }
      },
      null,
      2
    )
  );
  console.log(`Evidence: ${dir}/report.json`);
}
