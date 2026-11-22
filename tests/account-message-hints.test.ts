// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { subscribeAccountHints } from "../apps/web/src/messaging/account-hints";

afterEach(() => vi.unstubAllGlobals());
it("catches up on a first connection, resumes reconnects from the cursor, and ignores another account's hints", async () => {
  const sources: FakeEvents[] = [];
  class FakeEvents extends EventTarget {
    static CLOSED = 2;
    onerror: (() => void) | null = null;
    close = vi.fn();
    constructor() {
      super();
      sources.push(this);
    }
    emit(type: string, accountId: string, lastEventId = "1") {
      this.dispatchEvent(
        new MessageEvent(type, { data: JSON.stringify({ accountId }), lastEventId })
      );
    }
  }
  vi.stubGlobal("EventSource", FakeEvents);
  const changed = vi.fn(),
    health = vi.fn();
  const stop = subscribeAccountHints("hint-owner", changed, health);
  try {
    await Promise.resolve();
    sources[0]!.emit("ready", "hint-owner");
    expect(changed).toHaveBeenCalledTimes(1);
    sources[0]!.emit("changed", "other-account");
    expect(changed).toHaveBeenCalledTimes(1);
    // A reconnect resumes from the cursor: no catch-up of its own...
    sources[0]!.emit("ready", "hint-owner", "200");
    expect(changed).toHaveBeenCalledTimes(1);
    // ...because the server reports what was missed as a hint, which still catches up.
    sources[0]!.emit("changed", "hint-owner", "201");
    expect(changed).toHaveBeenCalledTimes(2);
    expect(health).toHaveBeenLastCalledWith(true);
  } finally {
    stop();
  }
});

it("opens a new stream after a reconnect is refused, and not while the browser still retries", async () => {
  vi.useFakeTimers();
  const sources: Array<{ url: string; readyState: number; onerror: (() => void) | null }> = [];
  class FakeEvents extends EventTarget {
    static CLOSED = 2;
    readyState = 0;
    onerror: (() => void) | null = null;
    close = vi.fn();
    constructor(readonly url: string) {
      super();
      sources.push(this);
    }
  }
  vi.stubGlobal("EventSource", FakeEvents);
  const stop = subscribeAccountHints("refused-owner", vi.fn(), vi.fn());
  try {
    await Promise.resolve();
    expect(sources).toHaveLength(1);
    sources[0]!.dispatchEvent(
      new MessageEvent("ready", {
        data: JSON.stringify({ accountId: "refused-owner" }),
        lastEventId: "41"
      })
    );
    // A dropped connection the browser is retrying (CONNECTING): leave it to the browser.
    sources[0]!.onerror!();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sources).toHaveLength(1);
    // The retry was refused (e.g. 503 on a cold start): the browser gives up for good.
    sources[0]!.readyState = FakeEvents.CLOSED;
    sources[0]!.onerror!();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sources).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sources).toHaveLength(2);
    // It resumes from the last cursor.
    expect(sources[1]!.url).toContain("since=41");
  } finally {
    stop();
    vi.useRealTimers();
  }
});
