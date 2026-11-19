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
