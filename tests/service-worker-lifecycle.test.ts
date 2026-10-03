import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

/**
 * Behavioral (not just source-string) coverage for apps/web/public/sw.js's install/activate/fetch
 * handlers, run the same way tests/service-worker-push.test.ts already runs the file: as a plain
 * script inside a Node vm context with a minimal mocked `self`/`caches`/`fetch`, so this exercises
 * the actual shipped file rather than a reimplementation of its logic.
 */
const swSourcePath = fileURLToPath(new URL("../apps/web/public/sw.js", import.meta.url));
const swSource = readFileSync(swSourcePath, "utf8");
const origin = "https://grogoni.com";

class MockCache {
  store = new Map<string, Response>();

  private key(request: MockRequest | string): string {
    const url = typeof request === "string" ? request : request.url;
    return url.startsWith("/") ? url : new URL(url).pathname;
  }

  async match(request: MockRequest | string): Promise<Response | undefined> {
    return this.store.get(this.key(request));
  }

  async put(request: MockRequest | string, response: Response): Promise<void> {
    this.store.set(this.key(request), response);
  }

  async addAll(requests: string[]): Promise<void> {
    for (const path of requests) {
      this.store.set(path, new Response(`precached:${path}`, { status: 200 }));
    }
  }

  async delete(request: MockRequest | string): Promise<boolean> {
    return this.store.delete(this.key(request));
  }
}

class MockCacheStorage {
  caches = new Map<string, MockCache>();

  async open(name: string): Promise<MockCache> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new MockCache();
      this.caches.set(name, cache);
    }
    return cache;
  }

  async keys(): Promise<string[]> {
    return [...this.caches.keys()];
  }

  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }

  /** Test helper: seed a cache directly, as if an earlier deployment's service worker created it. */
  seed(name: string, entries: Record<string, string> = {}): MockCache {
    const cache = new MockCache();
    for (const [path, body] of Object.entries(entries)) {
      cache.store.set(path, new Response(body, { status: 200 }));
    }
    this.caches.set(name, cache);
    return cache;
  }
}

interface MockRequest {
  url: string;
  mode: "navigate" | "same-origin" | "no-cors" | "cors";
  method: string;
  headers: { has: (name: string) => boolean };
  cache?: string | undefined;
}

function makeRequest(
  path: string,
  overrides: Partial<Omit<MockRequest, "url" | "headers">> & {
    headers?: string[];
    originOverride?: string;
  } = {}
): MockRequest {
  const headerSet = new Set((overrides.headers ?? []).map((h) => h.toLowerCase()));
  return {
    url: `${overrides.originOverride ?? origin}${path}`,
    mode: overrides.mode ?? "same-origin",
    method: overrides.method ?? "GET",
    headers: { has: (name: string) => headerSet.has(name.toLowerCase()) },
    cache: overrides.cache
  };
}

interface FakeSelf {
  addEventListener: (event: string, handler: (event: unknown) => void) => void;
  skipWaiting: ReturnType<typeof vi.fn>;
  clients: { claim: ReturnType<typeof vi.fn> };
  registration: { navigationPreload: { enable: ReturnType<typeof vi.fn> } };
  location: { origin: string };
}

function loadServiceWorker(fetchImpl: (request: MockRequest) => Promise<Response>) {
  const listeners = new Map<string, (event: unknown) => void>();
  const self: FakeSelf = {
    addEventListener: (event, handler) => listeners.set(event, handler),
    skipWaiting: vi.fn().mockResolvedValue(undefined),
    clients: { claim: vi.fn().mockResolvedValue(undefined) },
    registration: { navigationPreload: { enable: vi.fn().mockResolvedValue(undefined) } },
    location: { origin }
  };
  const caches = new MockCacheStorage();
  const context = createContext({ self, caches, URL, Response, fetch: fetchImpl });
  runInContext(swSource, context);
  return { self, listeners, caches };
}

