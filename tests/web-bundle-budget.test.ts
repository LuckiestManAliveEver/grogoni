import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("web bundle budget gate", () => {
  it("tracks static entry imports separately from lazy owner and worker chunks", () => {
    const vite = readFileSync("apps/web/vite.config.ts", "utf8");
    const budget = readFileSync("scripts/check-web-bundle-budgets.mjs", "utf8");
    const packageJson = readFileSync("package.json", "utf8");

    expect(vite).toContain("manifest: true");
    expect(budget).toContain("initialJavaScriptGzip");
    expect(budget).toContain("ownerRouteGzip");
    expect(budget).toContain('item.name === "GrogoniApplication"');
    expect(budget).not.toContain("browser-model.worker");
    expect(packageJson).toContain("check:web-bundle-budgets");
  });
});
