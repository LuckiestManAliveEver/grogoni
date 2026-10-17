import type { ChatMessage } from "./app-shell";

/**
 * Messages that exist only on this device: a buyer's marketplace search and its answer (never
 * sent), and a message waiting in the outbox (until the server has it). The 4-second conversation
 * refresh replaces the thread with what the server has, so these are kept here, per account and
 * per conversation, and merged back into every refresh of the conversation they belong to. Kept
 * in localStorage so a reload or a trip to another thread does not lose them, cleared with the
 * outbox on sign-out and reset. A search exchange expires after a day; a queued message stays
 * while the outbox holds it. An end-to-end encrypted message is never written here (its text
 * would sit in plain storage); it is kept in this page's memory only. Dependency-free like
 * chat-messages-equal.ts so it can be unit-tested directly.
 */

const storagePrefix = "grogoni.device-only-messages.v1";
/** A device-only message older than this is dropped (a search exchange is not worth keeping). */
export const deviceOnlyMaxAgeMs = 24 * 60 * 60 * 1000;
const maxStored = 100;

export interface DeviceOnlyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function key(accountId: string): string {
  return `${storagePrefix}:${accountId}`;
}

function browserStorage(): DeviceOnlyStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * End-to-end encrypted messages waiting in the outbox: their readable text is kept in this page's
 * memory only, never in storage. A thread switch keeps them; a reload shows a placeholder instead
 * (see outboxPlaceholders).
 */
const memory = new Map<string, ChatMessage[]>();

/** Keeps device-only messages for this page's lifetime only (encrypted messages' text). */
export function holdDeviceOnlyInMemory(accountId: string, messages: ChatMessage[]): void {
  const ids = new Set(messages.map((message) => message.id));
  memory.set(accountId, [
    ...(memory.get(accountId) ?? []).filter((message) => !ids.has(message.id)),
    ...messages
  ]);
}

export function readDeviceOnlyMessages(
  accountId: string,
  storage: DeviceOnlyStorage | null = browserStorage(),
  now = Date.now()
): ChatMessage[] {
  return [...readStored(accountId, storage, now), ...(memory.get(accountId) ?? [])];
}

function readStored(
  accountId: string,
  storage: DeviceOnlyStorage | null,
  now = Date.now()
): ChatMessage[] {
  if (storage === null) return [];
  try {
    const parsed = JSON.parse(storage.getItem(key(accountId)) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (message): message is ChatMessage =>
        typeof message === "object" &&
        message !== null &&
        typeof (message as ChatMessage).id === "string" &&
        (message as ChatMessage).deviceOnlyIn !== undefined &&
        // A message still in the outbox stays as long as the outbox holds it.
        ((message as ChatMessage).outboxState === "retrying" ||
          (message as ChatMessage).outboxState === "stopped" ||
          now - Date.parse((message as ChatMessage).createdAt ?? "") < deviceOnlyMaxAgeMs)
    );
  } catch {
    return [];
  }
}

function write(accountId: string, messages: ChatMessage[], storage: DeviceOnlyStorage | null) {
  if (storage === null) return;
  try {
    storage.setItem(key(accountId), JSON.stringify(withinCap(messages).map(storable)));
  } catch {
    // Full or blocked storage: the messages still show for this page's lifetime.
  }
}

/**
 * At most `maxStored` messages, dropping the oldest search exchanges first: a message still
 * waiting in the outbox is never pushed out by searches.
 */
function withinCap(messages: ChatMessage[]): ChatMessage[] {
  let excess = messages.length - maxStored;
  if (excess <= 0) return messages;
  const waiting = (message: ChatMessage) =>
    message.outboxState === "retrying" || message.outboxState === "stopped";
  const kept = messages.filter((message) => {
    if (excess > 0 && !waiting(message)) {
      excess -= 1;
      return false;
    }
    return true;
  });
  return excess > 0 ? kept.slice(excess) : kept;
}

/**
 * What is written to storage: the text and the attachments' names, never their data (an image
 * as a data URL would fill the quota and the write would fail). After a reload an attachment
 * shows by name; the outbox entry still holds what will be sent.
 */
function storable(message: ChatMessage): ChatMessage {
  if (message.attachments === undefined) return message;
  return {
    ...message,
    attachments: message.attachments.map((attachment) => {
      const named = { ...attachment };
      delete named.dataUrl;
      delete named.previewUrl;
      return named;
    })
  };
}

/** Forgets every device-only message of an account (sign-out, reset). */
export function clearDeviceOnlyMessages(
  accountId: string,
  storage: (DeviceOnlyStorage & { removeItem(key: string): void }) | null = browserStorage() as
    (DeviceOnlyStorage & { removeItem(key: string): void }) | null
): void {
  memory.delete(accountId);
  try {
    storage?.removeItem(key(accountId));
  } catch {
    // Blocked storage holds nothing to clear.
  }
}

/** Adds or replaces device-only messages (matched by id). */
export function saveDeviceOnlyMessages(
  accountId: string,
  messages: ChatMessage[],
  storage: DeviceOnlyStorage | null = browserStorage()
): void {
  const ids = new Set(messages.map((message) => message.id));
  write(
    accountId,
    [...readStored(accountId, storage).filter((message) => !ids.has(message.id)), ...messages],
    storage
  );
}

/** Changes one stored device-only message, if it is still stored. */
export function updateDeviceOnlyMessage(
  accountId: string,
  messageId: string,
  patch: Partial<ChatMessage>,
  storage: DeviceOnlyStorage | null = browserStorage()
): void {
  write(
    accountId,
    readStored(accountId, storage).map((message) =>
      message.id === messageId ? { ...message, ...patch } : message
    ),
    storage
  );
  const held = memory.get(accountId);
  if (held !== undefined)
    memory.set(
      accountId,
      held.map((message) => (message.id === messageId ? { ...message, ...patch } : message))
    );
}