function fetchEvent(request: MockRequest, preloadResponse?: Promise<Response | undefined>) {
  const waited: Promise<unknown>[] = [];
  let responded: Promise<Response> | undefined;
  const event = {
    request,
    preloadResponse: preloadResponse ?? Promise.resolve(undefined),
    respondWith: (value: Promise<Response> | Response) => {
      responded = Promise.resolve(value);
    },
    waitUntil: (promise: Promise<unknown>) => {
      waited.push(promise);
    }
  };
  return {
    event,
    handled: () => responded !== undefined,
    resolve: async () => {
      const response = responded && (await responded);
      await Promise.all(waited);
      return response;
    }
  };
}

async function runInstallAndActivate(sw: ReturnType<typeof loadServiceWorker>) {
  const installWaited: Promise<unknown>[] = [];
  sw.listeners.get("install")?.({ waitUntil: (p: Promise<unknown>) => installWaited.push(p) });
  await Promise.all(installWaited);

  const activateWaited: Promise<unknown>[] = [];
  sw.listeners.get("activate")?.({ waitUntil: (p: Promise<unknown>) => activateWaited.push(p) });
  await Promise.all(activateWaited);
}

describe("service worker: install / activate lifecycle", () => {
  it("precaches the app shell and skips waiting on install", async () => {
    const sw = loadServiceWorker(async () => new Response("network", { status: 200 }));
    const installWaited: Promise<unknown>[] = [];
    sw.listeners.get("install")?.({ waitUntil: (p: Promise<unknown>) => installWaited.push(p) });
    await Promise.all(installWaited);

    expect(sw.self.skipWaiting).toHaveBeenCalledTimes(1);
    const shell = sw.caches.caches.get("grogoni-app-v13");
    expect(shell).toBeDefined();
    expect(await shell?.match("/manifest.webmanifest")).toBeDefined();
  });

  it("deletes obsolete versioned caches on activate while preserving current and unrelated caches", async () => {
    const sw = loadServiceWorker(async () => new Response("network", { status: 200 }));

    // Simulate caches left behind by earlier deployments (requirement: cache migration for
    // existing installs), the current version's own caches, and caches this worker must never
    // touch because they hold deliberate offline/runtime data, not app-shell precache.
    sw.caches.seed("grogoni-app-v10", { "/": "old shell v10" });
    sw.caches.seed("grogoni-app-static-v10", { "/assets/app-old.js": "old asset" });
    sw.caches.seed("grogoni-app-public-read-v10", {});
    sw.caches.seed("grogoni-app-v13", { "/": "current shell" });
    sw.caches.seed("grogoni-app-static-v13", {});
    sw.caches.seed("grogoni-app-public-read-v13", {});
    sw.caches.seed("grogoni-offline-shell-v1", {
      "/__grogoni_offline_active__": "active",
      "/": "offline shell for deliberate offline mode"
    });
    sw.caches.seed("grogoni-ocr-engine-v1", { "/tesseract/worker.min.js": "ocr engine" });

    const activateWaited: Promise<unknown>[] = [];
    sw.listeners.get("activate")?.({ waitUntil: (p: Promise<unknown>) => activateWaited.push(p) });
    await Promise.all(activateWaited);

    const remaining = new Set(await sw.caches.keys());
    expect(remaining.has("grogoni-app-v10")).toBe(false);
    expect(remaining.has("grogoni-app-static-v10")).toBe(false);
    expect(remaining.has("grogoni-app-public-read-v10")).toBe(false);

    expect(remaining.has("grogoni-app-v13")).toBe(true);
    expect(remaining.has("grogoni-app-static-v13")).toBe(true);
    expect(remaining.has("grogoni-app-public-read-v13")).toBe(true);

    // Customer/seller offline data must survive an app-shell cache-version bump.
    expect(remaining.has("grogoni-offline-shell-v1")).toBe(true);
    expect(remaining.has("grogoni-ocr-engine-v1")).toBe(true);
    const offlineShell = sw.caches.caches.get("grogoni-offline-shell-v1");
    expect(await offlineShell?.match("/__grogoni_offline_active__")).toBeDefined();
    expect(await offlineShell?.match("/")).toBeDefined();
    const ocrEngine = sw.caches.caches.get("grogoni-ocr-engine-v1");
    expect(await ocrEngine?.match("/tesseract/worker.min.js")).toBeDefined();

    expect(sw.self.registration.navigationPreload.enable).toHaveBeenCalledTimes(1);
    expect(sw.self.clients.claim).toHaveBeenCalledTimes(1);
  });
});

