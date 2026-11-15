import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { browserContentSecurityPolicy } from "../services/api/src/browser-security";

describe("production browser CSP", () => {
  it("keeps the hosting and API policies identical", () => {
    const config = JSON.parse(readFileSync("vercel.json", "utf8"));
    const global = config.headers.find((entry: { source: string }) => entry.source === "/(.*)");
    expect(global.headers).toContainEqual({
      key: "Content-Security-Policy",
      value: browserContentSecurityPolicy
    });
  });
  it.skipIf(!existsSync(chromium.executablePath()))(
    "allows bundled scripts and blocks injected inline scripts in Chromium",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "grogoni-csp-test-"));
      await mkdir(join(root, "assets"));
      await writeFile(
        join(root, "index.html"),
        '<!doctype html><script>window.inlineScriptRan=true</script><script src="/assets/app.js"></script>'
      );
      await writeFile(join(root, "assets", "app.js"), "window.selfScriptRan=true");
      const app = buildApi({ webRoot: root });
      const browser = await chromium.launch({ headless: true });
      try {
        const url = await app.listen({ host: "127.0.0.1", port: 0 });
        const page = await browser.newPage();
        const response = await page.goto(url);
        expect(response?.headers()["content-security-policy"]).toBe(browserContentSecurityPolicy);
        expect(
          await page.evaluate(() => {
            const state = window as typeof window & {
              selfScriptRan?: boolean;
              inlineScriptRan?: boolean;
            };
            return { bundled: state.selfScriptRan, injected: state.inlineScriptRan ?? false };
          })
        ).toEqual({ bundled: true, injected: false });
      } finally {
        await browser.close();
        await app.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000
  );
});
