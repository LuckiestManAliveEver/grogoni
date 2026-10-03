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
      title: "Grogoni update available",
      body: "The Grogoni API and database just deployed a new version. Open Grogoni to refresh."
    });

    handler?.(event);
    await settled();

    expect(sw.self.registration.update).toHaveBeenCalledTimes(1);
    expect(sw.self.registration.showNotification).toHaveBeenCalledWith(
      "Grogoni update available",
      expect.objectContaining({
        body: "The Grogoni API and database just deployed a new version. Open Grogoni to refresh.",
        tag: "grogoni-app-update",
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
        tag: "grogoni-message-msg-456",
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
});
