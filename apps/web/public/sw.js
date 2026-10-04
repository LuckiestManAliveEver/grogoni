/* global URL, Response, caches, self */

const CACHE_PREFIX = "grogoni-app-";
const CACHE_NAME = `${CACHE_PREFIX}v13`;
const STATIC_CACHE = `${CACHE_PREFIX}static-v13`;
const PUBLIC_READ_CACHE = `${CACHE_PREFIX}public-read-v13`;
const ACTIVE_CACHES = new Set([CACHE_NAME, STATIC_CACHE, PUBLIC_READ_CACHE]);
const APP_SHELL = [
  "/",
  "/manifest.webmanifest",
  "/favicon.ico",
  "/icons/grogoni-icon.svg",
  "/icons/grogoni-icon-32.png",
  "/icons/grogoni-icon-192.png",
  "/icons/grogoni-icon-512.png",
  "/icons/grogoni-icon-maskable-512.png",
  "/icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((cacheNames) =>
          Promise.all(
            cacheNames
              .filter(
                (cacheName) =>
                  cacheName.startsWith(CACHE_PREFIX) &&
                  cacheName !== CACHE_NAME &&
                  !ACTIVE_CACHES.has(cacheName)
              )
              .map((cacheName) => caches.delete(cacheName))
          )
        ),
      self.registration.navigationPreload?.enable()
    ]).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (isInteractiveModelRequest(request, url)) {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(
            JSON.stringify({
              code: "interactive_model_offline",
              message: "Connect to the internet to activate this model.",
              recoverable: true
            }),
            {
              status: 503,
              headers: { "content-type": "application/json", "cache-control": "no-store" }
            }
          )
      )
    );
    return;
  }

  if (request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      offlineShellResponse(request).then((cached) => cached || navigationResponse(event))
    );
    return;
  }

  if (isNetworkOnlyRequest(request, url)) {
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      offlineShellResponse(request).then((cached) => cached || cacheFirst(request, STATIC_CACHE))
    );
    return;
  }

  if (url.pathname.startsWith("/tesseract/")) {
    // Cache-verified by apps/web/src/offline-ocr.ts (packages/offline-runtime's
    // cacheArtifactsByUrl), keyed by this same request URL so a worker's own importScripts/fetch
    // for the OCR engine resolves offline with no code here needing to know about that cache.
    // Only an explicit installation may fetch engine assets. A scan must never
    // silently fall back to the network if browser storage has been evicted.
    event.respondWith(
      request.cache === "no-store"
        ? fetch(request)
        : ocrEngineResponse(request).then(
            (cached) =>
              cached ||
              new Response(
                "Offline receipt scanner asset missing. Enable scanning again from Settings.",
                { status: 503 }
              )
          )
    );
    return;
  }

  if (APP_SHELL.includes(url.pathname)) {
    event.respondWith(cacheFirst(request, CACHE_NAME));
    return;
  }

  if (isPublicCatalogueRead(url)) {
    event.respondWith(staleWhileRevalidate(event, request, PUBLIC_READ_CACHE));
  }
});

async function offlineShellResponse(request) {
  const cache = await caches.open("grogoni-offline-shell-v1");
  if (!(await cache.match("/__grogoni_offline_active__"))) return undefined;
  return cache.match(request.mode === "navigate" ? "/" : request);
}

async function ocrEngineResponse(request) {
  const cache = await caches.open("grogoni-ocr-engine-v1");
  return cache.match(request);
}

async function navigationResponse(event) {
  const shellCache = await caches.open(CACHE_NAME);
  const cachedShell = shellCache.match("/");

  try {
    const preloaded = await event.preloadResponse;
    const response = preloaded || (await fetch(event.request));
    if (response.ok && response.headers.get("content-type")?.includes("text/html")) {
      event.waitUntil(shellCache.put("/", response.clone()));
    }
    return response;
  } catch {
    const offlineShell = await cachedShell;
    if (offlineShell !== undefined) return offlineShell;
    return new Response("Grogoni is not available offline yet. Open it once while connected.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached !== undefined) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(event, request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request).then((response) => {
    if (response.ok && response.type !== "opaque") {
      event.waitUntil(cache.put(request, response.clone()));
    }
    return response;
  });
  if (cached !== undefined) {
    event.waitUntil(network.catch(() => undefined));
    return cached;
  }
  return network;
}

function isNetworkOnlyRequest(request, url) {
  return (
    request.headers.has("authorization") ||
    url.pathname.startsWith("/auth/") ||
    url.pathname === "/session" ||
    url.pathname.startsWith("/session/") ||
    url.pathname === "/logout" ||
    url.pathname === "/logout-all" ||
    url.pathname === "/sessions" ||
    url.pathname.startsWith("/sessions/") ||
    url.pathname.startsWith("/businesses/") ||
    url.pathname.startsWith("/v1/conversations") ||
    url.pathname.startsWith("/v1/messages") ||
    url.pathname.startsWith("/v1/models/")
  );
}

