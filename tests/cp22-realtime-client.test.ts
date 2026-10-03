import { afterEach, describe, expect, it, vi } from "vitest";
import {
  subscribeToAccountRealtime,
  type AccountRealtimeSocket
} from "../apps/web/src/sync/realtime-client";

afterEach(() => {
  vi.useRealTimers();
});

describe("CP22 web realtime client", () => {
  it("triggers catch-up for valid account events and reconnects after closure", async () => {
    vi.useFakeTimers();
    const sockets: FakeRealtimeSocket[] = [];
    const onChangesAvailable = vi.fn();
    const stop = subscribeToAccountRealtime({
      accountId: "account-1",
      endpoint: "wss://grogoni.com/v1/realtime",
      reconnectDelayMs: 250,
      createSocket: () => {
        const socket = new FakeRealtimeSocket();
        sockets.push(socket);
        return socket;
      },
      onChangesAvailable
    });

    sockets[0]?.emitMessage({
      type: "realtime.ready",
      protocolVersion: 1,
      accountId: "account-1",
      serverTime: "2026-07-12T12:00:00.000Z"
    });
    sockets[0]?.emitMessage({
      type: "sync.changes_available",
      protocolVersion: 1,
      accountId: "account-1",
      cursor: "cursor-1",
      sequence: 1,
      collection: "conversations",
      emittedAt: "2026-07-12T12:00:01.000Z"
    });
    sockets[0]?.emitMessage({
      type: "sync.changes_available",
      protocolVersion: 1,
      accountId: "another-account",
      cursor: "cursor-2",
      sequence: 1,
      collection: "conversations",
      emittedAt: "2026-07-12T12:00:02.000Z"
    });
    expect(onChangesAvailable).toHaveBeenCalledTimes(2);

    sockets[0]?.emitClose();
    await vi.advanceTimersByTimeAsync(250);
    expect(sockets).toHaveLength(2);

    stop();
    sockets[1]?.emitClose();
    await vi.advanceTimersByTimeAsync(250);
    expect(sockets).toHaveLength(2);
  });
});

class FakeRealtimeSocket implements AccountRealtimeSocket {
  private readonly messageListeners: Array<(event: { data: unknown }) => void> = [];
  private readonly closeListeners: Array<() => void> = [];
  private readonly errorListeners: Array<() => void> = [];

  addEventListener(
    type: "message" | "close" | "error",
    listener: ((event: { data: unknown }) => void) | (() => void)
  ) {
    if (type === "message") {
      this.messageListeners.push(listener as (event: { data: unknown }) => void);
    } else if (type === "close") {
      this.closeListeners.push(listener as () => void);
    } else {
      this.errorListeners.push(listener as () => void);
    }
  }

  close(): void {}

  emitMessage(event: unknown): void {
    for (const listener of this.messageListeners) {
      listener({ data: JSON.stringify(event) });
    }
  }

  emitClose(): void {
    for (const listener of this.closeListeners) {
      listener();
    }
  }
}