describe("service worker: navigation requests are network-first", () => {
  it("fetches a fresh app shell over the network and refreshes the cache with it", async () => {
    const freshHtml = new Response("<html>v14 shell</html>", {
      status: 200,
      headers: { "content-type": "text/html" }
    });
    const fetchImpl = vi.fn().mockResolvedValue(freshHtml);
    const sw = loadServiceWorker(fetchImpl);
    await runInstallAndActivate(sw);

    const request = makeRequest("/", { mode: "navigate" });
    const { event, resolve } = fetchEvent(request);
    sw.listeners.get("fetch")?.(event);
    const response = await resolve();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await response?.text()).toBe("<html>v14 shell</html>");

    const shell = sw.caches.caches.get("grogoni-app-v13");
    const cachedRoot = await shell?.match("/");
    expect(await cachedRoot?.text()).toBe("<html>v14 shell</html>");
  });

  it("never serves index.html cache-first: a warm cache is still bypassed for a live fetch", async () => {
    const stale = new Response("<html>stale</html>", {
      status: 200,
      headers: { "content-type": "text/html" }
    });
    const fresh = new Response("<html>new deployment</html>", {
      status: 200,
      headers: { "content-type": "text/html" }
    });
    const fetchImpl = vi.fn().mockResolvedValue(fresh);
    const sw = loadServiceWorker(fetchImpl);
    await runInstallAndActivate(sw);
    const shell = sw.caches.caches.get("grogoni-app-v13");
    await shell?.put("/", stale);

    const request = makeRequest("/", { mode: "navigate" });
    const { event, resolve } = fetchEvent(request);
    sw.listeners.get("fetch")?.(event);
    const response = await resolve();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await response?.text()).toBe("<html>new deployment</html>");
  });

  it("falls back to the last cached shell only when the network truly fails (offline)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("network error"));
    const sw = loadServiceWorker(fetchImpl);
    await runInstallAndActivate(sw);
    const shell = sw.caches.caches.get("grogoni-app-v13");
    await shell?.put("/", new Response("<html>last known good</html>", { status: 200 }));

    const request = makeRequest("/", { mode: "navigate" });
    const { event, resolve } = fetchEvent(request);
    sw.listeners.get("fetch")?.(event);
    const response = await resolve();

    expect(await response?.text()).toBe("<html>last known good</html>");
  });

  it("returns a 503 rather than nothing when offline with no shell cached yet", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("network error"));
    const sw = loadServiceWorker(fetchImpl);
    await runInstallAndActivate(sw);
    // Simulate a brand-new install whose one-time app-shell precache never included "/".
    const shell = sw.caches.caches.get("grogoni-app-v13");
    await shell?.delete("/");

    const request = makeRequest("/", { mode: "navigate" });
    const { event, resolve } = fetchEvent(request);
    sw.listeners.get("fetch")?.(event);
    const response = await resolve();

    expect(response?.status).toBe(503);
  });

  it("prefers a valid navigation preload response over a second network round trip", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("should not be used", { status: 200 }));
    const sw = loadServiceWorker(fetchImpl);
    await runInstallAndActivate(sw);

    const preloaded = new Response("<html>preloaded</html>", {
      status: 200,
      headers: { "content-type": "text/html" }
    });
    const request = makeRequest("/", { mode: "navigate" });
    const { event, resolve } = fetchEvent(request, Promise.resolve(preloaded));
    sw.listeners.get("fetch")?.(event);
    const response = await resolve();

    expect(await response?.text()).toBe("<html>preloaded</html>");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("service worker: hashed static assets stay cache-first", () => {
  it("serves a hashed asset from cache on the second request without a second fetch", async () => {
    const assetBody = "console.log('app-a83f21')";
    const fetchImpl = vi.fn().mockResolvedValue(new Response(assetBody, { status: 200 }));
    const sw = loadServiceWorker(fetchImpl);
    await runInstallAndActivate(sw);

    const request = makeRequest("/assets/app-a83f21.js");
    const first = fetchEvent(request);
    sw.listeners.get("fetch")?.(first.event);
    const firstResponse = await first.resolve();
    expect(await firstResponse?.text()).toBe(assetBody);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const second = fetchEvent(request);
    sw.listeners.get("fetch")?.(second.event);
    const secondResponse = await second.resolve();
    expect(await secondResponse?.text()).toBe(assetBody);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // still 1: served from STATIC_CACHE, not the network
  });

  it("a new deployment's differently-hashed asset is fetched and cached independently", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("v13 asset", { status: 200 }))
      .mockResolvedValueOnce(new Response("v14 asset", { status: 200 }));
    const sw = loadServiceWorker(fetchImpl);
    await runInstallAndActivate(sw);

    const old = fetchEvent(makeRequest("/assets/app-a83f21.js"));
    sw.listeners.get("fetch")?.(old.event);
    await old.resolve();

    const next = fetchEvent(makeRequest("/assets/app-b91cc4.js"));
    sw.listeners.get("fetch")?.(next.event);
    const nextResponse = await next.resolve();

    expect(await nextResponse?.text()).toBe("v14 asset");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const staticCache = sw.caches.caches.get("grogoni-app-static-v13");
    expect(await staticCache?.match("/assets/app-a83f21.js")).toBeDefined();
    expect(await staticCache?.match("/assets/app-b91cc4.js")).toBeDefined();
  });
});

