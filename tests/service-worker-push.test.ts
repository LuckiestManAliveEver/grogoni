import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

// apps/web/public/sw.js is a plain script (registered as a Service Worker, not bundled through
// Vite), so it is loaded here with the real `self` global replaced by a minimal mock and executed
// with Node's vm module. This exercises the actual shipped file rather than a duplicated copy.
const swSourcePath = fileURLToPath(new URL("../apps/web/public/sw.js", import.meta.url));
const swSource = readFileSync(swSourcePath, "utf8");

interface FakeSelf {
  addEventListener: (event: string, handler: (event: unknown) => void) => void;
  registration: {
    update: ReturnType<typeof vi.fn>;
    showNotification: ReturnType<typeof vi.fn>;
    navigationPreload?: { enable: ReturnType<typeof vi.fn> };
  };
  clients: {
    matchAll: ReturnType<typeof vi.fn>;
    openWindow: ReturnType<typeof vi.fn>;
  };
}

function loadServiceWorker(): { self: FakeSelf; listeners: Map<string, (event: unknown) => void> } {
  const listeners = new Map<string, (event: unknown) => void>();
  const self: FakeSelf = {
    addEventListener: (event, handler) => listeners.set(event, handler),
    registration: {
      update: vi.fn().mockResolvedValue(undefined),
      showNotification: vi.fn().mockResolvedValue(undefined)
    },
    clients: {
      matchAll: vi.fn().mockResolvedValue([]),
      openWindow: vi.fn().mockResolvedValue(undefined)
    }
  };
  const context = createContext({ self, caches: undefined, URL, Response });
  runInContext(swSource, context);
  return { self, listeners };
}

function pushEvent(payload: unknown) {
  let waited: Promise<unknown> = Promise.resolve();
  const event = {
    data: { json: () => payload },
    waitUntil: (promise: Promise<unknown>) => {
      waited = promise;
    }
  };
  return { event, settled: () => waited };
}

function notificationClickEvent(data: unknown) {
  let waited: Promise<unknown> = Promise.resolve();
  const event = {
    notification: { close: vi.fn(), data },
    waitUntil: (promise: Promise<unknown>) => {
      waited = promise;
    }
  };
  return { event, settled: () => waited };
}

describe("service worker: app-update push notifications", () => {
  let sw: ReturnType<typeof loadServiceWorker>;

  beforeEach(() => {
    sw = loadServiceWorker();
  });

  it("shows an update-available notification and checks for a fresh worker", async () => {
    const handler = sw.listeners.get("push");
    expect(handler).toBeDefined();
    const { event, settled } = pushEvent({
      type: "app.update_available",
      title: "Soko update available",
      body: "The Soko API and database just deployed a new version. Open Soko to refresh."
    });

    handler?.(event);
    await settled();

    expect(sw.self.registration.update).toHaveBeenCalledTimes(1);
    expect(sw.self.registration.showNotification).toHaveBeenCalledWith(
      "Soko update available",
      expect.objectContaining({
        body: "The Soko API and database just deployed a new version. Open Soko to refresh.",
        tag: "soko-app-update",
        data: { type: "app.update_available", url: "/" }
      })
    );
  });

  it("leaves the existing message.new push behavior untouched", async () => {
    const handler = sw.listeners.get("push");
    const { event, settled } = pushEvent({
      type: "message.new",
      title: "New message from Amina",
      conversationId: "conv-123",
      messageId: "msg-456"
    });

    handler?.(event);
    await settled();

    expect(sw.self.registration.update).not.toHaveBeenCalled();
    expect(sw.self.registration.showNotification).toHaveBeenCalledWith(
      "New message from Amina",
      expect.objectContaining({
        tag: "soko-message-msg-456",
        data: { conversationId: "conv-123", url: "/marketplace/conversations/conv-123" }
      })
    );
  });

  it("opens the app root on click when no window is already open", async () => {
    const handler = sw.listeners.get("notificationclick");
    const { event, settled } = notificationClickEvent({ type: "app.update_available", url: "/" });

    handler?.(event);
    await settled();

    expect(event.notification.close).toHaveBeenCalledTimes(1);
    expect(sw.self.clients.openWindow).toHaveBeenCalledWith("/");
  });

  it("focuses an already-open window on click instead of opening a new one", async () => {
    const focus = vi.fn().mockResolvedValue(undefined);
    sw.self.clients.matchAll.mockResolvedValueOnce([{ focus }]);
    const handler = sw.listeners.get("notificationclick");
    const { event, settled } = notificationClickEvent({ type: "app.update_available", url: "/" });

    handler?.(event);
    await settled();

    expect(focus).toHaveBeenCalledTimes(1);
    expect(sw.self.clients.openWindow).not.toHaveBeenCalled();
  });

  it("shows a connection request as its own notification, not a chat message", async () => {
    const handler = sw.listeners.get("push");
    const { event, settled } = pushEvent({
      type: "network.connection",
      connectionId: "c-1",
      event: "requested",
      title: "Amina wants to connect on Soko",
      body: "Open Soko to accept or decline."
    });

    handler?.(event);
    await settled();

    expect(sw.self.registration.showNotification).toHaveBeenCalledWith(
      "Amina wants to connect on Soko",
      expect.objectContaining({
        body: "Open Soko to accept or decline.",
        tag: "soko-connection-c-1",
        data: { type: "network.connection", url: "/" }
      })
    );
  });

  it("tells an open window to recheck and brings it forward when a connection notification is clicked", async () => {
    const focus = vi.fn().mockResolvedValue(undefined);
    const postMessage = vi.fn();
    sw.self.clients.matchAll.mockResolvedValueOnce([{ focus, postMessage }]);
    const handler = sw.listeners.get("notificationclick");
    const { event, settled } = notificationClickEvent({ type: "network.connection", url: "/" });

    handler?.(event);
    await settled();

    expect(postMessage).toHaveBeenCalledWith({ type: "network.connection.changed" });
    expect(focus).toHaveBeenCalledTimes(1);
    expect(sw.self.clients.openWindow).not.toHaveBeenCalled();
  });

  it("opens the app where the connection shows when no window is open", async () => {
    const handler = sw.listeners.get("notificationclick");
    const accepted = notificationClickEvent({ type: "network.connection", url: "/network" });
    handler?.(accepted.event);
    await accepted.settled();
    expect(sw.self.clients.openWindow).toHaveBeenCalledWith("/network");
  });

  it("refreshes open windows when a connection push arrives, and alerts again for a repeat", async () => {
    const postMessage = vi.fn();
    sw.self.clients.matchAll.mockResolvedValueOnce([{ postMessage }]);
    const handler = sw.listeners.get("push");
    const { event, settled } = pushEvent({
      type: "network.connection",
      connectionId: "c-2",
      event: "accepted",
      title: "You are now connected with Amina",
      body: "Open Soko to see your network."
    });

    handler?.(event);
    await settled();

    expect(postMessage).toHaveBeenCalledWith({ type: "network.connection.changed" });
    expect(sw.self.registration.showNotification).toHaveBeenCalledWith(
      "You are now connected with Amina",
      expect.objectContaining({
        renotify: true,
        data: { type: "network.connection", url: "/network" }
      })
    );
  });
});
