import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, isDefinitiveAuthenticationError } from "../apps/web/src/lib/api";

/**
 * The 15 minute session expiry (docs/frontend/frontend.md, "Session expiry and silent refresh").
 * The fake server follows the Edge API's rules (supabase/functions/api/auth-routes.ts): the access
 * cookie lapses after 15 minutes, a refresh rotates the session and revokes the old one at once,
 * and every request is judged by the cookie it carried when it was sent.
 */
interface FakeServer {
  jar: { session: string | null };
  validSessions: Set<string>;
  refreshAllowed: boolean;
  refreshRequests: number;
  latencyMs: Record<string, number>;
}

let server: FakeServer;
let storage: Map<string, string>;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

/** Another tab sharing the cookie jar refreshes: new cookie and a new stored generation. */
function refreshInAnotherTab() {
  const next = `other-tab-${server.refreshRequests}`;
  server.validSessions.clear();
  server.validSessions.add(next);
  server.jar.session = next;
  storage.set("grogoni.session-generation.v1", `other-tab-generation-${next}`);
}

beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value)
  });
  vi.stubGlobal("navigator", { platform: "Android" });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  // The access cookie already lapsed (Max-Age=900) and its row is past expires_at.
  server = {
    jar: { session: null },
    validSessions: new Set(),
    refreshAllowed: true,
    refreshRequests: 0,
    latencyMs: { "/a": 10, "/b": 30, "/c": 50, "/d": 70 }
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      const sentCookie = server.jar.session;
      if (path === "/auth/session/refresh") {
        server.refreshRequests += 1;
        await delay(15);
        if (!server.refreshAllowed)
          return jsonResponse(401, {
            code: "auth_refresh_expired",
            message: "The refresh session has expired."
          });
        // Rotation: the previous session is revoked, a new one replaces it in the cookie jar.
        const next = `session-${server.refreshRequests}`;
        server.validSessions.clear();
        server.validSessions.add(next);
        server.jar.session = next;
        return jsonResponse(200, { authenticated: true });
      }
      await delay(server.latencyMs[path] ?? 10);
      if (path === "/auth/oauth/providers") return jsonResponse(200, { providers: [] });
      return sentCookie !== null && server.validSessions.has(sentCookie)
        ? jsonResponse(200, { path, session: sentCookie })
        : jsonResponse(401, { code: "auth_required", message: "Authentication is required." });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session restore after the 15 minute expiry", () => {
  it("recovers every in-flight read with one refresh, even when 401s land after it", async () => {
    // /b, /c and /d were sent before the refresh landed, so they carry no cookie and answer 401
    // after it finished. Each must retry on the new session, not rotate it away from the others.
    const results = await Promise.allSettled(
      ["/a", "/b", "/c", "/d"].map((path) => apiFetch<{ path: string }>(path))
    );

    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "fulfilled",
      "fulfilled"
    ]);
    expect(server.refreshRequests).toBe(1);
  });

  it("retries without rotating again when another tab refreshed meanwhile", async () => {
    const pending = apiFetch<{ session: string }>("/b");
    await delay(5);
    refreshInAnotherTab();

    await expect(pending).resolves.toMatchObject({ session: server.jar.session });
    expect(server.refreshRequests).toBe(0);
  });

  it("refreshes even when a public auth read succeeds while the request is in flight", async () => {
    // The cold load after expiry: /auth/oauth/providers (public, under the /auth/oauth/ entry
    // points) answers 200 while /auth/bootstrap is still out. That is not a new session.
    const bootstrap = apiFetch<{ path: string }>("/b");
    await apiFetch("/auth/oauth/providers").catch(() => undefined);

    await expect(bootstrap).resolves.toMatchObject({ path: "/b" });
    expect(server.refreshRequests).toBe(1);
  });

  it("still refreshes when the current session expires later", async () => {
    await apiFetch("/a");
    expect(server.refreshRequests).toBe(1);

    server.validSessions.clear();
    server.jar.session = null;
    await expect(apiFetch("/a")).resolves.toMatchObject({ path: "/a" });
    expect(server.refreshRequests).toBe(2);
  });

  it("reports a definitive sign-in failure, once, when the refresh itself has expired", async () => {
    // Past inactivity_expires_at (30 days idle): no silent path left, the app must ask to sign in.
    server.refreshAllowed = false;
    const failure = await apiFetch("/a").catch((error: unknown) => error);

    expect(isDefinitiveAuthenticationError(failure)).toBe(true);
    expect(server.refreshRequests).toBe(1);
  });
});
