import { useSyncExternalStore } from "react";

/**
 * Which threads are waiting on a guest reply (the intent classifier, then the search). The chat
 * shows a typing indicator in that thread meanwhile (GuestTypingIndicator), so up to the 5s
 * classifier budget never looks like nothing happened. A store, not hook state, so the indicator
 * reaches ChatSurface without threading a prop through GrogoniApplication.
 */
const pending = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;

const key = (thread: string | null) => thread ?? "";

function notify() {
  version++;
  for (const listener of listeners) listener();
}

/** Marks the thread as waiting; the returned function ends it (once). */
export function beginGuestReply(thread: string | null): () => void {
  const id = key(thread);
  pending.set(id, (pending.get(id) ?? 0) + 1);
  notify();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const left = (pending.get(id) ?? 1) - 1;
    if (left <= 0) pending.delete(id);
    else pending.set(id, left);
    notify();
  };
}

export function isGuestReplyPending(thread: string | null): boolean {
  return pending.has(key(thread));
}

export function useGuestReplyPending(thread: string | null): boolean {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
    () => version
  );
  return isGuestReplyPending(thread);
}
