import { describe, expect, it, vi } from "vitest";

// On page load the outbox resends what an earlier page (closed or reloaded mid-send) left waiting,
// skipping the wait that guarded that page's request in flight. The page's own sends are not
// resent that way: they may still be in flight. A module load is a page load here.
describe("messages left by an earlier page", () => {
  it("tells this page's sends apart from those an earlier page left", async () => {
    const storage = new Map<string, string>();
    const store = {
      get length() {
        return storage.size;
      },
      key: (index: number) => [...storage.keys()][index] ?? null,
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key)
    };
    const entry = (clientMessageId: string) => ({
      accountId: "account-1",
      clientMessageId,
      payload: { conversationId: "A", clientMessageId },
      nextAttemptAt: Date.now() + 120_000
    });
    const earlier = await import("../apps/web/src/messaging/outbox");
    earlier.queueMessagingOutbox(entry("from-earlier-page"), store);
    expect(earlier.leftByEarlierPage(entry("from-earlier-page"))).toBe(false);

    vi.resetModules();
    const reloaded = await import("../apps/web/src/messaging/outbox");
    const [waiting] = reloaded.readMessagingOutbox("account-1", store);
    expect(waiting?.clientMessageId).toBe("from-earlier-page");
    expect(reloaded.leftByEarlierPage(waiting!)).toBe(true);
    reloaded.queueMessagingOutbox(entry("from-this-page"), store);
    expect(reloaded.leftByEarlierPage(entry("from-this-page"))).toBe(false);
  });
});
