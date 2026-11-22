// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

// When a newer Grogoni version in another tab upgrades the device database, this tab's handle is
// closed. Sync must stop using it (catch-up, realtime) and tell the user to reload, instead of
// failing on a closed connection on every reconnect.
const sync = vi.hoisted(() => ({
  catchUps: 0,
  flushes: 0,
  realtimeClosed: 0
}));
vi.mock("../apps/web/src/sync/sync-client", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  catchUpAccountSync: vi.fn(async () => {
    sync.catchUps += 1;
    return { changes: 0 };
  }),
  flushLocalSyncMutations: vi.fn(async () => {
    sync.flushes += 1;
    return { transferred: 0 };
  })
}));
vi.mock("../apps/web/src/sync/realtime-client", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  accountRealtimeTransport: () => ({}),
  subscribeToAccountRealtime: () => () => {
    sync.realtimeClosed += 1;
  }
}));

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("sync after a newer version takes the device database", () => {
  it("stops syncing through the closed handle and asks for a reload", async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    const factory = new IDBFactory();
    vi.stubGlobal("indexedDB", factory);
    const { useSyncState } = await import("../apps/web/src/hooks/useSyncState");
    const status: string[] = [];
    function Harness() {
      useSyncState({
        businessId: null,
        session: { account: { id: "account-1" }, user: { id: "user-1" } } as never,
        setStatusMessage: (message) => status.push(message),
        registerReset: () => undefined,
        registerRefresh: () => undefined
      });
      return null;
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<Harness />));
    await vi.waitFor(() => expect(sync.catchUps).toBe(1));

    // Another tab opens a newer version of the database.
    const newer = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open("grogoni-sync", 99);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(status).toContain(
      "Grogoni was updated in another tab. Reload this tab to keep syncing."
    );
    expect(sync.realtimeClosed).toBe(1);

    // Reconnecting no longer syncs through the closed handle.
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(sync.catchUps).toBe(1);
    // Nor are offline changes flushed through it.
    expect(sync.flushes).toBe(1);
    newer.close();
    await act(async () => root.unmount());
  });
});