function isPublicCatalogueRead(url) {
  return (
    url.pathname.startsWith("/public/storefronts/") || url.pathname.startsWith("/public/catalogue/")
  );
}

function isInteractiveModelRequest(request, url) {
  if (request.method === "GET") return false;
  return (
    /\/businesses\/[^/]+\/(?:agent-model|ai-model)$/.test(url.pathname) ||
    /\/businesses\/[^/]+\/runtime\/sessions(?:\/|$)/.test(url.pathname) ||
    /\/v1\/models\/(?:installed|[^/]+\/validate)$/.test(url.pathname)
  );
}

self.addEventListener("message", (event) => {
  if (event.data?.type !== "message.notification") return;
  event.waitUntil(
    self.registration.showNotification(event.data.title || "New Grogoni message", {
      body: event.data.body || "Open Grogoni to read your message.",
      icon: "/icons/grogoni-icon-192.png",
      badge: "/icons/grogoni-icon-192.png",
      tag: event.data.tag,
      data: {
        conversationId: event.data.conversationId,
        url: event.data.conversationId
          ? `/marketplace/conversations/${encodeURIComponent(event.data.conversationId)}`
          : "/marketplace"
      }
    })
  );
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() || {};
  } catch {
    payload = {};
  }

  // Someone asked to connect or accepted. Handled before the message fallback below, which
  // would otherwise show it as "New Grogoni message". The app's connection prompt shows the request
  // when the app opens or regains focus, so the click only has to bring the app forward.
  if (payload.type === "network.connection") {
    const accepted = payload.event === "accepted";
    event.waitUntil(
      Promise.all([
        self.registration.showNotification(
          payload.title || (accepted ? "New Grogoni connection" : "New connection request on Grogoni"),
          {
            body:
              payload.body ||
              (accepted ? "Open Grogoni to see your network." : "Open Grogoni to accept or decline."),
            icon: "/icons/grogoni-icon-192.png",
            badge: "/icons/grogoni-icon-192.png",
            tag: payload.connectionId
              ? `grogoni-connection-${payload.connectionId}`
              : "grogoni-connection",
            // The same connection can be asked again (after a cancel): alert again, don't update silently.
            renotify: true,
            data: { type: "network.connection", url: accepted ? "/network" : "/" }
          }
        ),
        // An open Grogoni window refreshes right away, without waiting for a click or refocus.
        self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
          for (const client of clients) client.postMessage({ type: "network.connection.changed" });
        })
      ])
    );
    return;
  }

  if (payload.type === "app.update_available") {
    event.waitUntil(
      Promise.all([
        // Fetch the newest sw.js/app-shell right away so the reload the user triggers by
        // opening the notification (see notificationclick below) lands on the new version
        // instead of racing the browser's own periodic update check.
        self.registration.update().catch(() => undefined),
        self.registration.showNotification(payload.title || "Grogoni update available", {
          body: payload.body || "A new version of Grogoni is ready. Open the app to update.",
          icon: "/icons/grogoni-icon-192.png",
          badge: "/icons/grogoni-icon-192.png",
          tag: "grogoni-app-update",
          data: { type: "app.update_available", url: "/" }
        })
      ])
    );
    return;
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || "New Grogoni message", {
      body: "Open Grogoni to read your message.",
      icon: "/icons/grogoni-icon-192.png",
      badge: "/icons/grogoni-icon-192.png",
      tag: payload.messageId ? `grogoni-message-${payload.messageId}` : "grogoni-message",
      data: {
        conversationId: payload.conversationId,
        url: payload.conversationId
          ? `/marketplace/conversations/${encodeURIComponent(payload.conversationId)}`
          : "/marketplace"
      }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  if (event.notification.data?.type === "network.connection") {
    const url = event.notification.data.url || "/";
    event.waitUntil(
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
        const existing = clients[0];
        if (!existing) return self.clients.openWindow(url);
        // Focusing an already visible window fires no focus event: tell the app to recheck.
        existing.postMessage({ type: "network.connection.changed" });
        return existing.focus();
      })
    );
    return;
  }

  if (event.notification.data?.type === "app.update_available") {
    event.waitUntil(
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
        const existing = clients[0];
        if (existing) return existing.focus();
        return self.clients.openWindow("/");
      })
    );
    return;
  }

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const existing = clients[0];
      if (existing) {
        existing.postMessage({
          type: "message.notification.open",
          conversationId: event.notification.data?.conversationId
        });
        return existing.focus();
      }
      const conversationId = event.notification.data?.conversationId;
      const url = conversationId
        ? `/marketplace/conversations/${encodeURIComponent(conversationId)}`
        : event.notification.data?.url || "/marketplace";
      return self.clients.openWindow(url);
    })
  );
});
