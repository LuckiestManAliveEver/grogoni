import type { SyncRealtimeEvent } from "@grogoni/shared-types";
import { recordRealtimeConnection } from "../performance";

export interface AccountRealtimeOptions {
  accountId: string;
  createSocket?: (endpoint: string) => AccountRealtimeSocket;
  endpoint: string;
  onChangesAvailable: () => void | Promise<void>;
  onError?: (error: unknown) => void;
  reconnectDelayMs?: number;
}

export interface AccountRealtimeSocket {
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: () => void): void;
  close(code?: number, reason?: string): void;
}

export function subscribeToAccountRealtime(options: AccountRealtimeOptions): () => void {
  let stopped = false;
  let socket: AccountRealtimeSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const reconnectDelayMs = Math.max(250, options.reconnectDelayMs ?? 2_000);

  function scheduleReconnect() {
    if (!stopped && reconnectTimer === null) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, reconnectDelayMs);
    }
  }

  function triggerCatchUp() {
    try {
      void Promise.resolve(options.onChangesAvailable()).catch((error: unknown) =>
        options.onError?.(error)
      );
    } catch (error) {
      options.onError?.(error);
    }
  }

  function connect() {
    if (stopped) {
      return;
    }

    try {
      recordRealtimeConnection("connecting");
      socket = options.createSocket?.(options.endpoint) ?? new WebSocket(options.endpoint);
    } catch (error) {
      options.onError?.(error);
      scheduleReconnect();
      return;
    }
    socket.addEventListener("message", (message) => {
      const event = parseRealtimeEvent(message.data);
      if (event === null || event.accountId !== options.accountId) {
        return;
      }
      if (event.type === "realtime.ready" || event.type === "sync.changes_available") {
        if (event.type === "realtime.ready") recordRealtimeConnection("ready");
        triggerCatchUp();
      }
    });
    socket.addEventListener("error", () => {
      recordRealtimeConnection("failed");
      options.onError?.(new Error("Realtime synchronization connection failed."));
      socket?.close(1011, "Realtime connection failed");
    });
    socket.addEventListener("close", () => {
      recordRealtimeConnection("closed");
      socket = null;
      scheduleReconnect();
    });
  }

  connect();

  return () => {
    stopped = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
    }
    socket?.close(1000, "Session ended");
    socket = null;
  };
}

function parseRealtimeEvent(value: unknown): SyncRealtimeEvent | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const event = JSON.parse(value) as Partial<SyncRealtimeEvent>;
    if (
      event.protocolVersion !== 1 ||
      typeof event.accountId !== "string" ||
      (event.type !== "realtime.ready" && event.type !== "sync.changes_available")
    ) {
      return null;
    }
    return event as SyncRealtimeEvent;
  } catch {
    return null;
  }
}
