// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openIndexedDbSyncRepository } from "../apps/web/src/sync/indexeddb-repository";

// Sends await the device outbox. A tab on an older app version holds the device database open,
// which blocks a version upgrade indefinitely; and a database can fail to open at all. Neither may
// hang or fail a send: the outbox falls back to localStorage.
const openRaw = (factory: IDBFactory, version: number) =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open("grogoni-sync", version);
    request.onupgradeneeded = () => undefined;
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("outbox storage resilience", () => {
  it("fails fast instead of waiting forever when an older tab blocks the upgrade", async () => {
    const factory = new IDBFactory();
    // An old tab: version 2, open, and never yielding (no versionchange handler).
    const oldTab = await openRaw(factory, 2);
    try {
      await expect(openIndexedDbSyncRepository({ factory })).rejects.toThrow(/older version/u);
    } finally {
      oldTab.close();
    }
  });

  it("yields its connection when a newer version opens elsewhere", async () => {
    const factory = new IDBFactory();
    const repository = await openIndexedDbSyncRepository({ factory });
    const newer = await openRaw(factory, 99);
    expect(newer.version).toBe(99);
    newer.close();
    repository.close();
  });

  it("closes an open that succeeds after it was given up, so it cannot block the next upgrade", async () => {
    const factory = new IDBFactory();
    const oldTab = await openRaw(factory, 2);
    await expect(openIndexedDbSyncRepository({ factory })).rejects.toThrow(/older version/u);
    // The old tab goes away: the abandoned open now succeeds in the background.
    oldTab.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const newer = await Promise.race([
      openRaw(factory, 99),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000))
    ]);
    expect(newer?.version).toBe(99);
    newer?.close();
  });

  it("moves waiting messages to local storage when a newer version takes the database", async () => {
    vi.resetModules();
    vi.stubGlobal("BroadcastChannel", undefined);
    const factory = new IDBFactory();
    vi.stubGlobal("indexedDB", factory);
    localStorage.clear();
    const storage = await import("../apps/web/src/messaging/outbox-storage");
    await storage.hydrateMessagingOutbox();
    const device = storage.messagingOutboxStorage();
    expect(device).not.toBe(localStorage);
    device.setItem("grogoni.messaging-outbox.a1", '{"waiting":1}');
    await storage.flushMessagingOutbox();

    const newer = await openRaw(factory, 99);
    expect(storage.messagingOutboxStorage()).toBe(localStorage);
    expect(localStorage.getItem("grogoni.messaging-outbox.a1")).toBe('{"waiting":1}');
    // A write already handed to the old cache still lands, in local storage now.
    device.setItem("grogoni.messaging-outbox.a2", '{"waiting":2}');
    await storage.flushMessagingOutbox();
    expect(localStorage.getItem("grogoni.messaging-outbox.a2")).toBe('{"waiting":2}');
    newer.close();
    localStorage.clear();
  });

  it("does not delete a moved message when a write retry fires after the database closed", async () => {
    vi.resetModules();
    vi.stubGlobal("BroadcastChannel", undefined);
    const factory = new IDBFactory();
    vi.stubGlobal("indexedDB", factory);
    localStorage.clear();
    const storage = await import("../apps/web/src/messaging/outbox-storage");
    await storage.hydrateMessagingOutbox();
    const repository = await import("../apps/web/src/sync/indexeddb-repository");
    // The next device-database write fails once, which schedules a retry in 2 s.
    const write = vi
      .spyOn(repository.IndexedDbSyncRepository.prototype, "writeMessagingOutbox")
      .mockRejectedValueOnce(new Error("quota"));
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    storage.messagingOutboxStorage().setItem("grogoni.messaging-outbox.a1", '{"waiting":1}');
    await storage.flushMessagingOutbox().catch(() => undefined);
    expect(vi.getTimerCount()).toBe(1);
    const newer = await openRaw(factory, 99);
    expect(localStorage.getItem("grogoni.messaging-outbox.a1")).toBe('{"waiting":1}');
    // The retry fires after the database closed.
    await vi.advanceTimersByTimeAsync(2_500);
    await storage.flushMessagingOutbox().catch(() => undefined);
    vi.useRealTimers();
    expect(localStorage.getItem("grogoni.messaging-outbox.a1")).toBe('{"waiting":1}');
    write.mockRestore();
    newer.close();
    localStorage.clear();
  });

  it("falls back to local storage when a newer version takes the database while it loads", async () => {
    vi.resetModules();
    vi.stubGlobal("BroadcastChannel", undefined);
    const factory = new IDBFactory();
    vi.stubGlobal("indexedDB", factory);
    localStorage.clear();
    const repository = await import("../apps/web/src/sync/indexeddb-repository");
    const load = repository.IndexedDbSyncRepository.prototype.loadMessagingOutbox;
    let newer: IDBDatabase | undefined;
    const spy = vi
      .spyOn(repository.IndexedDbSyncRepository.prototype, "loadMessagingOutbox")
      .mockImplementation(async function (
        this: InstanceType<typeof repository.IndexedDbSyncRepository>
      ) {
        const rows = await load.call(this);
        newer = await openRaw(factory, 99);
        return rows;
      });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const storage = await import("../apps/web/src/messaging/outbox-storage");
    await storage.hydrateMessagingOutbox();
    expect(storage.messagingOutboxStorage()).toBe(localStorage);
    spy.mockRestore();
    warn.mockRestore();
    newer?.close();
  });

  it("keeps the outbox on local storage when the device database cannot open", async () => {
    vi.resetModules();
    vi.stubGlobal("BroadcastChannel", undefined);
    const failing = {
      open: () => {
        const request = { error: new Error("disk full") } as unknown as IDBOpenDBRequest;
        setTimeout(() => request.onerror?.(new Event("error")), 0);
        return request;
      }
    } as unknown as IDBFactory;
    vi.stubGlobal("indexedDB", failing);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const storage = await import("../apps/web/src/messaging/outbox-storage");
    await expect(storage.hydrateMessagingOutbox()).resolves.toBeUndefined();
    expect(storage.messagingOutboxStorage()).toBe(localStorage);
    await expect(storage.flushMessagingOutbox()).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it("stops waiting for a blocked database after its deadline and falls back", async () => {
    vi.resetModules();
    vi.stubGlobal("BroadcastChannel", undefined);
    const factory = new IDBFactory();
    const oldTab = await openRaw(factory, 1);
    // Never reports blocked either: only the deadline can end the wait.
    const silent = {
      open: (name: string, version: number) => {
        const request = factory.open(name, version);
        Object.defineProperty(request, "onblocked", { set: () => undefined, get: () => null });
        return request;
      }
    } as unknown as IDBFactory;
    vi.stubGlobal("indexedDB", silent);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const storage = await import("../apps/web/src/messaging/outbox-storage");
    const started = Date.now();
    await expect(storage.hydrateMessagingOutbox()).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(storage.messagingOutboxStorage()).toBe(localStorage);
    oldTab.close();
    warn.mockRestore();
  });
});
