import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("apps/web/public/sw.js", "utf8");

describe("service-worker route policies", () => {
  it("uses fresh navigation responses before falling back to the offline shell", () => {
    expect(source).toContain("navigationPreload?.enable()");
    expect(source).toContain("navigationResponse(event)");
    expect(source).toContain("shellCache.match");
    expect(source).toContain("event.preloadResponse");
    expect(source.indexOf("await event.preloadResponse")).toBeLessThan(
      source.indexOf("await cachedShell")
    );
  });

  it("caches static assets and leaves all public API reads network-only", () => {
    expect(source).toContain("cacheFirst(request, STATIC_CACHE)");
    expect(source).not.toContain("staleWhileRevalidate");
    expect(source).toContain('url.pathname.startsWith("/public/")');
  });

  it("keeps authentication, private business data, messaging, and model APIs network-only", () => {
    const policyStart = source.indexOf("function isNetworkOnlyRequest");
    const policy = source.slice(policyStart, source.indexOf("function isInteractiveModelRequest"));

    expect(policy).toContain('url.pathname.startsWith("/auth/")');
    expect(policy).toContain('url.pathname.startsWith("/businesses/")');
    expect(policy).toContain('url.pathname.startsWith("/v1/conversations")');
    expect(policy).toContain('url.pathname.startsWith("/v1/messages")');
    expect(policy).toContain('url.pathname.startsWith("/v1/models/")');
  });
});
