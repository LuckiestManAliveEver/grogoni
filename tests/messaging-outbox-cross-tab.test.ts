import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Two tabs of one account write the messaging outbox at the same time. Each tab reads the stored
 * list, changes it and writes it back; without a lock one tab's write could replace the other's
 * and a queued message was lost (or a sent one came back). Each tab runs in its own thread, so the
 * race is real, not simulated by ordering calls by hand (test./support/outbox-tab-worker.mjs).
 */
const outboxUrl = new URL("../apps/web/src/messaging/outbox.ts", import.meta.url).href;
const workerUrl = new URL("./support/outbox-tab-worker.mjs", import.meta.url);
const count = 150;

function expectedFor(tab: string) {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) if (index % 3 !== 0) ids.push(`${tab}-${index}`);
  return ids;
}

async function raceTwoTabs(locks: boolean) {
  const buffer = new SharedArrayBuffer(16 + 4 * 1024 * 1024);
  const words = new Int32Array(buffer, 0, 4);
  const tabs = ["tab-a", "tab-b"].map(
    (tab) =>
      new Worker(workerUrl, {
        workerData: { buffer, tab, count, locks, outboxUrl }
      })
  );
  const ready = tabs.map(
    (worker) =>
      new Promise<void>((resolve, reject) => {
        worker.once("message", () => resolve());
        worker.once("error", reject);
      })
  );
  await Promise.all(ready);
  const done = tabs.map(
    (worker) =>
      new Promise<{ ownView: string[] }>((resolve, reject) => {
        worker.on("message", (message: { done?: boolean; ownView: string[] }) => {
          if (message.done) resolve(message);
        });
        worker.once("error", reject);
        worker.once("exit", (code) => reject(new Error(`Tab exited (${code}) before finishing.`)));
      })
  );
  Atomics.store(words, 3, 1);
  Atomics.notify(words, 3);
  const views = await Promise.all(done);
  await Promise.all(tabs.map((worker) => worker.terminate()));
  const length = Atomics.load(words, 2);
  const stored = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 16).slice(0, length))
  ) as Record<string, string>;
  const entries = JSON.parse(stored["grogoni.messaging-outbox.v2:account-shared"] ?? "[]") as {
    clientMessageId: string;
    attempts?: number;
  }[];
  return { entries, views };
}

describe("messaging outbox across tabs", () => {
  it("loses no queued message when two tabs write at the same moment", async () => {
    // Three rounds: one lucky interleaving must not hide a lost write.
    for (let round = 0; round < 3; round += 1) {
      const { entries, views } = await raceTwoTabs(true);
      const ids = entries.map((entry) => entry.clientMessageId);
      const expected = [...expectedFor("tab-a"), ...expectedFor("tab-b")];
      expect([...ids].sort()).toEqual([...expected].sort());
      expect(new Set(ids).size).toBe(ids.length);
      // Each tab's own order is kept, and every recorded attempt survived.
      for (const tab of ["tab-a", "tab-b"])
        expect(ids.filter((id) => id.startsWith(`${tab}-`))).toEqual(expectedFor(tab));
      for (const entry of entries)
        expect(entry.attempts ?? 0).toBe(
          Number(entry.clientMessageId.split("-")[2]) % 3 === 1 ? 1 : 0
        );
      // Once settled, each tab reads all of its own messages (the other tab may still be writing).
      views.forEach((view, index) => {
        const own = expectedFor(index === 0 ? "tab-a" : "tab-b");
        expect(view.ownView.filter((id) => own.includes(id))).toEqual(own);
      });
    }
  }, 60_000);
});

class MemoryStorage {
  readonly values = new Map<string, string>();
  failNextWrite = false;
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new DOMException("Storage is full.", "QuotaExceededError");
    }
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

/** A Web Locks stand-in for one thread: grants each name in request order, releases on settle. */
function fakeLocks() {
  const granted: string[] = [];
  const tails = new Map<string, Promise<unknown>>();
  return {
    granted,
    request(name: string, callback: () => unknown) {
      const run = (tails.get(name) ?? Promise.resolve()).then(async () => {
        granted.push(name);
        return callback();
      });
      tails.set(
        name,
        run.catch(() => undefined)
      );
      return run;
    }
  };
}