describe("service worker: private/API traffic is never served from an app-shell cache", () => {
  const privatePaths = [
    "/auth/login",
    "/session",
    "/businesses/biz_1/orders",
    "/v1/conversations/abc",
    "/v1/messages/abc",
    "/v1/models/installed"
  ];

  it.each(privatePaths)(
    "leaves %s untouched so the browser sends it straight to the network",
    async (path) => {
      const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      const sw = loadServiceWorker(fetchImpl);
      await runInstallAndActivate(sw);

      const { event, handled } = fetchEvent(makeRequest(path));
      sw.listeners.get("fetch")?.(event);

      expect(handled()).toBe(false);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  );

  it("never intercepts cross-origin requests (the production API origin)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const sw = loadServiceWorker(fetchImpl);
    await runInstallAndActivate(sw);

    const { event, handled } = fetchEvent(
      makeRequest("/v1/products", { originOverride: "https://grogoni.com" })
    );
    sw.listeners.get("fetch")?.(event);

    expect(handled()).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("service worker: deliberate offline mode overrides normal routing without losing data", () => {
  it("serves the installed offline shell for navigation once offline mode is active", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("network shell", { status: 200 }));
    const sw = loadServiceWorker(fetchImpl);
    await runInstallAndActivate(sw);

    const offlineShell = sw.caches.seed("grogoni-offline-shell-v1", {
      "/__grogoni_offline_active__": "active",
      "/": "offline install shell"
    });

    const { event, resolve } = fetchEvent(makeRequest("/", { mode: "navigate" }));
    sw.listeners.get("fetch")?.(event);
    const response = await resolve();

    expect(await response?.text()).toBe("offline install shell");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await offlineShell.match("/__grogoni_offline_active__")).toBeDefined();
  });
});
