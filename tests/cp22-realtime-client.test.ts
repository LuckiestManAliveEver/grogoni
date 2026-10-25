import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accountRealtimeTransport,
  subscribeToAccountRealtime,
  type AccountRealtimeSocket
} from "../apps/web/src/sync/realtime-client";

afterEach(() => {
  vi.useRealTimers();
});

describe("CP22 web realtime client", () => {
  it("uses HTTP polling for relative and absolute API proxies and Edge functions", () => {
    for (const base of [
      "/api",
      "https://grogoni.com/api",
      "https://grogoni.com/api/",
      "https://project.supabase.co/functions/v1/api"
    ])
      expect(accountRealtimeTransport(base, "https://grogoni.com")).toBe("http-poll");
    expect(accountRealtimeTransport("http://localhost:4000", "http://localhost:5173")).toBe(
      "websocket"
    );
  });

  it("closes a failed socket using a browser-valid code and reconnects", async () => {
    vi.useFakeTimers();
    const sockets: FakeRealtimeSocket[] = [];
    const onError = vi.fn();
    const stop = subscribeToAccountRealtime({
      accountId: "account-1",
      endpoint: "wss://api.example.test/v1/realtime",
      reconnectDelayMs: 250,
      onChangesAvailable: vi.fn(),
      onError,
      createSocket: () => {
        const socket = new FakeRealtimeSocket();
        sockets.push(socket);
        return socket;
      }
    });
    expect(() => sockets[0]!.emitError()).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(250);
    expect(sockets).toHaveLength(2);
    stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
  });
  it("polls without sockets and stops scheduling after teardown", async () => {
    vi.useFakeTimers();
    const createSocket = vi.fn();
    const onChangesAvailable = vi.fn().mockResolvedValue(undefined);
    const stop = subscribeToAccountRealtime({
      accountId: "account-1",
      endpoint: "/api/v1/realtime",
      transport: "http-poll",
      createSocket,
      onChangesAvailable
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(onChangesAvailable).toHaveBeenCalledTimes(2);
    expect(createSocket).not.toHaveBeenCalled();
    stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(onChangesAvailable).toHaveBeenCalledTimes(2);
  });

  it("does not overlap pending polls and reports errors", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const onChangesAvailable = vi.fn(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail;
        })
    );
    const onError = vi.fn();
    const stop = subscribeToAccountRealtime({
      accountId: "account-1",
      endpoint: "/api/v1/realtime",
      transport: "http-poll",
      onChangesAvailable,
      onError
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(onChangesAvailable).toHaveBeenCalledTimes(1);
    reject(new Error("offline"));
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledOnce();
    stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(onChangesAvailable).toHaveBeenCalledTimes(1);
  });

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

  close(code = 1000): void {
    if (code !== 1000 && (code < 3000 || code > 4999))
      throw new DOMException("Invalid browser close code", "InvalidAccessError");
    this.emitClose();
  }

  emitError(): void {
    for (const listener of this.errorListeners) listener();
  }

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
