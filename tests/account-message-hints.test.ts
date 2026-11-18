// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { subscribeAccountHints } from "../apps/web/src/messaging/account-hints";

afterEach(() => vi.unstubAllGlobals());
it("catches up on every authorized connection and ignores another account's hints", async () => {
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
    sources[0]!.emit("ready", "hint-owner", "200");
    expect(changed).toHaveBeenCalledTimes(2);
    sources[0]!.emit("changed", "hint-owner", "201");
    expect(changed).toHaveBeenCalledTimes(3);
    expect(health).toHaveBeenLastCalledWith(true);
  } finally {
    stop();
  }
});
