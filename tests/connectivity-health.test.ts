// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../apps/web/src/lib/api", () => ({ readApiBaseUrl: () => "/api" }));
let unsubscribe: (() => void) | undefined;
afterEach(() => {
  unsubscribe?.();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("rejects an HTML SPA fallback as API connectivity", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("<html></html>", { headers: { "Content-Type": "text/html" } }))
  );
  const connectivity = await import("../apps/web/src/connectivity");
  unsubscribe = connectivity.subscribeConnectivity(() => {});
  await vi.waitFor(() => expect(connectivity.getConnectivitySnapshot()).toBe("api_unreachable"));
});

it("marks a valid JSON API health response reachable", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ service: "api", status: "ok" }))
  );
  const connectivity = await import("../apps/web/src/connectivity");
  unsubscribe = connectivity.subscribeConnectivity(() => {});
  await vi.waitFor(() => expect(connectivity.getConnectivitySnapshot()).toBe("api_reachable"));
});
