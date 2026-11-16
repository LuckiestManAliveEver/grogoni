import { validLinkedChat, type LinkedSocket } from "./connector.js";

/**
 * WhatsApp read receipts for messages the shop reads in Grogoni
 * (docs/architecture/whatsapp-linked-devices.md, "Read receipts").
 *
 * Off by default for every chat; the owner turns them on per approved chat. The store queues one
 * entry per inbound WhatsApp message the first time someone in the shop reads it in Grogoni
 * (cp2/store.ts `queueLinkedReadReceipts`), re-checks authority when the connector host takes the
 * queue (`takeLinkedReadReceipts`), and the connector host sends them with Baileys
 * `readMessages` (baileys-driver.ts `markRead`).
 *
 * Delivery is at most once: the queue is in memory, a taken entry is never re-queued, and a send
 * failure is dropped. A missing read receipt is harmless; a repeated or misdirected one is not.
 */
export const linkedReadReceiptLimits = {
  /** Keys per `readMessages` call. */
  maxKeysPerBatch: 100,
  /** Queued entries per business; the oldest are dropped beyond this. */
  maxQueuedPerBusiness: 500,
  /** Messages older than this (provider time) get no receipt: the sender has moved on. */
  maxMessageAgeMs: 3 * 24 * 60 * 60_000,
  /** Entries waiting longer than this for a connected socket are dropped. */
  maxQueuedAgeMs: 60 * 60_000
} as const;

export interface LinkedReadReceiptKey {
  /** The WhatsApp message id (canonical `providerMessageId`). */
  id: string;
  /** The WhatsApp sender JID (canonical `senderAddress`); the participant in a group. */
  sender: string;
}

export interface LinkedReadReceiptBatch {
  chat: string;
  keys: LinkedReadReceiptKey[];
}

/** One queued receipt, keyed by the canonical message id (which deduplicates it). */
export interface LinkedReadReceiptEntry {
  messageId: string;
  businessId: string;
  ownerId: string;
  channelId: string;
  chat: string;
  sender: string;
  providerMessageId: string;
  queuedAt: string;
}

/** The driver socket with read receipts (baileys-driver.ts). */
export interface LinkedReadReceiptSocket extends LinkedSocket {
  markRead(chat: string, keys: LinkedReadReceiptKey[]): Promise<number>;
}

const messageIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/;
const senderPattern = /^[0-9]{5,20}(?::[0-9]{1,4})?@(?:s\.whatsapp\.net|lid)$/;

/**
 * The Baileys message keys for one chat: validated, deduplicated, never our own messages, at most
 * `maxKeysPerBatch`. A group key names its participant; a direct chat's key does not.
 */
export function linkedReadReceiptMessageKeys(
  chat: string,
  keys: readonly LinkedReadReceiptKey[]
): Array<{ remoteJid: string; id: string; fromMe: false; participant?: string }> {
  if (!validLinkedChat(chat)) return [];
  const group = chat.endsWith("@g.us");
  const seen = new Set<string>();
  const result: Array<{ remoteJid: string; id: string; fromMe: false; participant?: string }> = [];
  for (const key of keys) {
    if (result.length >= linkedReadReceiptLimits.maxKeysPerBatch) break;
    if (!messageIdPattern.test(key.id) || !senderPattern.test(key.sender)) continue;
    const dedupe = `${key.id}\u0000${key.sender}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    result.push({
      remoteJid: chat,
      id: key.id,
      fromMe: false,
      ...(group ? { participant: key.sender } : {})
    });
  }
  return result;
}

/** Groups entries by chat, oldest first, in batches of at most `maxKeysPerBatch`. */
export function batchLinkedReadReceipts(
  entries: readonly LinkedReadReceiptEntry[]
): LinkedReadReceiptBatch[] {
  const byChat = new Map<string, LinkedReadReceiptKey[]>();
  for (const entry of [...entries].sort((left, right) =>
    left.queuedAt.localeCompare(right.queuedAt)
  )) {
    const keys = byChat.get(entry.chat) ?? [];
    keys.push({ id: entry.providerMessageId, sender: entry.sender });
    byChat.set(entry.chat, keys);
  }
  const batches: LinkedReadReceiptBatch[] = [];
  for (const [chat, keys] of byChat)
    for (let offset = 0; offset < keys.length; offset += linkedReadReceiptLimits.maxKeysPerBatch)
      batches.push({
        chat,
        keys: keys.slice(offset, offset + linkedReadReceiptLimits.maxKeysPerBatch)
      });
  return batches;
}

/** What the connector host provides: the approval check and the socket call. */
export interface LinkedReadReceiptTarget {
  /** True only while the chat is approved on this host's connector for this owner. */
  approved(businessId: string, ownerId: string, chat: string): boolean;
  markRead(
    businessId: string,
    ownerId: string,
    chat: string,
    keys: LinkedReadReceiptKey[]
  ): Promise<number>;
}

export interface LinkedReadReceiptQueue {
  takeLinkedReadReceipts(input: {
    businessId: string;
    ownerId: string;
    approved: (chat: string) => boolean;
    now?: Date;
  }): LinkedReadReceiptBatch[];
}

/**
 * Takes the business's queue and sends it. Never throws: a failed batch is counted and dropped.
 * Run it on the connector host when the store signals a queued receipt and after CONNECTED.
 */
export async function dispatchLinkedReadReceipts(
  queue: LinkedReadReceiptQueue,
  target: LinkedReadReceiptTarget,
  businessId: string,
  ownerId: string
): Promise<{ sent: number; failed: number }> {
  let batches: LinkedReadReceiptBatch[];
  try {
    batches = queue.takeLinkedReadReceipts({
      businessId,
      ownerId,
      approved: (chat) => target.approved(businessId, ownerId, chat)
    });
  } catch {
    return { sent: 0, failed: 0 };
  }
  let sent = 0;
  let failed = 0;
  for (const batch of batches) {
    try {
      sent += await target.markRead(businessId, ownerId, batch.chat, batch.keys);
    } catch {
      failed += batch.keys.length;
    }
  }
  return { sent, failed };
}
