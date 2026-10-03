import type { ConversationMessageSummary } from "@grogoni/shared-types";
import { OfflineError, type CatalogueDigest, type OfflineOrderIntent } from "../types.js";
import { validateOfflineOrderIntent } from "../offline-orders/intent.js";
import type { GrogoniProvider } from "./types.js";
import type { LocalDatabase } from "../db/client.js";
import type { Scope } from "../types.js";
export interface PeerTransport {
  /** Must authenticate peers and encrypt the link before exposing it to this adapter. */
  available(): Promise<boolean>;
  discover(): Promise<string[]>;
  connect(deviceId: string): Promise<void>;
  broadcast(frame: Uint8Array): Promise<void>;
  subscribe(handler: (frame: Uint8Array) => void): () => void;
  mtu: number;
}
/** What one outbox slot carries. `id` is the application-level dedupe/acknowledgement key
 *  (ConversationMessageSummary.id or OfflineOrderIntent.id) - distinct from the fresh
 *  per-transmission fragmentation id `transmit()` generates on every attempt. */
export type PeerOutboxEnvelope =
  | { kind: "conversation_message"; message: ConversationMessageSummary }
  | { kind: "order_intent"; intent: OfflineOrderIntent };
export interface PeerQueuedMessage {
  id: string;
  envelope: PeerOutboxEnvelope;
  expiresAt: number;
  attempts: number;
}
/** Resend cap from the whitepaper's sender-outbox section (§6.1): a message that still has
 *  not been acknowledged after this many transmit attempts is dropped with a visible failure
 *  instead of being retried forever. */
export const PEER_OUTBOX_RESEND_CAP = 8;
export interface PeerOutbox {
  load(): Promise<PeerQueuedMessage[]>;
  save(messages: PeerQueuedMessage[]): Promise<void>;
}
export function createPeerOutbox(db: LocalDatabase, scope: Scope): PeerOutbox {
  return {
    load: async () => (await db.read(scope)).peerOutbox ?? [],
    save: async (messages) => {
      await db.transaction(scope, (state) => {
        state.peerOutbox = structuredClone(messages);
      });
    }
  };
}
const LEGACY_FRAME_VERSION = 1;
const FRAME_VERSION = 2;
const LEGACY_HEADER_BYTES = 23; // version(1) + hop(1) + kind(1) + id(16) + index(2) + count(2)
const HEADER_BYTES = 27; // v1 header + CRC32(4); TTL is intentionally excluded from the checksum.
const KIND_CONVERSATION_MESSAGE = 0;
const KIND_CATALOGUE_DIGEST = 1;
const KIND_ORDER_INTENT = 2;
const MAX_CATALOGUE_DIGEST_BYTES = 512;
const MAX_ENVELOPE_BYTES = 64 * 1024;
/** Experimental transport only. Never invokes a business operation or trusts a BLE name as
 *  identity - every OfflineOrderIntent this transport carries must already carry a real Grogoni
 *  account/phone customer claim (see types.ts's OfflineOrderCustomerClaim); PeerProvider itself
 *  never inspects or trusts transport.discover()'s device ids as identity. */
