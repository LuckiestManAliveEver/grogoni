import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { randomInt } from "node:crypto";

const frontend = process.env.SMOKE_FRONTEND_URL ?? "https://grogoni.com";
const output = process.env.SMOKE_SCREENSHOT_DIR ?? "/tmp/grogoni-production-smoke";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const [name, viewport] of [
    ["desktop", { width: 1366, height: 860 }],
    ["phone", { width: 390, height: 844 }]
  ]) {
    for (const route of ["signup", "login"]) {
      const context = await browser.newContext({ viewport, serviceWorkers: "block" });
      const page = await context.newPage();
      const failures = [];
      page.on("response", (response) => {
        if (
          response.url().includes("/api/") &&
          (response.status() === 405 ||
            (response.headers()["content-type"] ?? "").includes("text/html"))
        )
          failures.push(`${response.status()} ${response.url()}`);
      });
      try {
        await page.goto(`${frontend}/${route}`, { waitUntil: "domcontentloaded" });
        await page
          .getByLabel("Phone number", { exact: true })
          .fill(`712${String(randomInt(1000000)).padStart(6, "0")}`);
        const path = route === "signup" ? "/auth/signup/start" : "/auth/login/methods";
        const pending = page.waitForResponse(
          (response) => response.url().endsWith(path) && response.request().method() === "POST",
          { timeout: 30000 }
        );
        await page
          .getByRole("button", {
            name: route === "signup" ? "Continue" : "Continue to log in",
            exact: true
          })
          .click();
        const response = await pending;
        const body = await response.json();
        if (response.status() !== 200)
          throw new Error(`${path} HTTP ${response.status()}: ${body.code}`);
        if (route === "signup" && !body.transactionId)
          throw new Error("Signup did not create a transaction.");
        if (route === "login" && !body.preferred)
          throw new Error("Login discovery did not return methods.");
        if (failures.length) throw new Error(failures.join("; "));
        console.log(`PASS ${name} ${route}: POST ${path} returned JSON 200`);
      } finally {
        await page.screenshot({ path: `${output}/${name}-${route}.png`, fullPage: true });
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}
