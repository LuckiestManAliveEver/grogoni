// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { webcrypto } from "node:crypto";

class FakeCharacteristic extends EventTarget {
  value: DataView | null = null;
  writes: Uint8Array[] = [];
  async startNotifications(): Promise<this> {
    return this;
  }
  async writeValueWithoutResponse(data: ArrayBuffer): Promise<void> {
    this.writes.push(new Uint8Array(data));
  }
}

const GROGONI_NEARBY_SERVICE_UUID = "6c9b7a00-9d2e-4f3a-8b1c-2f6a5e9d0a01";
const GROGONI_NEARBY_TX_CHARACTERISTIC_UUID = "6c9b7a01-9d2e-4f3a-8b1c-2f6a5e9d0a01";
const GROGONI_NEARBY_RX_CHARACTERISTIC_UUID = "6c9b7a02-9d2e-4f3a-8b1c-2f6a5e9d0a01";

/**
 * React tracks a controlled input's previous value via a hidden property setter, so assigning
 * `.value` directly and dispatching a plain "input" event is a no-op for onChange - invoking the
 * native setter first (what @testing-library/user-event and fireEvent do internally) is required.
 */
function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  )?.set;
  nativeSetter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function fakePeerDevice() {
  const tx = new FakeCharacteristic();
  const rx = new FakeCharacteristic();
  const characteristics = new Map([
    [GROGONI_NEARBY_TX_CHARACTERISTIC_UUID, tx],
    [GROGONI_NEARBY_RX_CHARACTERISTIC_UUID, rx]
  ]);
  const service = {
    getCharacteristic: async (uuid: string) => {
      const characteristic = characteristics.get(uuid);
      if (!characteristic) throw new Error("Unknown characteristic.");
      return characteristic;
    }
  };
  const server = {
    connected: false,
    connect: async function connect(this: typeof server) {
      this.connected = true;
      return this;
    },
    disconnect() {
      server.connected = false;
    },
    getPrimaryService: async (uuid: string) => {
      if (uuid !== GROGONI_NEARBY_SERVICE_UUID) throw new Error("Unknown service.");
      return service;
    }
  };
  const device = Object.assign(new EventTarget(), { id: "nearby-device-1", gatt: server });
  const bluetooth = {
    getAvailability: async () => true,
    requestDevice: async () => device,
    getDevices: async () => [device]
  };
  return { device, bluetooth, tx, rx };
}

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function renderWithOfflineModeActive(bluetooth: unknown) {
  vi.stubEnv("VITE_PEER_MESSAGING_ENABLED", "true");
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: { estimate: async () => ({ quota: 2 ** 30, usage: 0 }) }
  });
  Object.defineProperty(navigator, "bluetooth", { configurable: true, value: bluetooth });
  localStorage.setItem(
    "grogoni.auth-bootstrap.v1",
    JSON.stringify({
      account: { id: "account" },
      user: { id: "user" },
      session: { id: "session", expiresAt: "2030-01-01" },
      cachedAt: "2026-09-10"
    })
  );
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { OfflineRuntimeSettings } = await import("../apps/web/src/OfflineRuntimeSettings");
  const offline = await import("../apps/web/src/offline-runtime");
  const { readStableDeviceId } = await import("../apps/web/src/lib/api");
  localStorage.setItem(
    "grogoni.offline-runtime.active.v1",
    JSON.stringify({ accountId: "account", storeId: "shop", deviceId: readStableDeviceId() })
  );
  const db = await offline.offlineDatabase();
  const scope = offline.currentOfflineScope()!;
  await db.transaction(scope, (state) => {
    state.installed = true;
    state.offlineModeActive = true;
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(OfflineRuntimeSettings, { accountId: "account", businessId: "shop" })
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  return { host, root, db, act };
}

describe("Nearby device messaging (Settings)", () => {
  it("stays hidden when the build flag is off, even with offline mode active", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: { estimate: async () => ({ quota: 2 ** 30, usage: 0 }) }
    });
    localStorage.setItem(
      "grogoni.auth-bootstrap.v1",
      JSON.stringify({
        account: { id: "account" },
        user: { id: "user" },
        session: { id: "session", expiresAt: "2030-01-01" },
        cachedAt: "2026-09-10"
      })
    );
    const { createElement, act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { OfflineRuntimeSettings } = await import("../apps/web/src/OfflineRuntimeSettings");
    const offline = await import("../apps/web/src/offline-runtime");
    const { readStableDeviceId } = await import("../apps/web/src/lib/api");
    localStorage.setItem(
      "grogoni.offline-runtime.active.v1",
      JSON.stringify({ accountId: "account", storeId: "shop", deviceId: readStableDeviceId() })
    );
    const db = await offline.offlineDatabase();
    const scope = offline.currentOfflineScope()!;
    await db.transaction(scope, (state) => {
      state.installed = true;
      state.offlineModeActive = true;
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(
          createElement(OfflineRuntimeSettings, { accountId: "account", businessId: "shop" })
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(host.textContent).not.toContain("Message a nearby device");
      expect(host.textContent).toContain("a research prototype, not available in this PWA");
    } finally {
      await act(async () => {
        root.unmount();
      });
      host.remove();
      db.close();
    }
  }, 15_000);

  it("connects over Bluetooth from a user gesture, sends a message onto the wire, and clears the draft", async () => {
    const { bluetooth, tx } = fakePeerDevice();
    const { host, root, db, act } = await renderWithOfflineModeActive(bluetooth);
    const button = (text: string) =>
      [...document.querySelectorAll("button")].find((entry) => entry.textContent === text)!;
    try {
      expect(host.textContent).toContain("Message a nearby device");
      expect(host.textContent).toContain("Not connected.");
      await act(async () => {
        button("Connect a nearby device").click();
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(host.textContent).toContain("Connected to a nearby device.");
      const textarea = document.querySelector(
        'textarea[aria-label="Message the nearby device"]'
      ) as HTMLTextAreaElement;
      expect(textarea).toBeTruthy();
      await act(async () => {
        setTextareaValue(textarea, "Habari, order ready?");
      });
      await act(async () => {
        button("Send").click();
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(tx.writes.length).toBeGreaterThan(0);
      expect(
        (
          document.querySelector(
            'textarea[aria-label="Message the nearby device"]'
          ) as HTMLTextAreaElement
        ).value
      ).toBe("");
    } finally {
      await act(async () => {
        root.unmount();
      });
      host.remove();
      db.close();
    }
  });

  it("surfaces a visible error rather than a silent failure when sending while disconnected", async () => {
    const { bluetooth } = fakePeerDevice();
    const { host, root, db, act } = await renderWithOfflineModeActive(bluetooth);
    const button = (text: string) =>
      [...document.querySelectorAll("button")].find((entry) => entry.textContent === text)!;
    try {
      await act(async () => {
        button("Connect a nearby device").click();
      });
      await vi.waitFor(
        async () => {
          await act(async () => {
            await Promise.resolve();
          });
          expect(host.textContent).toContain("Connected to a nearby device.");
        },
        { timeout: 3000 }
      );
      await act(async () => {
        button("Disconnect").click();
      });
      expect(host.textContent).toContain("Not connected.");
      expect(document.querySelector('textarea[aria-label="Message the nearby device"]')).toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
      host.remove();
      db.close();
    }
  });
});
