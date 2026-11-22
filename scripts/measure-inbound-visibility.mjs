// Live inbound-visibility measurement: how long after account A taps Send does account B's open
// thread show the message? Two disposable accounts, one direct (end-to-end encrypted) conversation,
// two real browsers. No model calls. Fixtures are removed with the shared live-fixture cleanup.
// Run: node --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/measure-inbound-visibility.mjs --live
import { chromium } from "@playwright/test";
import { createRequire } from "node:module";
import { randomInt, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { databasePoolConfig } from "../services/api/scripts/database-connection.mjs";
import { deleteLiveFixtureAccounts } from "./live-fixture-cleanup.mjs";

if (!process.argv.includes("--live"))
  throw new Error("Pass --live to measure with disposable live accounts.");
if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL is required for disposable-fixture cleanup.");
const frontend = process.env.INBOUND_MEASURE_FRONTEND ?? "https://grogoni.com";
const api = process.env.INBOUND_MEASURE_API ?? `${frontend}/api`;
const output = process.env.INBOUND_MEASURE_OUTPUT ?? "/tmp/inbound-visibility.json";
const samples = Number(process.env.INBOUND_MEASURE_SAMPLES ?? 5);
// Each browser is its own device: end-to-end encryption keys messages per device id, so the two
// accounts must never share one (a shared id made the receiver's envelope unreadable).
const run = randomUUID();
const deviceA = `inbound-measure-${run}-a`;
const deviceB = `inbound-measure-${run}-b`;
const require = createRequire(new globalThis.URL("../services/api/package.json", import.meta.url));
const { Client } = require("pg");
const phones = new Set();
while (phones.size < 2) phones.add(`+442079460${String(randomInt(0, 1000)).padStart(3, "0")}`);
const [phoneA, phoneB] = [...phones];
const accountIds = [];
const results = [];
let browser, workflowError;

async function call(path, payload, cookie = "", device = deviceA) {
  const response = await globalThis.fetch(`${api}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: new globalThis.URL(frontend).origin,
      "x-grogoni-device-id": device,
      cookie
    },
    body: JSON.stringify(payload),
    signal: globalThis.AbortSignal.timeout(60_000)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} (${body.code ?? "unknown"})`);
  const cookies = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  return { body, cookies };
}

async function openThread(cookies, conversationId, device) {
  const context = await browser.newContext({
    viewport: { width: 360, height: 800 },
    serviceWorkers: "block"
  });
  await context.addCookies(
    cookies
      .split("; ")
      .filter(Boolean)
      .map((pair) => {
        const split = pair.indexOf("=");
        return {
          name: pair.slice(0, split),
          value: pair.slice(split + 1),
          url: new globalThis.URL(frontend).origin,
          httpOnly: true,
          secure: frontend.startsWith("https:")
        };
      })
  );
  const page = await context.newPage();
  await page.addInitScript((device) => {
    globalThis.localStorage.setItem("grogoni.device-id.v1", device);
    globalThis.localStorage.setItem("grogoni.marketplace-intro.completed.v1", "true");
  }, device);
  await page.goto(`${frontend}/marketplace/conversations/${conversationId}`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000
  });
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.waitFor({ timeout: 90_000 });
  return { context, page, composer };
}

try {
  const a = await call("/auth/pin/signup", { method: "phone", contact: phoneA, pin: "3927" });
  accountIds.push(a.body.account.id);
  const b = await call(
    "/auth/pin/signup",
    { method: "phone", contact: phoneB, pin: "3927" },
    "",
    deviceB
  );
  accountIds.push(b.body.account.id);
  const conversation = (
    await call(
      "/v1/conversations",
      { kind: "personal", activeShopId: null, recipient: phoneB },
      a.cookies
    )
  ).body.conversation;
  browser = await chromium.launch({ headless: true });
  const receiver = await openThread(b.cookies, conversation.id, deviceB);
  const sender = await openThread(a.cookies, conversation.id, deviceA);
  // Let both devices register their encryption keys and settle.
  await sender.page.waitForTimeout(15_000);
  for (let index = 0; index < samples; index += 1) {
    const text = `Inbound visibility ${index + 1} ${randomUUID().slice(0, 8)}`;
    await sender.composer.fill(text);
    const seen = receiver.page.waitForFunction(
      (text) => globalThis.document.querySelector(".message-list")?.textContent?.includes(text),
      text,
      { timeout: 120_000, polling: 50 }
    );
    const tapped = Date.now();
    await sender.composer.press("Enter");
    await seen;
    results.push({ sample: index + 1, visibleMs: Date.now() - tapped });
    console.log(JSON.stringify(results.at(-1)));
    await receiver.page.waitForTimeout(3_000);
  }
  await sender.context.close();
  await receiver.context.close();
} catch (error) {
  workflowError = error;
} finally {
  await browser?.close();
  const client = new Client({
    ...databasePoolConfig(process.env.DATABASE_URL),
    connectionTimeoutMillis: 30_000
  });
  try {
    await client.connect();
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('grogoni.cp2.normalized_store'))");
    const recovered = await client.query(
      "select distinct a.id from accounts a join sessions s on s.account_id = a.id where s.device_id = any($1)",
      [[deviceA, deviceB]]
    );
    const ids = [...new Set([...accountIds, ...recovered.rows.map((row) => row.id)])];
    await deleteLiveFixtureAccounts(client, { accountIds: ids, businessIds: [] });
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    workflowError = workflowError
      ? new AggregateError([workflowError, error], "Measurement and cleanup failed")
      : error;
  } finally {
    await client.end();
  }
  const sorted = results.map((row) => row.visibleMs).sort((left, right) => left - right);
  const pick = (q) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null;
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        frontend,
        measuredAt: new Date().toISOString(),
        scope:
          "Disposable accounts, one direct conversation, sender tap to receiver's open thread.",
        samples: results,
        p50Ms: pick(0.5),
        p90Ms: pick(0.9),
        passed: !workflowError,
        error: workflowError?.message ?? null
      },
      null,
      2
    ) + "\n",
    { mode: 0o600 }
  );
}
if (workflowError) throw workflowError;
