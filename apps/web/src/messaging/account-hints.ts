import { readApiBaseUrl } from "../lib/api";

/** One cookie-authenticated, identifiers-only stream per account per tab, shared by inbox and
 * sync subscribers. It closes while hidden and reconnects with the journal cursor. */
interface Subscriber {
  changed: () => void;
  health: (healthy: boolean) => void;
}
const channels = new Map<string, { listeners: Set<Subscriber>; stop: () => void }>();
export function subscribeAccountHints(
  accountId: string,
  changed: () => void,
  health: (healthy: boolean) => void
): () => void {
  if (typeof EventSource === "undefined") {
    health(false);
    return () => undefined;
  }
  let channel = channels.get(accountId);
  if (!channel) {
    const listeners = new Set<Subscriber>();
    let source: EventSource | null = null;
    let cursor = "";
    let healthy = false;
    const notifyHealth = (value: boolean) => {
      healthy = value;
      for (const listener of listeners) listener.health(value);
    };
    const close = () => {
      source?.close();
      source = null;
      notifyHealth(false);
    };
    const open = () => {
      if (source || document.visibilityState === "hidden") return;
      source = new EventSource(
        `${readApiBaseUrl()}/v1/realtime/messages${cursor ? `?since=${encodeURIComponent(cursor)}` : ""}`,
        { withCredentials: true }
      );
      source.addEventListener("ready", (event) => {
        try {
          if (JSON.parse((event as MessageEvent<string>).data).accountId !== accountId) {
            close();
            return;
          }
        } catch {
          close();
          return;
        }
        // A reconnect resumes from the journal cursor (?since= / Last-Event-ID): the server's first
        // probe sends "changed" for anything missed while disconnected, so only a connection with
        // nothing to resume from catches up here. Catching up on every reconnect (the stream ends
        // every ~25 s) cost three requests per idle half minute (measured 2026-11-19). A tab
        // becoming visible still catches up through the visibility handler.
        const resumed = cursor !== "";
        cursor = (event as MessageEvent<string>).lastEventId || cursor;
        notifyHealth(true);
        if (!resumed) for (const listener of listeners) listener.changed();
      });
      source.addEventListener("changed", (event) => {
        try {
          const message = event as MessageEvent<string>;
          const data = JSON.parse(message.data) as { accountId?: string };
          if (data.accountId !== accountId) return;
          cursor = message.lastEventId;
          for (const listener of listeners) listener.changed();
        } catch {
          /* Invalid hints never carry data into the inbox. */
        }
      });
      source.onerror = () => notifyHealth(false);
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") close();
      else {
        open();
        for (const listener of listeners) listener.changed();
      }
    };
    document.addEventListener("visibilitychange", visibility);
    channel = {
      listeners,
      stop: () => {
        close();
        document.removeEventListener("visibilitychange", visibility);
      }
    };
    channels.set(accountId, channel);
    // Subscribe first, then open below.
    queueMicrotask(() => {
      open();
      for (const listener of listeners) listener.health(healthy);
    });
  }
  const subscriber = { changed, health };
  channel.listeners.add(subscriber);
  return () => {
    channel!.listeners.delete(subscriber);
    if (!channel!.listeners.size) {
      channel!.stop();
      channels.delete(accountId);
    }
  };
}
