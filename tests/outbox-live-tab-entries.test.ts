// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// The page-load resend pass sends what an earlier page left waiting, without its backoff. A
// message another open tab queued is not that: the tab is alive and sends it on its own backoff.
// Each page holds a Web Lock while open and tags what it queues, so the pass can tell them apart.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

function stubLocks(held: string[]) {
  const requested: string[] = [];
  const released: string[] = [];
  vi.stubGlobal("navigator", {
    ...navigator,
    locks: {
      // A page lock is held for good; the outbox's write lock runs its callback at once.
      request: (name: string, callback: () => unknown) => {
        requested.push(name);
        if (!name.startsWith("grogoni-outbox-page:")) return Promise.resolve(callback());
        return Promise.resolve(callback()).then(() => released.push(name));
      },
      query: async () => ({ held: held.map((name) => ({ name })) })
    }
  });
  return Object.assign(requested, { released });
}

const entry = (queuedBy?: string) => ({
  accountId: "a1",
  clientMessageId: `m-${queuedBy ?? "untagged"}`,
  payload: { conversationId: "c1" },
  ...(queuedBy === undefined ? {} : { queuedBy })
});

describe("outbox entries of another open tab", () => {
  it("are left to that tab; a closed page's and untagged ones count as left", async () => {
    const requested = stubLocks(["grogoni-outbox-page:tab-b", "grogoni-outbox-write:a1"]);
    const outbox = await import("../apps/web/src/messaging/outbox");
    expect(requested).toContain(`grogoni-outbox-page:${outbox.outboxPageId}`);

    await outbox.refreshLiveOutboxPages();
    expect(outbox.leftByEarlierPage(entry("tab-b"))).toBe(false);
    expect(outbox.leftByEarlierPage(entry("closed-tab"))).toBe(true);
    expect(outbox.leftByEarlierPage(entry())).toBe(true);
  });

  it("count as left once far past due: the live tab is not sending them", async () => {
    // Tab B switched account (its passes read only the new one), or is frozen.
    stubLocks(["grogoni-outbox-page:tab-b"]);
    const outbox = await import("../apps/web/src/messaging/outbox");
    await outbox.refreshLiveOutboxPages();
    const queuedAt = 1_000_000;
    const waiting = { ...entry("tab-b"), queuedAt, nextAttemptAt: queuedAt + 60_000 };
    expect(outbox.leftByEarlierPage(waiting, queuedAt + 60_000 + outbox.liveTabGraceMs)).toBe(
      false
    );
    expect(outbox.leftByEarlierPage(waiting, queuedAt + 60_001 + outbox.liveTabGraceMs)).toBe(true);
  });

  it("lets go of the page lock on pagehide (back/forward cache) and takes it again on pageshow", async () => {
    const requested = stubLocks([]);
    const outbox = await import("../apps/web/src/messaging/outbox");
    const name = `grogoni-outbox-page:${outbox.outboxPageId}`;
    expect(requested.filter((lock) => lock === name)).toHaveLength(1);
    window.dispatchEvent(new Event("pagehide"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requested.released).toContain(name);
    window.dispatchEvent(new Event("pageshow"));
    expect(requested.filter((lock) => lock === name)).toHaveLength(2);
  });

  it("tags what this page queues and never counts it as left", async () => {
    stubLocks([]);
    const outbox = await import("../apps/web/src/messaging/outbox");
    outbox.queueMessagingOutbox(entry(), localStorage);
    await outbox.settleMessagingOutbox();
    const [stored] = outbox.readMessagingOutbox("a1", localStorage);
    expect(stored?.queuedBy).toBe(outbox.outboxPageId);
    expect(outbox.leftByEarlierPage(stored!)).toBe(false);
    localStorage.clear();
  });

  it("without Web Locks, keeps the old rule: another page's message counts as left", async () => {
    vi.stubGlobal("navigator", { ...navigator, locks: undefined });
    const outbox = await import("../apps/web/src/messaging/outbox");
    await outbox.refreshLiveOutboxPages();
    expect(outbox.leftByEarlierPage(entry("tab-b"))).toBe(true);
  });
});
