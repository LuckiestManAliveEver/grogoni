// Live, disposable-owner measurement. Uses the existing fixture cleanup; never measures a
// customer's conversation. --live is required because this makes small paid agent calls.
import { chromium } from "@playwright/test";
import { createRequire } from "node:module";
import { randomInt, randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { databasePoolConfig } from "../services/api/scripts/database-connection.mjs";
import { deleteLiveFixtureAccounts } from "./live-fixture-cleanup.mjs";

if (!process.argv.includes("--live"))
  throw new Error("Pass --live to measure disposable live conversations.");
if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL is required for disposable-fixture cleanup.");
const frontend = process.env.MESSAGING_MEASURE_FRONTEND ?? "https://grogoni.com";
const api = process.env.MESSAGING_MEASURE_API ?? `${frontend}/api`;
const output = process.env.MESSAGING_MEASURE_OUTPUT ?? "/tmp/messaging-live-baseline.json";
const device = `messaging-measure-${randomUUID()}`;
const phone = `+442079460${String(randomInt(0, 1000)).padStart(3, "0")}`;
const accountIds = [],
  businessIds = [],
  measurements = [];
let browser, workflowError;
const require = createRequire(new globalThis.URL("../services/api/package.json", import.meta.url));
const { Client } = require("pg");
async function call(path, payload, cookie = "") {
  const response = await fetch(`${api}${path}`, {
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
  return {
    body,
    cookies: response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ")
  };
}
try {
  const owner = await call("/auth/pin/signup", { method: "phone", contact: phone, pin: "3927" });
  accountIds.push(owner.body.account.id);
  const created = await call(
    "/businesses",
    { name: `Messaging measurement ${randomUUID()}`, language: "en" },
    owner.cookies
  );
  const business = created.body.business;
  businessIds.push(business.id);
  const { body: thread } = await call(
    "/v1/conversations",
    { kind: "personal", activeShopId: business.id, title: "Disposable latency measurement" },
    owner.cookies
  );
  browser = await chromium.launch({ headless: true });
  for (const profile of [
    { name: "normal", latency: 0, download: -1, upload: -1 },
    { name: "slow-3g", latency: 400, download: 400_000 / 8, upload: 400_000 / 8 },
    { name: "mobile-1.5mbps-300ms", latency: 300, download: 1_500_000 / 8, upload: 750_000 / 8 }
  ]) {
    const context = await browser.newContext({
      viewport: { width: 360, height: 800 },
      serviceWorkers: "block"
    });
    const page = await context.newPage();
    try {
      await context.addCookies(
        owner.cookies
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
      await page.addInitScript(
        ({ device, business }) => {
          globalThis.localStorage.setItem("grogoni.device-id.v1", device);
          globalThis.localStorage.setItem("grogoni.marketplace-intro.completed.v1", "true");
          globalThis.localStorage.setItem(
            "grogoni.chatFirst.activeBusiness",
            JSON.stringify({ ...business, role: "owner" })
          );
          globalThis.localStorage.setItem("grogoni.chatFirst.mode", "seller");
        },
        { device, business }
      );
      await page.goto(`${frontend}/workspace/conversations/${thread.conversation.id}`, {
        waitUntil: "domcontentloaded",
        timeout: 120_000
      });
      const composer = page.getByRole("textbox", { name: "Message", exact: true });
      await composer.waitFor({ timeout: 60_000 });
      await page
        .locator(".messenger-thread-header")
        .filter({ hasText: "Disposable latency measurement" })
        .waitFor({ timeout: 60_000 });
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: profile.latency,
        downloadThroughput: profile.download,
        uploadThroughput: profile.upload
      });
      const text = `Please reply hello in one sentence. Measurement ${profile.name} ${randomUUID()}. Do not change any records.`;
      await composer.fill(text);
      await page.evaluate((text) => {
        const state = { start: 0, bubbleMs: null, composerMs: null };
        globalThis.window.__messagingMeasure = state;
        const field = globalThis.document.querySelector('textarea[aria-label="Message"]');
        field.addEventListener(
          "keydown",
          () => {
            state.start = globalThis.performance.now();
            const check = () => {
              if (
                state.bubbleMs === null &&
                globalThis.document.querySelector(".message-list")?.textContent?.includes(text)
              )
                state.bubbleMs = globalThis.performance.now() - state.start;
              if (state.composerMs === null && !field.disabled && field.value === "")
                state.composerMs = globalThis.performance.now() - state.start;
              if (state.bubbleMs === null || state.composerMs === null)
                globalThis.requestAnimationFrame(check);
            };
            globalThis.requestAnimationFrame(check);
          },
          { once: true }
        );
      }, text);
      const accepted = page.waitForResponse(
        (response) =>
          new globalThis.URL(response.url()).pathname.endsWith("/v1/messages") &&
          response.request().method() === "POST",
        { timeout: 210_000 }
      );
      await composer.press("Enter");
      const response = await accepted;
      const ackMs = await page.evaluate(
        () => globalThis.performance.now() - globalThis.window.__messagingMeasure.start
      );
      if (!response.ok()) throw new Error(`Message acceptance HTTP ${response.status()}`);
      await page.waitForFunction(
        () =>
          globalThis.window.__messagingMeasure.composerMs !== null &&
          globalThis.window.__messagingMeasure.bubbleMs !== null,
        undefined,
        { timeout: 210_000 }
      );
      const timing = await page.evaluate(() => globalThis.window.__messagingMeasure);
      let requests = 0;
      const count = (request) => {
        if (request.url().startsWith(api)) requests += 1;
      };
      page.on("request", count);
      await page.waitForTimeout(30_000);
      page.off("request", count);
      measurements.push({
        profile: profile.name,
        bubbleMs: timing.bubbleMs,
        composerMs: timing.composerMs,
        ackMs,
        observedIdleRequests: requests,
        idleObservationMs: 30_000,
        projectedIdleRequestsPerHour: requests * 120
      });
      console.log(JSON.stringify(measurements.at(-1)));
    } finally {
      await context.close();
    }
  }
} catch (error) {
  workflowError = error;
} finally {
  await browser?.close();
  const client = new Client({
    ...databasePoolConfig(process.env.DATABASE_URL),
    connectionTimeoutMillis: 10_000
  });
  try {
    await client.connect();
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('grogoni.cp2.normalized_store'))");
    const recovered = await client.query(
      "select a.id from accounts a join sessions s on s.account_id = a.id where a.primary_auth_destination = $1 and s.device_id = $2",
      [phone, device]
    );
    const ids = [...new Set([...accountIds, ...recovered.rows.map((row) => row.id)])];
    await deleteLiveFixtureAccounts(client, { accountIds: ids, businessIds });
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    workflowError = workflowError
      ? new AggregateError([workflowError, error], "Measurement and cleanup failed")
      : error;
  } finally {
    await client.end();
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        frontend,
        api,
        measuredAt: new Date().toISOString(),
        scope:
          "Disposable live owner sessions; idle/hour is a projection from 30 seconds, not a one-hour observation.",
        measurements,
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
