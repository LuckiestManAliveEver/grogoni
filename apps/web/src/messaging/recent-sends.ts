import type { ChatMessage } from "../app-shell";
import { keepDeviceOnlyMessages, outboxPlaceholders } from "../chat-device-only-messages";

/**
 * Sends this device has on screen or just had accepted by the server, per conversation.
 *
 * A thread read that started before a send was accepted can answer after it, without the message.
 * Replacing the thread with that answer dropped the user's own bubble until the next read, which
 * can be 30 s away. Two windows had that problem:
 *
 * - pending: from the moment the bubble appears until the send settles. Before it reaches the
 *   outbox it is neither stored nor waiting (the send first awaits the agent runtime session and
 *   encryption), so nothing else keeps it. A pending send is kept only while its bubble is still
 *   on screen, in its on-screen state: a send that is cancelled (its text goes back to the box)
 *   removes the bubble, and must not come back.
 * - accepted: it has left the outbox and taken its server id. Kept until a server read includes
 *   it, on screen or not.
 */
const keepForMs = 120_000;
type Entry = { message: ChatMessage; notedAt: number; pending: boolean };
const recent = new Map<string, Map<string, Entry>>();

function note(conversationId: string | null | undefined, entry: Entry): void {
  if (!conversationId) return;
  // Bounded: expired entries go from every conversation, read again or not.
  for (const [id, entries] of recent) {
    for (const [key, kept] of entries)
      if (entry.notedAt - kept.notedAt > keepForMs) entries.delete(key);
    if (entries.size === 0) recent.delete(id);
  }
  const entries = recent.get(conversationId) ?? new Map<string, Entry>();
  entries.set(entry.message.id, entry);
  recent.set(conversationId, entries);
}

/** The bubble of a send that has just been typed, before anything is sent. */
export function notePendingSend(
  conversationId: string | null | undefined,
  message: ChatMessage,
  now = Date.now()
): void {
  note(conversationId, { message, notedAt: now, pending: true });
}

/**
 * The server accepted a send: `message.id` is its server id, `message.clientMessageId` the id its
 * bubble had. The pending copy under the client id is retired, so a read landing before the next
 * render cannot show both. A copy taken from a waiting bubble loses its outbox state.
 */
export function noteAcceptedSend(
  conversationId: string | null | undefined,
  message: ChatMessage,
  now = Date.now()
): void {
  const accepted = { ...message };
  delete accepted.outboxState;
  if (conversationId && message.clientMessageId !== undefined)
    recent.get(conversationId)?.delete(message.clientMessageId);
  note(conversationId, { message: accepted, notedAt: now, pending: false });
}

/** `bubble` (its id is the client message id) was accepted under `serverId`. */
export function noteBubbleAccepted(
  conversationId: string | null | undefined,
  bubble: ChatMessage,
  serverId: string,
  now = Date.now()
): void {
  noteAcceptedSend(
    conversationId,
    { ...bubble, id: serverId, clientMessageId: bubble.id, status: "sent" },
    now
  );
}

/**
 * Sends the server's answer does not contain yet, marked as this device's own copy so the thread
 * keeps them; the ones it does contain (by id or clientMessageId) are forgotten. `onScreen` is the
 * thread as shown now: a pending send is returned only while it is there, as it is there.
 */
export function acceptedSendsMissingFrom(
  conversationId: string,
  serverMessages: readonly ChatMessage[],
  now = Date.now(),
  onScreen: readonly ChatMessage[] = []
): ChatMessage[] {
  const entries = recent.get(conversationId);
  if (entries === undefined) return [];
  // Messages without a client id (the greeting, agent replies) must not match a send without one.
  const present = new Set(
    serverMessages.flatMap((item) => [item.id, item.clientMessageId]).filter((id) => id)
  );
  const missing: ChatMessage[] = [];
  for (const [id, entry] of entries) {
    if (
      present.has(id) ||
      (entry.message.clientMessageId !== undefined && present.has(entry.message.clientMessageId)) ||
      now - entry.notedAt > keepForMs
    ) {
      entries.delete(id);
      continue;
    }
    if (entry.pending) {
      // Not on screen (cancelled, or another thread is open): not kept now. Left to expire rather
      // than forgotten, so a stale view of the screen cannot lose a send still in progress.
      const shown = onScreen.find((item) => item.id === id);
      if (shown === undefined) continue;
      missing.push({
        ...shown,
        deviceOnlyIn: conversationId,
        deviceOnlyAfter: shown.deviceOnlyAfter ?? ""
      });
      continue;
    }
    // No anchor: after everything the server has, where a just-sent message belongs.
    missing.push({ ...entry.message, deviceOnlyIn: conversationId, deviceOnlyAfter: "" });
  }
  if (entries.size === 0) recent.delete(conversationId);
  return missing;
}

/** Signing out or switching account: nothing of the previous account may stay. */
export function forgetAcceptedSends(): void {
  recent.clear();
}

/**
 * How a thread read's answer applies: a function of the thread as it is when it applies
 * (`current`), for the state updater. Not of the thread as last rendered: a send can start or be
 * cancelled between the two, and a stale view would drop the one or bring back the other.
 * Idempotent, so an updater that runs twice gives the same thread.
 */
export function applyThreadRead(input: {
  conversationId: string;
  serverMessages: ChatMessage[];
  known: ChatMessage[];
  waiting: Array<{ clientMessageId: string; payload: Record<string, unknown> }>;
  now?: number;
}): (current: ChatMessage[]) => ChatMessage[] {
  const { conversationId, serverMessages, known, waiting } = input;
  return (current) =>
    keepDeviceOnlyMessages(current, serverMessages, conversationId, [
      ...known,
      ...outboxPlaceholders(waiting, conversationId, [...known, ...current]),
      // Typed or accepted while the read was in flight: kept until a read includes them.
      ...acceptedSendsMissingFrom(conversationId, serverMessages, input.now ?? Date.now(), current)
    ]);
}