export class PeerProvider implements GrogoniProvider {
  readonly name = "peer";
  private handlers = new Set<(envelope: ConversationMessageSummary) => void>();
  private deliveryFailedHandlers = new Set<(envelope: ConversationMessageSummary) => void>();
  private orderIntentDeliveryFailedHandlers = new Set<(intent: OfflineOrderIntent) => void>();
  private catalogueDigestHandlers = new Set<(digest: CatalogueDigest) => void>();
  private fragments = new Map<
    string,
    { parts: Map<number, Uint8Array>; count: number; kind: number; expires: number }
  >();
  private seen = new Map<string, number>();
  private seenFrames = new Map<string, number>();
  private pendingRelays = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribe: () => void;
  constructor(
    private transport: PeerTransport,
    private outbox: PeerOutbox,
    /** Called for every well-formed inbound order_intent, and nothing else - this is the only
     *  path an incoming BLE order can take. Left unset, order_intent frames are validated then
     *  dropped, so a device that hasn't wired local staging never silently accepts orders. Must
     *  never be, or call into, anything that mutates committed stock: pair it with
     *  offline-orders/intent.ts's recordPendingOfflineOrder, which only ever writes to
     *  pending_offline_orders. */
    private orderIntentSink?: (intent: OfflineOrderIntent) => void | Promise<void>
  ) {
    if (transport.mtu < 32) throw new Error("BLE MTU is too small.");
    this.unsubscribe = transport.subscribe((frame) => {
      this.receive(frame);
    });
  }
  supports(op: string): boolean {
    return (
      op === "conversations.message.send" ||
      op === "peer.catalogueDigest.broadcast" ||
      op === "peer.orderIntent.send"
    );
  }
  isAvailable(): Promise<boolean> {
    return this.transport.available();
  }
  discover(): Promise<string[]> {
    return this.transport.discover();
  }
  async connect(deviceId: string): Promise<void> {
    await this.transport.connect(deviceId);
    await this.flush();
  }
  async call<T>(op: string, args: unknown): Promise<T> {
    if (op === "conversations.message.send") {
      await this.send(args as ConversationMessageSummary);
      return { queued: true } as T;
    }
    if (op === "peer.catalogueDigest.broadcast") {
      await this.broadcastCatalogueDigest(args as CatalogueDigest);
      return { queued: true } as T;
    }
    if (op === "peer.orderIntent.send") {
      await this.sendOrderIntent(args as OfflineOrderIntent);
      return { queued: true } as T;
    }
    throw new OfflineError(
      "OPERATION_UNAVAILABLE",
      "Peers can transport conversation messages, catalogue digests and order intents only."
    );
  }
  async send(envelope: ConversationMessageSummary): Promise<void> {
    validateEnvelope(envelope);
    await this.enqueue(envelope.id, { kind: "conversation_message", message: envelope });
    // Sending frames is not a delivery acknowledgement. Retain until the authenticated
    // application acknowledges the message, including across process restarts.
  }
  /** Queued and retried exactly like a conversation message (same outbox, same resend cap) -
   *  an order intent is high-value and must not drop silently just because the merchant device
   *  is out of range when it's first captured. */
  async sendOrderIntent(intent: OfflineOrderIntent): Promise<void> {
    validateOfflineOrderIntent(intent);
    await this.enqueue(intent.id, { kind: "order_intent", intent });
  }
  /** Fire-and-forget broadcast, no outbox, no acknowledgement. A digest is a cheap, idempotent
   *  beacon meant to be reissued periodically - the outbox's guaranteed-delivery/resend-cap
   *  machinery is the wrong tool for it, and would only fill the queue with stale digests. */
  async broadcastCatalogueDigest(digest: CatalogueDigest): Promise<void> {
    validateCatalogueDigest(digest);
    const bytes = new TextEncoder().encode(JSON.stringify(digest));
    if (bytes.length > MAX_CATALOGUE_DIGEST_BYTES)
      throw new Error("Catalogue digests must stay small enough to broadcast freely.");
    await this.transmitBytes(KIND_CATALOGUE_DIGEST, bytes);
  }
  private async enqueue(id: string, envelope: PeerOutboxEnvelope): Promise<void> {
    const bytes = new TextEncoder().encode(
      JSON.stringify(envelope.kind === "conversation_message" ? envelope.message : envelope.intent)
    );
    if (bytes.length > MAX_ENVELOPE_BYTES)
      throw new Error(
        "Peer messages must fit within 64 KiB. Attachments need a separate transport."
      );
    const queue = (await this.outbox.load()).filter((entry) => entry.expiresAt > Date.now());
    // Scoped by kind as well as id: ConversationMessageSummary.id and OfflineOrderIntent.id are
    // independently generated by unrelated callers and share one outbox, so a bare id match here
    // (unlike acknowledge()/attemptDelivery() below, which trust a caller-supplied id and can't
    // disambiguate) would otherwise let one kind's entry mask the other's on the vanishingly
    // unlikely event of an id collision.
    if (!queue.some((entry) => entry.id === id && entry.envelope.kind === envelope.kind)) {
      if (queue.length >= 100) throw new Error("Nearby message queue is full.");
      queue.push({ id, envelope, expiresAt: Date.now() + 24 * 60 * 60 * 1000, attempts: 0 });
      await this.outbox.save(queue);
    }
    if (await this.isAvailable()) await this.attemptDelivery(id);
  }
  async acknowledge(id: string): Promise<void> {
    await this.outbox.save((await this.outbox.load()).filter((entry) => entry.id !== id));
  }
  onReceive(handler: (envelope: ConversationMessageSummary) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
  /** Fires once a queued message is dropped after PEER_OUTBOX_RESEND_CAP unacknowledged
   *  transmit attempts, so the caller can surface a visible failure instead of leaving the
   *  sender believing delivery is still pending. */
  onDeliveryFailed(handler: (envelope: ConversationMessageSummary) => void): () => void {
    this.deliveryFailedHandlers.add(handler);
    return () => {
      this.deliveryFailedHandlers.delete(handler);
    };
  }
  onOrderIntentDeliveryFailed(handler: (intent: OfflineOrderIntent) => void): () => void {
    this.orderIntentDeliveryFailedHandlers.add(handler);
    return () => {
      this.orderIntentDeliveryFailedHandlers.delete(handler);
    };
  }
  /** Read-only ambient info; never mutates anything. Callers use this to decide whether to
   *  `connect(deviceId)` for a direct delta pull - PeerProvider never initiates that pull itself. */
  onCatalogueDigest(handler: (digest: CatalogueDigest) => void): () => void {
    this.catalogueDigestHandlers.add(handler);
    return () => {
      this.catalogueDigestHandlers.delete(handler);
    };
  }
  async flush(): Promise<void> {
    const queue = (await this.outbox.load()).filter((entry) => entry.expiresAt > Date.now());
    await this.outbox.save(queue);
    for (const entry of queue) await this.attemptDelivery(entry.id);
  }
  /** Transmits one queued entry and advances its attempt count, dropping it with a visible
   *  failure once PEER_OUTBOX_RESEND_CAP is reached rather than retrying forever. */
  private async attemptDelivery(id: string): Promise<void> {
    const queue = await this.outbox.load();
    const entry = queue.find((candidate) => candidate.id === id);
    if (!entry) return;
    const attempts = entry.attempts + 1;
    if (attempts >= PEER_OUTBOX_RESEND_CAP) {
      await this.outbox.save(queue.filter((candidate) => candidate.id !== id));
      if (entry.envelope.kind === "conversation_message") {
        for (const handler of this.deliveryFailedHandlers) handler(entry.envelope.message);
      } else {
        for (const handler of this.orderIntentDeliveryFailedHandlers)
          handler(entry.envelope.intent);
      }
      return;
    }
    await this.outbox.save(
      queue.map((candidate) => (candidate.id === id ? { ...candidate, attempts } : candidate))
    );
    const bytes = new TextEncoder().encode(
      JSON.stringify(
        entry.envelope.kind === "conversation_message"
          ? entry.envelope.message
          : entry.envelope.intent
      )
    );
    await this.transmitBytes(
      entry.envelope.kind === "conversation_message"
        ? KIND_CONVERSATION_MESSAGE
        : KIND_ORDER_INTENT,
      bytes
    );
  }
  close(): void {
    this.unsubscribe();
    this.handlers.clear();
    this.deliveryFailedHandlers.clear();
    this.orderIntentDeliveryFailedHandlers.clear();
    this.catalogueDigestHandlers.clear();
    this.fragments.clear();
    for (const timer of this.pendingRelays.values()) clearTimeout(timer);
    this.pendingRelays.clear();
  }
  private async transmitBytes(kind: number, bytes: Uint8Array): Promise<void> {
    const chunkSize = this.transport.mtu - HEADER_BYTES;
    const count = Math.ceil(bytes.length / chunkSize);
    const id = crypto.randomUUID().replaceAll("-", "");
    for (let index = 0; index < count; index++) {
      const payload = bytes.slice(index * chunkSize, (index + 1) * chunkSize);
      const frame = new Uint8Array(HEADER_BYTES + payload.length);
      const view = new DataView(frame.buffer);
      frame[0] = FRAME_VERSION;
      frame[1] = 7;
      frame[2] = kind;
      for (let byte = 0; byte < 16; byte++)
        frame[byte + 3] = parseInt(id.slice(byte * 2, byte * 2 + 2), 16);
      view.setUint16(19, index);
      view.setUint16(21, count);
      frame.set(payload, HEADER_BYTES);
      view.setUint32(23, frameChecksum(frame, HEADER_BYTES));
      await this.transport.broadcast(frame);
    }
  }
  private receive(frame: Uint8Array): void {
    const version = frame[0];
    const headerBytes = version === FRAME_VERSION ? HEADER_BYTES : LEGACY_HEADER_BYTES;
    if (
      frame.length < headerBytes + 1 ||
      frame.length > this.transport.mtu ||
      (version !== FRAME_VERSION && version !== LEGACY_FRAME_VERSION) ||
      !frame[1] ||
      frame[1] > 7
    )
      return;
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    if (version === FRAME_VERSION && view.getUint32(23) !== frameChecksum(frame, headerBytes))
      return;
    const kind = frame[2];
    if (
      kind !== KIND_CONVERSATION_MESSAGE &&
      kind !== KIND_CATALOGUE_DIGEST &&
      kind !== KIND_ORDER_INTENT
    )
      return;
    const now = Date.now();
    for (const [key, value] of this.fragments) if (value.expires <= now) this.fragments.delete(key);
    for (const [key, value] of this.seen) if (value <= now) this.seen.delete(key);
    for (const [key, value] of this.seenFrames) if (value <= now) this.seenFrames.delete(key);
    const id = [...frame.slice(3, 19)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const index = view.getUint16(19);
    const count = view.getUint16(21);
    if (
      !count ||
      index >= count ||
      count * (this.transport.mtu - headerBytes) > MAX_ENVELOPE_BYTES + this.transport.mtu
    )
      return;
    const frameKey = `${id}:${index}`;
    if (this.seenFrames.has(frameKey)) {
      const pendingRelay = this.pendingRelays.get(frameKey);
      if (pendingRelay) {
        clearTimeout(pendingRelay);
        this.pendingRelays.delete(frameKey);
      }
      return;
    }
    if (this.seenFrames.size >= 8_192) return;
    this.seenFrames.set(frameKey, now + 60_000);
    if (!this.fragments.has(id) && this.fragments.size >= 32) return;
    const entry = this.fragments.get(id) ?? {
      parts: new Map<number, Uint8Array>(),
      count,
      kind,
      expires: now + 60_000
    };
    if (entry.count !== count || entry.kind !== kind) return;
    const duplicate = entry.parts.has(index);
    entry.parts.set(index, frame.slice(headerBytes));
    this.fragments.set(id, entry);
    if (!duplicate && frame[1] > 1) {
      const relay = frame.slice();
      relay[1]!--;
      // BitChat-style jitter gives another relay time to win. Hearing the same fragment before
      // this timer fires cancels our copy above, reducing redundant flood traffic.
      const timer = setTimeout(
        () => {
          this.pendingRelays.delete(frameKey);
          void this.transport.broadcast(relay).catch(() => undefined);
        },
        10 + Math.floor(Math.random() * 211)
      );
      this.pendingRelays.set(frameKey, timer);
    }
    if (entry.parts.size !== count) return;
    this.fragments.delete(id);
    const size = [...entry.parts.values()].reduce((sum, bytes) => sum + bytes.length, 0);
    if (size > MAX_ENVELOPE_BYTES) return;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (let part = 0; part < count; part++) {
      const data = entry.parts.get(part)!;
      bytes.set(data, offset);
      offset += data.length;
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (kind === KIND_CONVERSATION_MESSAGE) {
        const envelope = JSON.parse(text) as ConversationMessageSummary;
        validateEnvelope(envelope);
        const dedupeKey = `message:${envelope.id}`;
        if (this.seen.has(dedupeKey)) return;
        this.markSeen(dedupeKey, now);
        for (const handler of this.handlers) handler(envelope);
      } else if (kind === KIND_CATALOGUE_DIGEST) {
        const digest = JSON.parse(text) as CatalogueDigest;
        validateCatalogueDigest(digest);
        // Digests are an idempotent, repeatable beacon - no dedupe beyond the frame-level one
        // above, so a merchant device can reissue the same digest on every advertisement tick.
        for (const handler of this.catalogueDigestHandlers) handler(digest);
      } else {
        const intent = JSON.parse(text) as OfflineOrderIntent;
        validateOfflineOrderIntent(intent);
        const dedupeKey = `order:${intent.id}`;
        if (this.seen.has(dedupeKey)) return;
        // Mark seen only once the sink has actually accepted the intent, not before: the intended
        // sink (recordPendingOfflineOrder) is itself idempotent per intent id, so it is always
        // safe to let a retransmitted frame reach it again - but marking seen up front and then
        // losing a failed write (a full local outbox, a storage error) would permanently drop the
        // order with no signal to either device, since the sender's outbox has no acknowledgement
        // protocol for order intents to retry against.
        if (this.orderIntentSink)
          void Promise.resolve(this.orderIntentSink(intent))
            .then(() => this.markSeen(dedupeKey, now))
            .catch(() => undefined);
      }
    } catch {
      /* Reject malformed frames without invoking business logic. */
    }
  }
  private markSeen(key: string, now: number): void {
    if (this.seen.size >= 1_024) this.seen.delete(this.seen.keys().next().value!);
    this.seen.set(key, now + 24 * 60 * 60 * 1000);
  }
}

function frameChecksum(frame: Uint8Array, headerBytes: number): number {
  let crc = 0xffffffff;
  for (let index = 0; index < frame.length; index++) {
    // TTL changes at each hop and bytes 23..26 contain the checksum itself.
    if (index === 1 || (index >= 23 && index < headerBytes)) continue;
    crc ^= frame[index]!;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function validateEnvelope(value: ConversationMessageSummary): void {
  if (
    !value ||
    typeof value !== "object" ||
    [
      value.id,
      value.conversationId,
      value.clientMessageId,
      value.idempotencyKey,
      value.authorId
    ].some((id) => typeof id !== "string" || !id || id.length > 200) ||
    !["user", "agent", "system"].includes(value.author) ||
    !value.content ||
    typeof value.content !== "object"
  )
    throw new Error("Invalid canonical conversation envelope.");
}
function validateCatalogueDigest(value: CatalogueDigest): void {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.storeId !== "string" ||
    !value.storeId ||
    value.storeId.length > 200 ||
    typeof value.productListHash !== "string" ||
    !value.productListHash ||
    value.productListHash.length > 128 ||
    !Number.isSafeInteger(value.lastSyncSequence) ||
    value.lastSyncSequence < 0 ||
    typeof value.issuedAt !== "string" ||
    Number.isNaN(Date.parse(value.issuedAt))
  )
    throw new Error("Invalid catalogue digest.");
}
