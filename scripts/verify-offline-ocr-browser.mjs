/* global URL, window, navigator, localStorage, document, btoa, caches */
/** Production browser smoke test: real Tesseract assets, service worker and IndexedDB. */
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { build, loadConfigFromFile } from "vite";
import { chromium } from "@playwright/test";

const root = fileURLToPath(new URL("..", import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "grogoni-ocr-browser-"));
let browser;
let server;
try {
  await writeFile(
    join(temp, "index.html"),
    '<html><body><script type="module" src="/main.ts"></script></body></html>'
  );
  await writeFile(
    join(temp, "main.ts"),
    `
    import * as ocr from ${JSON.stringify(join(root, "apps/web/src/offline-ocr.ts"))};
    import * as offline from ${JSON.stringify(join(root, "apps/web/src/offline-runtime.ts"))};
    import * as shell from ${JSON.stringify(join(root, "apps/web/src/offline-shell.ts"))};
    Object.assign(window, { ocr, offline, shell });
  `
  );
  const loaded = await loadConfigFromFile(
    { command: "build", mode: "production" },
    join(root, "apps/web/vite.config.ts")
  );
  const output = join(temp, "dist");
  await build({
    ...loaded.config,
    configFile: false,
    root: temp,
    publicDir: join(root, "apps/web/public"),
    build: { ...loaded.config.build, outDir: output },
    logLevel: "error"
  });
  const networkRequests = [];
  server = createServer(async (req, res) => {
    networkRequests.push(req.url);
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = resolve(output, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${output}/`)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const content = await readFile(file);
      const type =
        {
          ".js": "application/javascript",
          ".html": "text/html",
          ".json": "application/json",
          ".svg": "image/svg+xml",
          ".png": "image/png"
        }[extname(file)] ?? "application/octet-stream";
      res.writeHead(200, { "content-type": type });
      res.end(content);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.OCR_BROWSER_CHANNEL ? { channel: process.env.OCR_BROWSER_CHANNEL } : {})
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(() => !!window.ocr);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.evaluate(async () => {
    await window.ocr.ensureOcrEngineCached(() => {});
    await window.shell.prepareOfflineShell(() => {});
    localStorage.setItem(
      "grogoni.auth-bootstrap.v1",
      JSON.stringify({
        account: { id: "account" },
        user: { id: "user" },
        session: { id: "session", expiresAt: "2099-01-01" },
        cachedAt: new Date().toISOString()
      })
    );
    const scope = { accountId: "account", storeId: "shop", deviceId: "device" };
    await (
      await window.offline.offlineDatabase()
    ).transaction(scope, (state) => {
      state.installed = true;
    });
    await window.offline.setOfflineMode(scope, true);
  });
  assert.equal(await page.evaluate(() => window.ocr.isOcrEngineCached()), true);
  await context.setOffline(true);
  const before = networkRequests.length;
  await page.reload();
  await page.waitForFunction(() => !!window.ocr);
  const result = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1100;
    canvas.height = 500;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "black";
    ctx.font = "48px Arial";
    ["ACME SUPPLIES", "RICE 2 X 250", "TOTAL 500"].forEach((line, i) =>
      ctx.fillText(line, 50, 90 + i * 110)
    );
    const input = {
      fileName: "receipt.png",
      contentType: "image/png",
      contentBase64: canvas.toDataURL().split(",")[1]
    };
    const create = (body) =>
      window.offline.routeOfflineRequest("/businesses/shop/receipt-ocr/jobs", "POST", body);
    // Invalid image bytes must reject and leave the scanner usable.
    let invalidRejected = false;
    try {
      await create({ ...input, contentBase64: btoa("not an image") });
    } catch {
      invalidRejected = true;
    }
    const jobs = await Promise.all([create(input), create(input)]);
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const blank = await create({ ...input, contentBase64: canvas.toDataURL().split(",")[1] });
    const state = await window.offline.getOfflineState(window.offline.currentOfflineScope());
    return { invalidRejected, jobs, blank, operations: state.operations };
  });
  assert.equal(result.invalidRejected, true);
  assert.equal(result.jobs.length, 2);
  for (const job of result.jobs) {
    assert.match(job.fullText, /ACME SUPPLIES/);
    assert.match(job.fullText, /TOTAL 500/);
    assert.ok(job.blocks.length > 0);
    assert.equal(job.status, "REVIEW_REQUIRED");
  }
  assert.equal(result.blank.status, "FAILED");
  assert.ok(result.blank.errorMessage);
  assert.equal(result.operations.length, 3);
  assert.equal(JSON.stringify(result.operations).includes("contentBase64"), false);
  await page.reload();
  await page.waitForFunction(() => !!window.ocr);
  assert.equal(
    await page.evaluate(
      async () =>
        (await window.offline.routeOfflineRequest("/businesses/shop/receipt-ocr/jobs", "GET"))
          .length
    ),
    3
  );
  await page.evaluate(async () => {
    await (await caches.open("grogoni-ocr-engine-v1")).delete("/tesseract/worker.min.js");
  });
  assert.equal(await page.evaluate(() => window.ocr.isOcrEngineCached()), false);
  // Even with connectivity restored, a missing asset must not cause a scan-time fetch.
  await context.setOffline(false);
  assert.equal(
    await page.evaluate(async () => (await fetch("/tesseract/worker.min.js")).status),
    503
  );
  // Chromium may perform its own service-worker update check after a reload.
  assert.deepEqual(
    networkRequests.slice(before).filter((url) => url !== "/sw.js"),
    []
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: real offline OCR after reload, concurrent scans, failed-image recovery, blank receipts, persistence, no image bytes queued, and zero application network requests during scanning."
  );
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