const key = "grogoni.messaging-outbox.v2:account-a";
const entry = (clientMessageId: string) => ({
  accountId: "account-a",
  clientMessageId,
  payload: { conversationId: "conversation-a" }
});

describe("messaging outbox lock", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("writes under the account's outbox lock while the caller reads its change at once", async () => {
    const locks = fakeLocks();
    vi.stubGlobal("navigator", { locks });
    const outbox = await import("../apps/web/src/messaging/outbox");
    const storage = new MemoryStorage();
    outbox.queueMessagingOutbox(entry("first"), storage);
    outbox.queueMessagingOutbox(entry("second"), storage);
    outbox.removeMessagingOutboxEntry("account-a", "first", storage);
    // Synchronous callers see their own change before the lock is granted.
    expect(storage.getItem(key)).toBeNull();
    expect(outbox.readMessagingOutbox("account-a", storage).map((e) => e.clientMessageId)).toEqual([
      "second"
    ]);
    expect(outbox.countMessagingOutbox("account-a", "conversation-a", storage)).toBe(1);
    expect(outbox.recordMessagingOutboxAttempt("account-a", "second", 0, storage)).toMatchObject({
      attempts: 1,
      nextAttemptAt: outbox.outboxBackoffMs(1)
    });
    await outbox.settleMessagingOutbox();
    // One lock request carried all four changes.
    expect(locks.granted).toEqual([outbox.messagingOutboxLockName("account-a")]);
    expect(locks.granted[0]).toBe("grogoni-outbox-write:account-a");
    expect(JSON.parse(storage.getItem(key)!)).toEqual([
      { ...entry("second"), attempts: 1, nextAttemptAt: 60_000 }
    ]);
    outbox.clearMessagingOutbox("account-a", storage);
    expect(outbox.readMessagingOutbox("account-a", storage)).toEqual([]);
    await outbox.settleMessagingOutbox();
    expect(storage.getItem(key)).toBeNull();
  });

  it("releases the lock when a write fails and keeps the change for the next write", async () => {
    const locks = fakeLocks();
    vi.stubGlobal("navigator", { locks });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const outbox = await import("../apps/web/src/messaging/outbox");
    const storage = new MemoryStorage();
    storage.failNextWrite = true;
    outbox.queueMessagingOutbox(entry("first"), storage);
    await outbox.settleMessagingOutbox();
    expect(warn).toHaveBeenCalledWith(
      "Could not save the messaging outbox.",
      expect.any(DOMException)
    );
    expect(storage.getItem(key)).toBeNull();
    // Still queued in this tab, and the lock was released: the next change gets it and writes both.
    expect(outbox.readMessagingOutbox("account-a", storage)).toHaveLength(1);
    outbox.queueMessagingOutbox(entry("second"), storage);
    await outbox.settleMessagingOutbox();
    expect(locks.granted).toHaveLength(2);
    expect(
      JSON.parse(storage.getItem(key)!).map((e: { clientMessageId: string }) => e.clientMessageId)
    ).toEqual(["first", "second"]);
    warn.mockRestore();
  });

  it("writes at once without navigator.locks, and before the page goes away with them", async () => {
    vi.stubGlobal("navigator", {});
    const fallback = await import("../apps/web/src/messaging/outbox");
    const storage = new MemoryStorage();
    fallback.queueMessagingOutbox(entry("first"), storage);
    expect(JSON.parse(storage.getItem(key)!)).toHaveLength(1);

    vi.resetModules();
    const listeners = new Map<string, () => void>();
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      dispatchEvent: () => true
    });
    // A lock that is never granted: the tab closes first.
    vi.stubGlobal("navigator", { locks: { request: () => new Promise(() => {}) } });
    const closing = await import("../apps/web/src/messaging/outbox");
    closing.queueMessagingOutbox(entry("second"), storage);
    expect(JSON.parse(storage.getItem(key)!)).toHaveLength(1);
    listeners.get("pagehide")?.();
    expect(
      JSON.parse(storage.getItem(key)!).map((e: { clientMessageId: string }) => e.clientMessageId)
    ).toEqual(["first", "second"]);
  });
});
