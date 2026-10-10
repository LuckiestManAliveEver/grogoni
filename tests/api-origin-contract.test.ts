import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Production serves the web app at https://grogoni.com and the API under /api (vercel.json
// rewrites /api/* to the Supabase Edge function). Every client must point at /api; an API call to
// the bare origin gets the SPA's HTML or a 405 from the static host.
const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as {
  rewrites: { source: string; destination: string }[];
};
const gradle = readFileSync("apps/android/app/build.gradle.kts", "utf8");

describe("production API origin contract", () => {
  it("serves the API under /api before the SPA fallback", () => {
    const apiIndex = vercel.rewrites.findIndex((rewrite) => rewrite.source === "/api/:path*");
    const spaIndex = vercel.rewrites.findIndex((rewrite) => rewrite.source === "/(.*)");
    expect(apiIndex).toBeGreaterThanOrEqual(0);
    expect(vercel.rewrites[apiIndex]?.destination).toMatch(
      /^https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1\/api\/:path\*(?:\?[^/]*)?$/u
    );
    expect(apiIndex).toBeLessThan(spaIndex);
  });

  it("serves MCP OAuth discovery where spec-following clients look first", () => {
    // MCP authorization: for an issuer with a path, clients try RFC 8414 path insertion first;
    // protected-resource metadata uses RFC 9728 path insertion. Without these rewrites the SPA
    // fallback answers both with index.html (HTTP 200, text/html) and discovery fails.
    const issuer = new URL("https://grogoni.com/api");
    const resource = new URL("https://grogoni.com/api/mcp");
    const required = [
      [`/.well-known/oauth-authorization-server${issuer.pathname}`, "oauth-authorization-server"],
      [`/.well-known/oauth-protected-resource${resource.pathname}`, "oauth-protected-resource"]
    ] as const;
    const spaIndex = vercel.rewrites.findIndex((rewrite) => rewrite.source === "/(.*)");
    for (const [source, document] of required) {
      const index = vercel.rewrites.findIndex((rewrite) => rewrite.source === source);
      expect(index, source).toBeGreaterThanOrEqual(0);
      expect(index, source).toBeLessThan(spaIndex);
      expect(vercel.rewrites[index]?.destination).toMatch(
        new RegExp(`/functions/v1/api/\\.well-known/${document}(?:\\?[^/]*)?$`, "u")
      );
    }
  });

  it("points the Android app at the production API, not the web app", () => {
    const fallback = /GROGONI_API_ORIGIN"\)\s*\.orElse\("([^"]+)"\)/u.exec(gradle)?.[1];
    expect(fallback).toBe("https://grogoni.com/api");
  });
});
