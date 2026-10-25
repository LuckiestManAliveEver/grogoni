import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("direct Android installation flow", () => {
  it("adds an explicit /install route and page wiring", () => {
    const routes = readFileSync("apps/web/src/routes.ts", "utf8");
    const router = readFileSync("apps/web/src/AppRouter.tsx", "utf8");

    expect(routes).toContain('install: "/install"');
    expect(router).toContain("routes.install");
    expect(router).toContain("<InstallPage />");
  });

  it("limits the install prompt to a single user-triggered action in the browser", () => {
    const installUtils = readFileSync("apps/web/src/misc-browser-utils.ts", "utf8");

    expect(installUtils).toContain("INSTALL_PROMPT_DISMISSED_KEY");
    expect(installUtils).toContain("localStorage");
    expect(installUtils).toContain("dismissedInstallPrompt");
  });

  it("publishes an Android App Links file for the production package", () => {
    const assetLinksPath = "apps/web/public/.well-known/assetlinks.json";
    expect(existsSync(assetLinksPath)).toBe(true);

    const assetLinks = JSON.parse(readFileSync(assetLinksPath, "utf8"));
    expect(Array.isArray(assetLinks)).toBe(true);
    expect(assetLinks[0]).toMatchObject({
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: "market.grogoni.app"
      }
    });
  });
});