/** Forgets device-only messages that the server now has (by id or client message id). */
export function forgetDeliveredDeviceOnlyMessages(
  accountId: string,
  server: ChatMessage[],
  storage: DeviceOnlyStorage | null = browserStorage()
): void {
  const stored = readStored(accountId, storage);
  const remaining = stored.filter((message) => !serverHas(server, message));
  if (remaining.length !== stored.length) write(accountId, remaining, storage);
  const held = memory.get(accountId);
  if (held !== undefined)
    memory.set(
      accountId,
      held.filter((message) => !serverHas(server, message))
    );
}

function serverHas(server: ChatMessage[], message: ChatMessage): boolean {
  return server.some(
    (candidate) => candidate.id === message.id || candidate.clientMessageId === message.id
  );
}

/**
 * The thread to show after a refresh: what the server has, plus this conversation's device-only
 * messages (from the current view and from storage) that the server does not have yet. A search
 * exchange goes right after the message it followed when it was created (deviceOnlyAfter), after
 * any device-only messages already there, so placement never depends on the phone's clock
 * agreeing with the server's; one whose anchor is gone goes at the end. Messages waiting in the
 * outbox go at the end, in the order they were typed: the server will place them there when they
 * are sent. The current view wins over storage for the same id (it has the newest send state).
 */
export function keepDeviceOnlyMessages(
  current: ChatMessage[],
  refreshed: ChatMessage[],
  conversationId: string | null,
  stored: ChatMessage[] = []
): ChatMessage[] {
  const seen = new Set<string>();
  const local = [...current, ...stored].filter((message) => {
    if (message.deviceOnlyIn === undefined || message.deviceOnlyIn !== conversationId) return false;
    if (seen.has(message.id) || serverHas(refreshed, message)) return false;
    seen.add(message.id);
    return true;
  });
  if (local.length === 0) return refreshed;
  // Oldest first, so later ones land after earlier ones. These all come from this device's
  // clock, so comparing their times with each other is safe.
  const time = (message: ChatMessage) => Date.parse(message.createdAt ?? "") || 0;
  local.sort((left, right) => time(left) - time(right));
  // A message in the outbox gets its server time when it is finally sent, after everything the
  // server has now, so it shows at the end. Only a search exchange (never sent) keeps its place.
  const exchanges = local.filter((message) => message.outboxState === undefined);
  const outbox = local.filter((message) => message.outboxState !== undefined);
  const result = [...refreshed];
  for (const message of exchanges) {
    const anchor = message.deviceOnlyAfter ?? null;
    const anchorIndex = anchor === null ? -1 : result.findIndex((item) => item.id === anchor);
    if (anchor !== null && anchorIndex === -1) {
      result.push(message);
      continue;
    }
    let position = anchorIndex + 1;
    while (position < result.length && result[position]!.deviceOnlyIn !== undefined) position++;
    result.splice(position, 0, message);
  }
  result.push(...outbox);
  return result;
}

/**
 * The id a new device-only message follows: the last message in the thread that the server has
 * (it carries a client message id). Not the welcome placeholder or a bubble still being sent:
 * those are replaced on the next refresh, and an anchor that disappears would push the message to
 * the end of the thread, below everything said after it.
 */
export function deviceOnlyAnchor(messages: ChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.deviceOnlyIn === undefined && message.clientMessageId !== undefined)
      return message.id;
  }
  return null;
}

/**
 * The last turns a model sees as history. Device-only messages never reached the conversation (a
 * buyer's search exchange, a message still in the outbox), so they are left out.
 */
export function inferenceHistory(
  messages: ChatMessage[],
  limit = 12
): Array<{ role: "user" | "assistant"; content: string }> {
  return messages
    .filter(
      (message) =>
        (message.author === "merchant" || message.author === "grogoniclaw") &&
        message.deviceOnlyIn === undefined
    )
    .slice(-limit)
    .map((message) => ({
      role: message.author === "merchant" ? "user" : "assistant",
      content: message.body
    }));
}

/**
 * Messages waiting in the outbox for this conversation that have no thread copy here (an
 * encrypted message after a reload, whose text was never stored, or a copy lost to full
 * storage). Shown at the end of the thread with the text from the outbox when it is plain, so
 * the waiting count in the header always matches something visible.
 */
export function outboxPlaceholders(
  waiting: Array<{ clientMessageId: string; payload: Record<string, unknown> }>,
  conversationId: string,
  known: ChatMessage[]
): ChatMessage[] {
  return waiting
    .filter(
      (entry) =>
        entry.payload.conversationId === conversationId &&
        !known.some((message) => message.id === entry.clientMessageId)
    )
    .map((entry) => ({
      id: entry.clientMessageId,
      author: "merchant" as const,
      body: waitingText(entry.payload),
      status: "failed" as const,
      outboxState: "retrying" as const,
      deviceOnlyIn: conversationId,
      // No anchor: it goes at the end of the thread.
      deviceOnlyAfter: ""
    }));
}

/** The text of a waiting message from its outbox payload; an encrypted one has none to show. */
function waitingText(payload: Record<string, unknown>): string {
  const content = payload.content as { type?: unknown; text?: unknown } | undefined;
  return content?.type === "text" && typeof content.text === "string" && content.text.length > 0
    ? content.text
    : "Encrypted message waiting to send";
}
