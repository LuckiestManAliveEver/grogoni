import { createHash, randomUUID } from "node:crypto";
import type { LinkedReadReceiptKey, LinkedReadReceiptSocket } from "./read-receipts.js";
import type { ChannelCapability, ChannelProviderReadiness } from "@grogoni/shared-types";
import type {
  MessagingChannelAdapter,
  OutboundChannelMessage,
  ChannelSendResult
} from "../channel-gateway.js";
import { ChannelGatewayError } from "../channel-errors.js";
import type { LinkedSessionVault } from "./vault.js";
import type { LinkedLeaseGuard } from "./lease.js";
import { linkedOptOutCommand } from "./opt-out.js";
import {
  LinkedMediaRejected,
  validateLinkedMedia,
  type LinkedMedia,
  type LinkedDownloadedMedia
} from "./media.js";

export type LinkedState =
  | "DISCONNECTED"
  | "PAIRING"
  | "CONNECTING"
  | "CONNECTED"
  | "RECONNECTING"
  | "AUTH_REQUIRED"
  | "REVOKED"
  | "SUSPENDED"
  | "ERROR";
export type LinkedMutation =
  | { kind: "edit"; targetId: string; fromMe: boolean }
  | { kind: "delete"; targetId: string; fromMe: boolean }
  | {
      kind: "receipt";
      targetId: string;
      fromMe: true;
      status: "sent" | "delivered" | "read" | "failed";
    };
export interface LinkedInbound {
  id: string;
  chat: string;
  sender: string;
  text: string;
  timestamp: string;
  fromMe: boolean;
  mentioned: boolean;
  replyTo?: string;
  automationGrant?: string | null;
  media?: LinkedMedia[];
  mutation?: LinkedMutation;
}
export interface LinkedSocket {
  pairingCode(phone: string): Promise<string>;
  groups?(): Promise<Array<{ chat: string; name: string }>>;
  send(
    chat: string,
    text: string,
    messageId: string,
    media?: LinkedDownloadedMedia,
    quote?: OutboundChannelMessage["quotedMessage"]
  ): Promise<string>;
  close(): void;
  logout(): Promise<void>;
  downloadMedia?(media: LinkedMedia, signal: AbortSignal): Promise<Buffer>;
}
export interface LinkedDriver {
  open(input: {
    /** The business this socket serves. Drivers that pick a remote worker route on it. */
    businessId?: string;
    auth: string | null;
    expectedPhone?: string;
    approvedContacts?: () => string[];
    save: (auth: string) => void;
    state: (state: "open" | "close", reason?: "revoked" | "restart" | "retry" | "auth") => void;
    inbound: (message: LinkedInbound) => void;
  }): Promise<LinkedSocket>;
}
interface Scope {
  chat: string;
  conversationId: string;
  automation?: boolean;
  grantId?: string;
}
interface RecordData {
  businessId: string;
  ownerId: string;
  phone?: string;
  generation: string;
  auth: string | null;
  scopes: Scope[];
  inbox: LinkedInbound[];
  admissions?: Record<string, number>;
  sent: Record<string, LinkedSentEntry>;
}
/**
 * One outbound delivery key. `pending` is handed to WhatsApp without a confirmed answer (an
 * uncertain delivery, never resent); `sent` is settled. `at` is when the entry last changed
 * (epoch ms); entries written before it existed get it the first time the journal is pruned.
 */
interface LinkedSentEntry {
  fingerprint: string;
  id: string;
  status: "pending" | "sent";
  automated?: boolean;
  at?: number;
}
interface Active {
  data: RecordData;
  state: LinkedState;
  socket?: LinkedSocket;
  code?: string;
  expiresAt?: number;
  timer?: ReturnType<typeof setTimeout>;
  attempts: number;
  opening: boolean;
  draining?: boolean;
  ingressFailures?: number;
  mediaFetch?: { chat: string; controller: AbortController };
  /** Lease generation the current socket runs under (multi-worker mode only). */
  lease?: string;
  /**
   * Inbound backpressure: the journal reached `inboxPauseAt`, so the socket was closed to stop
   * intake while the journal drains. The session reconnects by itself (see `pauseIntake`).
   */
  paused?: boolean;
  /** Consecutive pauses without the journal emptying; drives the reconnect backoff. */
  pauses?: number;
  /** The pause's backoff has elapsed; reconnect as soon as the drain needs the socket. */
  resumeDue?: boolean;
}
const LIVE_STATES: ReadonlySet<LinkedState> = new Set([
  "PAIRING",
  "CONNECTING",
  "CONNECTED",
  "RECONNECTING"
]);
/** States with no socket and no scheduled reconnect: the business's lease is handed back. */
const IDLE_STATES: ReadonlySet<LinkedState> = new Set([
  "DISCONNECTED",
  "AUTH_REQUIRED",
  "REVOKED",
  "SUSPENDED",
  "ERROR"
]);
/** Raised when another worker holds the business's lease, or the lease store is unreachable. */
export class LinkedLeaseUnavailable extends ChannelGatewayError {
  constructor() {
    super(
      "CHANNEL_UNAVAILABLE",
      "This WhatsApp account is running on another Grogoni worker. Try again shortly.",
      true
    );
  }
}
/**
 * Raised by a driver when this business's socket must run on an enrolled remote worker that is
 * not connected to this host. The session waits (SUSPENDED) and retries; nothing runs locally.
 */
export class LinkedWorkerOffline extends ChannelGatewayError {
  constructor() {
    super(
      "CHANNEL_UNAVAILABLE",
      "This business's WhatsApp worker is offline. Start it, then try again.",
      true
    );
  }
}
/** Accounts one worker runs at once. Not an experimentally certified capacity. */
const HOST_SESSION_LIMIT = 8;
/**
 * Inbound journal bounds (docs: "Inbound backpressure"). At `pauseAt` queued events the socket is
 * closed so WhatsApp holds further messages server-side; the journal drains and the session
 * reconnects once it is down to `resumeAt` (or its head needs the socket), after a backoff of
 * 2 s doubling per consecutive pause, capped at 60 s. Events a closing socket still delivers are
 * journaled up to `hardLimit`; only beyond that is an event refused, and that is reported.
 */
export const linkedInboxLimits = { pauseAt: 64, resumeAt: 16, hardLimit: 128 } as const;
/**
 * Delivery journal bounds (docs: "Delivery journal retention"). Settled sends are kept for the
 * same 7 days the delegated-result and device outboxes keep settled entries for duplicate
 * suppression; every caller that can re-present a delivery key gives up long before (outbox
 * expiry is 24 hours). Pending (uncertain) sends are never pruned; only they can fill the journal.
 */
export const linkedSentJournalLimits = {
  settledRetainMs: 7 * 24 * 60 * 60_000,
  settledMax: 2_000,
  pendingMax: 1_000
} as const;
/** Media download attempts before the attachment is replaced by a placeholder. */
const MEDIA_DEFAULTS = { attempts: 3, retryDelayMs: 2_000, timeoutMs: 30_000 };
export const linkedMediaUnavailableText = "[Attachment could not be downloaded.]";
export const linkedMediaRejectedText = "[Attachment rejected: unsupported or invalid media.]";
/** What the canonical store did with one inbound event; `throttled` was not stored (quota). */
export type LinkedReceiveOutcome = void | "throttled";
export function validLinkedChat(chat: string): boolean {
  return /^(?:[0-9]{5,20}@(?:s\.whatsapp\.net|lid)|[0-9]{5,20}(?:-[0-9]{1,20})?@g\.us)$/.test(chat);
}
const capabilities: ChannelCapability[] = [
  "CAN_SEND",
  "CAN_RECEIVE",
  "CAN_REPLY",
  "SUPPORTS_ATTACHMENTS",
  "SUPPORTS_MEDIA",
  "REQUIRES_EXISTING_THREAD"
];

/**
 * One instance per private volume / worker. All socket events are fenced by connection generation.
 * With `lease` configured (multi-worker), a business's socket runs only while this worker holds
 * its Postgres lease; the lease generation prefixes the socket epoch, and losing the lease closes
 * the socket and stops sends and ingress. Without `lease`, behaviour is single-process: the
 * volume flock is the only ownership guard.
 */
export class LinkedWhatsAppConnector implements MessagingChannelAdapter {
  readonly provider = "whatsapp_linked" as const;
  private readonly active = new Map<string, Active>();
  private enabled = true;
  private index: Record<string, string> = {};
  private readonly shutdown = new AbortController();
  private readonly authorizationTimer: ReturnType<typeof setInterval>;
  private readonly unsubscribeLease: (() => void) | undefined;
  constructor(
    private readonly options: {
      vault: LinkedSessionVault;
      driver: LinkedDriver;
      authorize: (businessId: string, ownerId: string) => void;
      alreadyReceived?: (businessId: string, ownerId: string, message: LinkedInbound) => boolean;
      /** Resolves `"throttled"` when the store refused the event under its inbound quota. */
      receive: (
        businessId: string,
        ownerId: string,
        generation: string,
        message: LinkedInbound,
        media?: LinkedDownloadedMedia[]
      ) => Promise<LinkedReceiveOutcome>;
      /**
       * Operational notices that are not state changes: intake paused for backpressure, an event
       * refused beyond the hard journal limit, an attachment replaced by a placeholder.
       */
      notice?: (event: {
        businessId: string;
        type: "intake_paused" | "inbound_refused" | "media_unavailable" | "media_rejected";
        queued: number;
      }) => void;
      /** Media download retry policy; tests shorten it. */
      media?: { attempts?: number; retryDelayMs?: number; timeoutMs?: number };
      /** `lease` is the generation the session runs under, when it holds one. */
      event?: (event: {
        businessId: string;
        ownerId: string;
        state: LinkedState;
        lease?: string;
      }) => void;
      respond?: (
        businessId: string,
        ownerId: string,
        message: LinkedInbound,
        conversationId: string,
        signal: AbortSignal
      ) => Promise<string | null>;
      deliver?: (
        businessId: string,
        ownerId: string,
        message: LinkedInbound,
        text: string,
        key: string
      ) => Promise<void>;
      now?: () => number;
      /** Multi-worker ownership. Omit for single-process deployments. Stopped by `stop()`. */
      lease?: LinkedLeaseGuard;
      /**
       * Several workers share this vault directory (requires `lease`). The index becomes one
       * entry file per business, written only under that business's lease, and the directory
       * is rescanned every `lease.retryMs` so a standby learns about sessions linked elsewhere.
       */
      sharedVolume?: boolean;
      /**
       * The business's shared automatic-reply budget (store `admitLinkedAutomatedReply`), which
       * also counts delegated results. Without it the connector keeps its own 60/hour count.
       */
      admit?: (businessId: string, key: string) => boolean;
      /** Returns an admitted slot when nothing reached the channel gateway. */
      releaseAdmission?: (businessId: string, key: string) => void;
    }
  ) {
    if (options.sharedVolume && !options.lease)
      throw new Error("A shared WhatsApp session volume requires multi-worker leasing.");
    this.index = options.sharedVolume
      ? options.vault.indexEntries()
      : JSON.parse(options.vault.read("$index") ?? "{}");
    this.unsubscribeLease = options.lease?.onLost((businessId, generation) =>
      this.leaseLost(businessId, generation)
    );
    this.authorizationTimer = setInterval(() => {
      for (const active of this.active.values()) {
        try {
          this.authorizeActive(active);
        } catch {
          active.socket?.close();
        }
      }
    }, 30_000);
    this.authorizationTimer.unref?.();
    if (options.sharedVolume && options.lease) {
      this.rescanTimer = setInterval(() => this.rescan(), options.lease.retryMs);
      this.rescanTimer.unref?.();
    }
  }
  private readonly rescanTimer: ReturnType<typeof setInterval> | undefined;
  async restore(): Promise<void> {
    if (this.options.sharedVolume) this.index = this.options.vault.indexEntries();
    for (const [businessId, ownerId] of Object.entries(this.index)) {
      try {
        const active = this.load(businessId, ownerId);
        if (active?.data.auth) await this.connect(businessId, ownerId);
      } catch (error) {
        const active = this.active.get(businessId);
        // Another worker runs it: wait as a standby and take over once its lease expires.
        if (active && error instanceof LinkedLeaseUnavailable) this.standby(active);
        else if (active) this.transition(active, "ERROR");
      }
    }
  }
  /** Shared volume: pick up sessions another worker linked, as standbys of their own. */
  private rescan(): void {
    if (!this.enabled) return;
    let entries: Record<string, string>;
    try {
      entries = this.options.vault.indexEntries();
    } catch {
      return; // Volume unreadable right now; the next pass retries.
    }
    this.index = entries;
    for (const [businessId, ownerId] of Object.entries(entries)) {
      if (this.active.has(businessId)) continue;
      try {
        const active = this.load(businessId, ownerId);
        if (active?.data.auth) this.standby(active);
      } catch {
        this.active.delete(businessId);
      }
    }
  }
  private addIndex(businessId: string, ownerId: string): void {
    this.index[businessId] = ownerId;
    if (this.options.sharedVolume) this.options.vault.writeIndexEntry(businessId, ownerId);
    else this.options.vault.write("$index", JSON.stringify(this.index));
  }
  private removeIndex(businessId: string): void {
    delete this.index[businessId];
    if (this.options.sharedVolume) this.options.vault.deleteIndexEntry(businessId);
    else this.options.vault.write("$index", JSON.stringify(this.index));
  }
  /** Sessions this worker runs right now (lease held), for the per-host limit. */
  private runningCount(): number {
    let count = 0;
    for (const active of this.active.values())
      if (active.lease !== undefined && this.leased(active)) count++;
    return count;
  }
  /**
   * True while this worker holds the business's lease (always in single-process mode). Request
   * routing uses it to decide between handling a request here and forwarding it to the holder.
   */
  servesLocally(businessId: string): boolean {
    if (!this.options.lease) return true;
    const active = this.active.get(businessId);
    return Boolean(
      active && this.current(active) && active.lease !== undefined && this.leased(active)
    );
  }
  /**
   * Retry a restorable session now instead of at its next timer, e.g. when its remote worker
   * has just connected to this host. No-op for live, unauthorized or unknown sessions.
   */
  async wake(businessId: string): Promise<void> {
    const ownerId = this.index[businessId];
    if (!ownerId || !this.enabled) return;
    const active = this.load(businessId, ownerId);
    if (!active?.data.auth || LIVE_STATES.has(active.state) || active.opening) return;
    clearTimeout(active.timer);
    try {
      await this.connect(businessId, ownerId);
    } catch (error) {
      const current = this.active.get(businessId);
      if (current && error instanceof LinkedLeaseUnavailable) this.standby(current);
    }
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private persist(active: Active) {
    // A worker that lost its lease must never overwrite its successor's record.
    if (!this.leased(active)) throw new Error("This worker no longer holds the WhatsApp session.");
    // Every write is a full record rewrite: keep the delivery journal bounded before each one.
    pruneLinkedSentJournal(active.data.sent, this.now());
    this.options.vault.write(active.data.businessId, JSON.stringify(active.data));
  }
  /**
   * Re-reads the record after a lease is (re)acquired: a previous holder sharing the volume may
   * have advanced credentials and journals since this worker cached them. False when it is gone.
   */
  private refresh(active: Active): boolean {
    const raw = this.options.vault.read(active.data.businessId);
    if (!raw) return false;
    const data = JSON.parse(raw) as RecordData;
    data.inbox ??= [];
    if (data.businessId !== active.data.businessId) throw new Error("Session tenant mismatch.");
    if (data.ownerId !== active.data.ownerId) return false;
    active.data = data;
    return true;
  }
  private transition(active: Active, state: LinkedState) {
    active.state = state;
    if (IDLE_STATES.has(state)) this.releaseLease(active);
    if (state !== "PAIRING") {
      delete active.code;
      delete active.expiresAt;
    }
    this.options.event?.({
      businessId: active.data.businessId,
      ownerId: active.data.ownerId,
      state,
      ...(active.lease !== undefined ? { lease: active.lease } : {})
    });
  }
  private erase(active: Active): void {
    this.active.delete(active.data.businessId);
    active.mediaFetch?.controller.abort();
    clearTimeout(active.timer);
    active.data.generation = randomUUID();
    active.data.auth = null;
    active.data.inbox = [];
    active.data.scopes = [];
    const socket = active.socket;
    delete active.socket;
    if (socket) {
      const timer = setTimeout(() => socket.close(), 5000);
      timer.unref?.();
      void socket
        .logout()
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(timer);
          socket.close();
        });
    }
    try {
      this.options.vault.delete(active.data.businessId);
      this.removeIndex(active.data.businessId);
    } finally {
      this.transition(active, "REVOKED");
    }
  }
  private authorizeActive(active: Active): void {
    try {
      this.options.authorize(active.data.businessId, active.data.ownerId);
    } catch (error) {
      this.erase(active);
      throw error;
    }
  }
  private load(businessId: string, ownerId: string): Active | undefined {
    let active = this.active.get(businessId);
    if (
      active &&
      this.options.sharedVolume &&
      !active.opening &&
      !this.leased(active) &&
      !this.options.vault.has(businessId)
    ) {
      // The holder erased it from the shared volume: this standby's copy is gone too.
      clearTimeout(active.timer);
      this.active.delete(businessId);
      delete this.index[businessId];
      active = undefined;
    }
    if (!active) {
      const raw = this.options.vault.read(businessId);
      if (!raw) return undefined;
      const data = JSON.parse(raw) as RecordData;
      data.inbox ??= [];
      if (data.businessId !== businessId) throw new Error("Session tenant mismatch.");
      active = {
        data,
        state: "DISCONNECTED",
        attempts: 0,
        opening: false
      };
      this.active.set(businessId, active);
    }
    if (active.data.ownerId !== ownerId) {
      this.options.authorize(businessId, ownerId);
      this.erase(active);
      return undefined;
    }
    return active;
  }
  status(businessId: string, ownerId: string) {
    this.options.authorize(businessId, ownerId);
    const active = this.load(businessId, ownerId);
    if (active?.state === "PAIRING" && (active.expiresAt ?? 0) <= this.now()) this.expire(active);
    return {
      enabled: this.enabled,
      state: active?.state ?? "DISCONNECTED",
      pairingCode: active?.code ?? null,
      expiresAt: active?.expiresAt ? new Date(active.expiresAt).toISOString() : null,
      scopes:
        active?.data.scopes.map(({ chat, conversationId, automation }) => ({
          chat,
          conversationId,
          automation: automation === true
        })) ?? [],
      automationAvailable: this.options.respond !== undefined,
      mode: "node" as const
    };
  }
  async connect(businessId: string, ownerId: string, phone?: string): Promise<void> {
    this.options.authorize(businessId, ownerId);
    if (!this.enabled)
      throw new ChannelGatewayError("CHANNEL_UNAVAILABLE", "WhatsApp connections are disabled.");
    let active = this.load(businessId, ownerId);
    if (
      !active &&
      (this.options.sharedVolume ? this.runningCount() : Object.keys(this.index).length) >=
        HOST_SESSION_LIMIT
    )
      throw new ChannelGatewayError(
        "CHANNEL_UNAVAILABLE",
        "This host has reached its eight-account WhatsApp limit."
      );
    if (active && LIVE_STATES.has(active.state)) return;
    if ((!active || !active.data.auth) && (!phone || !/^[1-9][0-9]{6,14}$/.test(phone)))
      throw new Error("Enter the WhatsApp number with country code, using digits only.");
    // Single-process mode stays synchronous up to open(): concurrent connects coalesce there.
    const lease = this.options.lease ? await this.claim(businessId) : undefined;
    try {
      if (lease !== undefined) {
        // State may have moved while the lease query ran; re-read it under the lease.
        if (!this.enabled)
          throw new ChannelGatewayError(
            "CHANNEL_UNAVAILABLE",
            "WhatsApp connections are disabled."
          );
        active = this.load(businessId, ownerId);
        if (active && LIVE_STATES.has(active.state)) {
          this.releaseUnused(businessId, lease);
          return;
        }
        if (active && !this.refresh(active)) {
          this.active.delete(businessId);
          active = undefined;
        }
      }
      if (!active || !active.data.auth) {
        if (!phone || !/^[1-9][0-9]{6,14}$/.test(phone))
          throw new Error("Enter the WhatsApp number with country code, using digits only.");
        const sameAccount = active?.data.phone === phone;
        active = {
          data: {
            businessId,
            ownerId,
            phone,
            generation: randomUUID(),
            auth: null,
            scopes: sameAccount ? (active?.data.scopes ?? []) : [],
            sent: sameAccount ? (active?.data.sent ?? {}) : {},
            inbox: sameAccount ? (active?.data.inbox ?? []) : [],
            admissions: sameAccount ? (active?.data.admissions ?? {}) : {}
          },
          state: "DISCONNECTED",
          attempts: 0,
          opening: false,
          ...(lease !== undefined ? { lease } : {})
        };
        this.active.set(businessId, active);
        this.persist(active);
        this.addIndex(businessId, ownerId);
      }
      if (lease !== undefined) active.lease = lease;
    } catch (error) {
      if (lease !== undefined) this.releaseUnused(businessId, lease);
      throw error;
    }
    try {
      await this.open(active, phone);
    } catch (error) {
      // Never keep heartbeating a lease for a business with no socket and no retry.
      if (!LIVE_STATES.has(active.state)) this.releaseLease(active);
      throw error;
    }
  }
  private current(active: Active) {
    return this.enabled && this.active.get(active.data.businessId) === active;
  }
  /** True in single-process mode; otherwise only while the socket's lease generation is held. */
  private leased(active: Active): boolean {
    const lease = this.options.lease;
    return (
      !lease || (active.lease !== undefined && lease.holds(active.data.businessId, active.lease))
    );
  }
  /** Acquires the business's lease; undefined in single-process mode. */
  private async claim(businessId: string): Promise<string | undefined> {
    const lease = this.options.lease;
    if (!lease) return undefined;
    // A shared volume lets every worker restore every session; the per-host limit keeps one
    // worker from taking all of them. The others stay standbys until a worker has room.
    if (this.options.sharedVolume && this.runningCount() >= HOST_SESSION_LIMIT)
      throw new LinkedLeaseUnavailable();
    let generation: string | null;
    try {
      generation = await lease.acquire(businessId);
    } catch {
      generation = null; // Lease store unreachable: fail closed, never run unfenced.
    }
    if (!generation) throw new LinkedLeaseUnavailable();
    return generation;
  }
  /** Hands back a claimed generation unless some session of this business runs under it. */
  private releaseUnused(businessId: string, generation: string): void {
    if (this.active.get(businessId)?.lease === generation) return;
    void this.options.lease?.release(businessId, generation).catch(() => undefined);
  }
  private releaseLease(active: Active): void {
    const generation = active.lease;
    if (generation === undefined || !this.options.lease) return;
    delete active.lease;
    void this.options.lease.release(active.data.businessId, generation).catch(() => undefined);
  }
  /**
   * The socket must run on a remote worker that is not attached here. Hand the lease back and
   * retry later (or on `wake`); an unfinished pairing ends instead, the owner restarts it.
   */
  private park(active: Active): void {
    clearTimeout(active.timer);
    if (!active.data.auth) {
      this.transition(active, "AUTH_REQUIRED");
      return;
    }
    this.transition(active, "SUSPENDED");
    active.timer = setTimeout(() => {
      void this.open(active).catch(() => this.transition(active, "ERROR"));
    }, this.options.lease?.retryMs ?? 10_000);
    active.timer.unref?.();
  }
  /** Wait without a socket and retry acquisition: the failover path for restorable sessions. */
  private standby(active: Active): void {
    const lease = this.options.lease;
    if (!lease || !this.current(active)) return;
    clearTimeout(active.timer);
    if (active.state !== "SUSPENDED") this.transition(active, "SUSPENDED");
    if (!active.data.auth) return;
    active.timer = setTimeout(() => {
      void this.open(active).catch(() => this.transition(active, "ERROR"));
    }, lease.retryMs);
    active.timer.unref?.();
  }
  /** Fence everything the lost generation started: socket, media fetch, drain, timers. */
  private leaseLost(businessId: string, generation: string): void {
    const active = this.active.get(businessId);
    if (!active || active.lease !== generation) return;
    delete active.lease;
    active.paused = false;
    active.mediaFetch?.controller.abort();
    clearTimeout(active.timer);
    active.data.generation = randomUUID();
    const socket = active.socket;
    delete active.socket;
    socket?.close();
    if (!active.data.auth) {
      // An unfinished pairing must not become restorable; the owner restarts it.
      this.transition(active, "AUTH_REQUIRED");
      return;
    }
    this.standby(active);
  }
  private async open(active: Active, phone?: string): Promise<void> {
    if (!this.current(active) || active.opening) return;
    this.options.authorize(active.data.businessId, active.data.ownerId);
    active.opening = true;
    clearTimeout(active.timer);
    if (!this.leased(active)) {
      // Reconnect or standby retry: (re)acquire before any socket exists.
      let generation: string | undefined;
      try {
        generation = await this.claim(active.data.businessId);
      } catch {
        generation = undefined;
      }
      active.opening = false;
      if (!this.current(active)) {
        if (generation) this.releaseUnused(active.data.businessId, generation);
        return;
      }
      if (!generation) return this.standby(active);
      active.lease = generation;
      let present: boolean;
      try {
        present = this.refresh(active);
      } catch (error) {
        this.transition(active, "ERROR");
        throw error;
      }
      if (!present) {
        // Disconnected elsewhere while this worker waited: nothing left to restore.
        this.active.delete(active.data.businessId);
        this.releaseLease(active);
        this.transition(active, "DISCONNECTED");
        return;
      }
      active.opening = true;
    }
    this.transition(active, active.attempts ? "RECONNECTING" : "CONNECTING");
    // Socket epoch fences late events from the socket replaced during a reconnect. In
    // multi-worker mode it is prefixed by the lease generation and also requires the lease.
    const leaseGeneration = active.lease;
    const epoch = leaseGeneration ? `${leaseGeneration}:${randomUUID()}` : randomUUID();
    let live = true;
    // A new socket ends any backpressure pause: its socket epoch is gone.
    active.paused = false;
    active.resumeDue = false;
    const valid = () =>
      live && this.current(active) && active.data.generation === epoch && this.leased(active);
    active.data.generation = epoch;
    try {
      const socket = await this.options.driver.open({
        businessId: active.data.businessId,
        auth: active.data.auth,
        ...(active.data.phone ? { expectedPhone: active.data.phone } : {}),
        approvedContacts: () => active.data.scopes.map((scope) => scope.chat),
        save: (auth) => {
          if (valid()) {
            active.data.auth = auth;
            try {
              this.persist(active);
              if (active.state === "PAIRING") {
                // The driver persists registered credentials only after WhatsApp approves.
                // Do not expire that approval while its required socket restart completes.
                clearTimeout(active.timer);
                this.transition(active, "CONNECTING");
              }
            } catch {
              live = false;
              active.socket?.close();
              this.transition(active, "ERROR");
            }
          }
        },
        state: (state, reason) => {
          // A socket closed for backpressure reports nothing more; the pause owns the reconnect.
          if (!valid() || active.paused) return;
          try {
            if (state === "open") {
              active.attempts = 0;
              clearTimeout(active.timer);
              this.transition(active, "CONNECTED");
              this.persist(active);
              void this.drain(active);
            } else {
              live = false;
              active.mediaFetch?.controller.abort();
              clearTimeout(active.timer);
              active.socket?.close();
              delete active.socket;
              if (reason === "revoked" || reason === "auth") {
                active.data.auth = null;
                this.persist(active);
                this.transition(active, reason === "revoked" ? "REVOKED" : "AUTH_REQUIRED");
              } else if (!active.data.auth || ++active.attempts > 8) {
                this.transition(active, active.data.auth ? "ERROR" : "AUTH_REQUIRED");
              } else {
                this.transition(active, "RECONNECTING");
                active.timer = setTimeout(
                  () => {
                    void this.open(active).catch(() => this.transition(active, "ERROR"));
                  },
                  reason === "restart"
                    ? 100
                    : Math.min(60_000, 1000 * 2 ** active.attempts) +
                        Math.floor(Math.random() * 500)
                );
                active.timer.unref?.();
              }
            }
          } catch {
            // EventEmitter callbacks must fail closed without an uncaught process exception.
            live = false;
            clearTimeout(active.timer);
            active.socket?.close();
            delete active.socket;
            active.state = "ERROR";
            delete active.code;
            delete active.expiresAt;
            this.releaseLease(active);
          }
        },
        inbound: (message) => {
          if (
            !valid() ||
            // A socket paused for backpressure may still hand over events it already took from
            // WhatsApp; they are journaled, never dropped.
            (active.state !== "CONNECTED" && !active.paused) ||
            (message.fromMe && !message.mutation) ||
            !validLinkedChat(message.chat) ||
            message.text.length === 0 ||
            message.text.length > 4000 ||
            (message.media?.length ?? 0) > 1
          )
            return;
          if (!active.data.scopes.some((scope) => scope.chat === message.chat)) return;
          const key = this.inboundKey(message);
          if (active.data.inbox.some((queued) => this.inboundKey(queued) === key)) return;
          try {
            if (
              this.options.alreadyReceived?.(active.data.businessId, active.data.ownerId, message)
            )
              return;
          } catch {
            this.transition(active, "ERROR");
            active.socket?.close();
            return;
          }
          if (active.data.inbox.length >= linkedInboxLimits.hardLimit) {
            // Unreachable with a driver that stops delivering after close(); reported if not.
            this.options.notice?.({
              businessId: active.data.businessId,
              type: "inbound_refused",
              queued: active.data.inbox.length
            });
            return;
          }
          const scope = active.data.scopes.find((entry) => entry.chat === message.chat)!;
          if (!message.mutation && linkedOptOutCommand(message.text) === "stop") {
            scope.automation = false;
            scope.grantId = randomUUID();
          }
          message = {
            ...message,
            automationGrant: scope.automation ? (scope.grantId ?? null) : null
          };
          active.data.inbox.push(message);
          try {
            this.persist(active);
          } catch {
            active.data.inbox.pop();
            this.transition(active, "ERROR");
            active.socket?.close();
            return;
          }
          if (!active.paused && active.data.inbox.length >= linkedInboxLimits.pauseAt)
            this.pauseIntake(active);
          void this.drain(active);
        }
      });
      if (!valid()) {
        socket.close();
        return;
      }
      active.socket = socket;
      if (phone && !active.data.auth) {
        this.transition(active, "PAIRING");
        active.expiresAt = this.now() + 120_000;
        active.timer = setTimeout(() => this.expire(active), 120_000);
        active.timer.unref?.();
        const code = await socket.pairingCode(phone);
        if (valid() && active.state === "PAIRING") active.code = code;
      }
    } catch (error) {
      if (valid() && error instanceof LinkedWorkerOffline && !active.socket) {
        live = false;
        active.data.generation = randomUUID();
        this.park(active);
        // Background reconnects wait quietly; an owner's pairing attempt learns why it failed.
        if (phone !== undefined && !active.data.auth) throw error;
        return;
      }
      if (valid()) {
        live = false;
        active.socket?.close();
        this.transition(active, "ERROR");
      }
      throw error;
    } finally {
      active.opening = false;
    }
  }
  private shouldAutomate(active: Active, message: LinkedInbound): boolean {
    const scope = active.data.scopes.find((entry) => entry.chat === message.chat);
    if (
      message.mutation ||
      !scope?.automation ||
      !scope.grantId ||
      message.automationGrant !== scope.grantId ||
      linkedOptOutCommand(message.text) !== null
    )
      return false;
    if (!message.chat.endsWith("@g.us")) return true;
    return (
      message.mentioned ||
      /^\/?grogoni(?:[,:\s]|$)/i.test(message.text.trim()) ||
      Boolean(
        message.replyTo &&
        Object.values(active.data.sent).some(
          (delivery) =>
            delivery.status === "sent" &&
            delivery.automated === true &&
            delivery.id === message.replyTo
        )
      )
    );
  }
  private inboundKey(message: LinkedInbound): string {
    return JSON.stringify([message.chat, message.sender, message.id]);
  }
  /**
   * Inbound backpressure. Closing the socket stops intake (WhatsApp keeps later messages for this
   * linked device and delivers them on reconnect); the journal keeps draining without it. Items
   * that need the socket (a media download or an automatic reply) wait for the reconnect. An
   * in-flight download is left to finish: it does not need the closed socket.
   */
  private pauseIntake(active: Active): void {
    active.paused = true;
    active.resumeDue = false;
    active.pauses = (active.pauses ?? 0) + 1;
    const socket = active.socket;
    delete active.socket;
    socket?.close();
    clearTimeout(active.timer);
    this.transition(active, "RECONNECTING");
    this.options.notice?.({
      businessId: active.data.businessId,
      type: "intake_paused",
      queued: active.data.inbox.length
    });
    active.timer = setTimeout(
      () => {
        active.resumeDue = true;
        this.maybeResume(active);
      },
      Math.min(60_000, 1000 * 2 ** active.pauses)
    );
    active.timer.unref?.();
  }
  /** Reconnect a paused session once its backoff elapsed and the drain needs the socket. */
  private maybeResume(active: Active): void {
    if (!active.paused || !active.resumeDue || active.draining || !this.current(active)) return;
    const head = active.data.inbox[0];
    if (
      head &&
      active.data.inbox.length > linkedInboxLimits.resumeAt &&
      !this.needsSocket(active, head)
    )
      return; // Still draining without the socket; the drain calls back when it stops.
    active.paused = false;
    active.resumeDue = false;
    void this.open(active).catch(() => this.transition(active, "ERROR"));
  }
  private needsSocket(active: Active, message: LinkedInbound): boolean {
    return Boolean(message.media?.length) || this.shouldAutomate(active, message);
  }
  /** The drain may keep working: same socket epoch, lease held, connected or paused. */
  private drainable(active: Active, epoch: string): boolean {
    return (
      this.current(active) &&
      this.leased(active) &&
      active.data.generation === epoch &&
      (active.state === "CONNECTED" || active.paused === true)
    );
  }
  /**
   * Downloads one attachment with bounded retries. Any failure other than the connection going
   * away ends as `failed` after the last attempt, so one bad attachment can never hold the
   * journal's head: the message is stored with a placeholder instead. `interrupted` (socket
   * closed or paused, lease lost, scope removed, shutdown) leaves the event journaled for replay.
   */
  private async downloadAttachment(
    active: Active,
    message: LinkedInbound,
    attachment: LinkedMedia,
    epoch: string
  ): Promise<LinkedDownloadedMedia | "rejected" | "failed" | "interrupted"> {
    const policy = { ...MEDIA_DEFAULTS, ...this.options.media };
    const inScope = () => active.data.scopes.some((scope) => scope.chat === message.chat);
    for (let attempt = 1; ; attempt++) {
      const socket = active.socket;
      // Connected without a socket is a broken session, not a bad attachment: reconnect.
      if (!socket && !active.paused && this.drainable(active, epoch) && inScope())
        throw new Error("Media download is unavailable.");
      if (!socket || !this.drainable(active, epoch) || !inScope()) return "interrupted";
      if (!socket.downloadMedia) return "failed";
      const controller = new AbortController();
      active.mediaFetch = { chat: message.chat, controller };
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Raced rather than trusted: a driver that ignores the abort signal still times out.
        const bytes = await Promise.race([
          socket.downloadMedia(
            attachment,
            AbortSignal.any([this.shutdown.signal, controller.signal])
          ),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              controller.abort();
              reject(new Error("Media download timed out."));
            }, policy.timeoutMs);
            timer.unref?.();
          })
        ]);
        return validateLinkedMedia(attachment, bytes);
      } catch (error) {
        if (error instanceof LinkedMediaRejected) return "rejected";
        if (
          this.shutdown.signal.aborted ||
          (controller.signal.aborted && !timedOut) ||
          !inScope() ||
          !this.drainable(active, epoch) ||
          active.paused
        )
          return "interrupted";
        if (attempt >= policy.attempts) return "failed";
      } finally {
        clearTimeout(timer);
        if (active.mediaFetch?.controller === controller) delete active.mediaFetch;
      }
      await delay(policy.retryDelayMs * attempt, this.shutdown.signal);
    }
  }
  /** Acknowledge the private journal only after canonical persistence crosses its barrier. */
  private async drain(active: Active): Promise<void> {
    if (active.draining) return;
    active.draining = true;
    const epoch = active.data.generation;
    try {
      while (this.drainable(active, epoch) && active.data.inbox.length) {
        const message = active.data.inbox[0]!;
        this.authorizeActive(active);
        if (active.data.scopes.some((scope) => scope.chat === message.chat)) {
          // Paused: what needs the socket waits for the reconnect, still journaled.
          if (active.paused && !active.socket && this.needsSocket(active, message)) return;
          let received = message;
          let media: LinkedDownloadedMedia[] | undefined;
          if (message.media?.length) {
            media = [];
            let unavailable: "rejected" | "failed" | undefined;
            for (const attachment of message.media) {
              const outcome = await this.downloadAttachment(active, message, attachment, epoch);
              if (outcome === "interrupted") break;
              if (outcome === "rejected" || outcome === "failed") unavailable = outcome;
              else media.push(outcome);
            }
            if (!this.current(active) || active.data.generation !== epoch) return;
            if (!active.data.scopes.some((scope) => scope.chat === message.chat)) continue;
            if (media.length + (unavailable ? 1 : 0) < message.media.length) return;
            if (unavailable) {
              media = [];
              received = {
                ...message,
                media: [],
                text: `${message.text}\n${
                  unavailable === "rejected" ? linkedMediaRejectedText : linkedMediaUnavailableText
                }`.slice(0, 4000)
              };
              this.options.notice?.({
                businessId: active.data.businessId,
                type: unavailable === "rejected" ? "media_rejected" : "media_unavailable",
                queued: active.data.inbox.length
              });
            }
          }
          // A lost lease leaves the event journaled (unacknowledged) for the next tenure.
          if (!this.leased(active) || active.data.generation !== epoch) return;
          const outcome = media
            ? await this.options.receive(
                active.data.businessId,
                active.data.ownerId,
                active.data.generation,
                received,
                media
              )
            : await this.options.receive(
                active.data.businessId,
                active.data.ownerId,
                active.data.generation,
                message
              );
          if (
            outcome !== "throttled" &&
            this.shouldAutomate(active, message) &&
            this.options.respond &&
            this.options.deliver
          ) {
            // Paused while this message was stored: reply after the reconnect (receive is
            // idempotent, so the replay stores nothing twice).
            if (active.paused && !active.socket) return;
            const scope = active.data.scopes.find((entry) => entry.chat === message.chat)!;
            const key =
              "whatsapp-reply:" +
              createHash("sha256").update(this.inboundKey(message)).digest("hex");
            const admitted = this.admit(active, key);
            if (admitted && this.leased(active)) {
              let delivered = false;
              try {
                const response = await this.options.respond(
                  active.data.businessId,
                  active.data.ownerId,
                  message,
                  scope.conversationId,
                  this.shutdown.signal
                );
                if (
                  response &&
                  this.current(active) &&
                  this.leased(active) &&
                  active.state === "CONNECTED" &&
                  this.shouldAutomate(active, message)
                ) {
                  await this.options.deliver(
                    active.data.businessId,
                    active.data.ownerId,
                    message,
                    response,
                    key
                  );
                  delivered = true;
                }
              } finally {
                // A reply that never reached the gateway gives its budget slot back. One that did
                // is counted by its canonical message, so releasing the reservation is harmless.
                if (!delivered) this.options.releaseAdmission?.(active.data.businessId, key);
              }
            }
          }
        }
        if (!this.current(active)) return;
        const index = active.data.inbox.findIndex(
          (entry) => this.inboundKey(entry) === this.inboundKey(message)
        );
        if (index >= 0) {
          active.data.inbox.splice(index, 1);
          try {
            this.persist(active);
            active.ingressFailures = 0;
          } catch (error) {
            active.data.inbox.splice(index, 0, message);
            throw error;
          }
        }
        if (!active.data.inbox.length && active.state === "CONNECTED") active.pauses = 0;
      }
    } catch {
      if (this.current(active) && active.data.generation === epoch) {
        active.paused = false;
        active.resumeDue = false;
        active.socket?.close();
        delete active.socket;
        const failures = (active.ingressFailures = (active.ingressFailures ?? 0) + 1);
        this.transition(active, failures > 8 ? "ERROR" : "RECONNECTING");
        clearTimeout(active.timer);
        if (failures <= 8) {
          active.timer = setTimeout(
            () => void this.open(active).catch(() => this.transition(active, "ERROR")),
            Math.min(60_000, 1000 * 2 ** failures)
          );
          active.timer.unref?.();
        }
      }
    } finally {
      active.draining = false;
      if (this.drainable(active, epoch) && active.data.inbox.length) {
        const head = active.data.inbox[0]!;
        if (!active.paused || active.socket || !this.needsSocket(active, head))
          setImmediate(() => void this.drain(active));
      }
      this.maybeResume(active);
    }
  }
  /**
   * One automatic reply per inbound message, at most 60 per business per rolling hour. With
   * `admit` the budget is the store's, shared with delegated results; a replayed message reuses
   * its own admission in both modes.
   */
  private admit(active: Active, key: string): boolean {
    if (this.options.admit) return this.options.admit(active.data.businessId, key);
    const admissions = (active.data.admissions ??= {});
    if (admissions[key]) return true;
    const cutoff = this.now() - 3_600_000;
    if (Object.values(admissions).filter((time) => time >= cutoff).length >= 60) return false;
    for (const [id, time] of Object.entries(admissions)) if (time < cutoff) delete admissions[id];
    admissions[key] = this.now();
    this.persist(active);
    return true;
  }
  private expire(active: Active) {
    clearTimeout(active.timer);
    active.data.generation = randomUUID();
    active.socket?.close();
    delete active.socket;
    // A timed-out handshake must not become a restorable authorized session.
    active.data.auth = null;
    try {
      this.persist(active);
    } catch {
      // Timer context: never throw. A pairing record holds no auth until WhatsApp approves.
    }
    this.transition(active, "AUTH_REQUIRED");
  }
  approve(
    businessId: string,
    ownerId: string,
    chat: string,
    conversationId: string,
    automation = false
  ) {
    if (automation && !this.options.respond)
      throw new Error("Assistant replies are unavailable on this host.");
    if (!validLinkedChat(chat)) throw new Error("Invalid WhatsApp conversation identifier.");
    const active = this.load(businessId, ownerId);
    if (!active || active.state !== "CONNECTED") throw new Error("Connect WhatsApp first.");
    if (
      active.data.scopes.length >= 100 &&
      !active.data.scopes.some((scope) => scope.chat === chat)
    )
      throw new Error("Connection scope limit reached.");
    active.data.scopes = active.data.scopes
      .filter((scope) => scope.chat !== chat)
      .concat({ chat, conversationId, automation, grantId: randomUUID() });
    this.persist(active);
  }
  revoke(businessId: string, ownerId: string, chat: string) {
    const active = this.load(businessId, ownerId);
    if (!active) return;
    if (active.mediaFetch?.chat === chat) active.mediaFetch.controller.abort();
    active.data.scopes = active.data.scopes.filter((scope) => scope.chat !== chat);
    active.data.inbox = active.data.inbox.filter((message) => message.chat !== chat);
    this.persist(active);
  }
  async groups(businessId: string, ownerId: string) {
    this.options.authorize(businessId, ownerId);
    const active = this.load(businessId, ownerId);
    if (!active?.socket?.groups || active.state !== "CONNECTED")
      throw new ChannelGatewayError(
        "CHANNEL_UNAVAILABLE",
        "Connect WhatsApp before choosing a group."
      );
    const groups = await active.socket.groups();
    this.authorizeActive(active);
    if (!this.current(active) || !this.leased(active) || active.state !== "CONNECTED")
      throw new ChannelGatewayError(
        "CHANNEL_UNAVAILABLE",
        "Connection changed while loading groups."
      );
    return groups
      .filter((group) => validLinkedChat(group.chat) && group.chat.endsWith("@g.us"))
      .slice(0, 100);
  }
  /**
   * Read receipts (read-receipts.ts): only for a chat approved on this host's connected session,
   * for this owner, while this worker holds the lease.
   */
  readReceiptApproved(businessId: string, ownerId: string, chat: string): boolean {
    try {
      this.options.authorize(businessId, ownerId);
    } catch {
      return false;
    }
    const active = this.load(businessId, ownerId);
    return (
      active !== undefined &&
      active.state === "CONNECTED" &&
      this.current(active) &&
      this.leased(active) &&
      active.data.scopes.some((scope) => scope.chat === chat)
    );
  }

  /**
   * What the delivery journal knows about one idempotency key: never handed to WhatsApp
   * (`none`), handed over without a confirmed answer (`pending`, an uncertain delivery), or
   * `sent`. Read-only; the Android sidecar uses it to report outcomes to the device outbox
   * without matching error text.
   */
  deliveryState(
    businessId: string,
    ownerId: string,
    idempotencyKey: string
  ): "none" | "pending" | "sent" {
    const active = this.load(businessId, ownerId);
    if (!active) return "none";
    const key = createHash("sha256").update(idempotencyKey).digest("hex");
    return active.data.sent[key]?.status ?? "none";
  }

  /** Sends read receipts on the live socket. Returns how many keys were sent; 0 when not allowed. */
  async markRead(
    businessId: string,
    ownerId: string,
    chat: string,
    keys: LinkedReadReceiptKey[]
  ): Promise<number> {
    if (!this.readReceiptApproved(businessId, ownerId, chat)) return 0;
    const active = this.load(businessId, ownerId)!;
    const socket = active.socket as Partial<LinkedReadReceiptSocket> | undefined;
    if (!socket?.markRead) return 0;
    if (this.options.lease) {
      // An external effect, like a send: confirm the generation against the database first.
      const generation = active.lease!;
      const held = await this.options.lease.verify(active.data.businessId, generation);
      if (!held || active.lease !== generation || active.socket !== socket) return 0;
    }
    if (!this.readReceiptApproved(businessId, ownerId, chat) || active.socket !== socket) return 0;
    return socket.markRead(chat, keys);
  }

  async disconnect(businessId: string, ownerId: string) {
    let active = this.load(businessId, ownerId);
    if (!active) return;
    if (this.options.lease && !this.leased(active)) {
      // Nobody may erase a record another worker is running: take the lease first. When another
      // worker holds it, this throws LinkedLeaseUnavailable and the request goes to that worker.
      const generation = (await this.claim(businessId))!;
      const current = this.active.get(businessId);
      if (current && this.leased(current)) {
        this.releaseUnused(businessId, generation);
        active = current;
      } else {
        active = current ?? active;
        this.active.set(businessId, active);
        active.lease = generation;
        let present: boolean;
        try {
          present = this.refresh(active);
        } catch (error) {
          this.releaseLease(active);
          throw error;
        }
        if (!present) {
          // Already disconnected by its previous holder.
          this.active.delete(businessId);
          this.releaseLease(active);
          return;
        }
      }
    }
    this.active.delete(businessId);
    active.mediaFetch?.controller.abort();
    clearTimeout(active.timer);
    active.data.generation = randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        active.socket?.logout(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Logout timed out.")), 5000);
        })
      ]);
    } catch {
      /* Local credential erasure must succeed even when the provider is offline. */
    } finally {
      clearTimeout(timer);
      active.socket?.close();
      this.options.vault.delete(businessId);
      this.removeIndex(businessId);
      // DISCONNECTED hands the lease back so another worker is never blocked for a full TTL.
      this.transition(active, "DISCONNECTED");
    }
  }
  async stop() {
    this.enabled = false;
    this.shutdown.abort();
    clearInterval(this.authorizationTimer);
    clearInterval(this.rescanTimer);
    for (const active of this.active.values()) {
      active.paused = false;
      active.mediaFetch?.controller.abort();
      clearTimeout(active.timer);
      active.data.generation = randomUUID();
      active.socket?.close();
      this.transition(active, "SUSPENDED");
    }
    this.unsubscribeLease?.();
    await this.options.lease?.stop();
  }
  readiness(context?: { businessId?: string }): ChannelProviderReadiness {
    const active = context?.businessId ? this.active.get(context.businessId) : undefined;
    const connected = this.enabled && active?.state === "CONNECTED" && this.leased(active);
    return {
      provider: this.provider,
      capabilities,
      configured: this.enabled,
      authorized: connected,
      status: connected ? "available" : "unavailable",
      configurationRequirement: connected ? null : "Connect WhatsApp and approve conversations."
    };
  }
  getCapabilities() {
    return [...capabilities];
  }
  async sendMessage(request: OutboundChannelMessage): Promise<ChannelSendResult> {
    const active = this.active.get(request.businessId);
    if (active) this.authorizeActive(active);
    if (
      !this.enabled ||
      !active?.socket ||
      active.state !== "CONNECTED" ||
      !this.leased(active) ||
      request.endpoint.provider !== this.provider ||
      request.endpoint.businessId !== request.businessId ||
      !active.data.scopes.some(
        (scope) =>
          scope.chat === request.endpoint.externalConversationId &&
          scope.conversationId === request.conversationId
      )
    )
      throw new ChannelGatewayError(
        "CHANNEL_UNAVAILABLE",
        "This WhatsApp conversation is not authorized."
      );
    if (
      !request.text.trim() ||
      request.text.length > 4000 ||
      (request.attachments?.length ?? 0) > 1
    )
      throw new ChannelGatewayError(
        "CHANNEL_SEND_FAILED",
        "Messages support up to 4,000 characters and one supported attachment."
      );
    const attachment = request.attachments?.[0];
    let media: LinkedDownloadedMedia | undefined;
    if (attachment) {
      try {
        if (attachment.contentBase64.length > 7 * 1024 * 1024)
          throw new Error("Attachment exceeds the supported limit.");
        const bytes = Buffer.from(attachment.contentBase64, "base64");
        media = validateLinkedMedia(
          {
            type: attachment.mimeType.startsWith("image/")
              ? "image"
              : attachment.mimeType.startsWith("audio/")
                ? "audio"
                : "document",
            mimeType: attachment.mimeType,
            filename: attachment.filename,
            size: bytes.length,
            directPath: "",
            key: "",
            sha256: createHash("sha256").update(bytes).digest("base64")
          },
          bytes
        );
      } catch {
        throw new ChannelGatewayError(
          "CHANNEL_SEND_FAILED",
          "The attachment is unsupported or exceeds the supported limit."
        );
      }
    }
    let socket = active.socket;
    if (this.options.lease) {
      // An irreversible external effect: confirm the generation against the database first.
      // Everything below until socket.send is synchronous, so the idempotency journal stays atomic.
      const generation = active.lease!;
      const held = await this.options.lease.verify(active.data.businessId, generation);
      if (
        !held ||
        !this.current(active) ||
        active.lease !== generation ||
        !this.leased(active) ||
        active.state !== "CONNECTED" ||
        !active.socket
      )
        throw new ChannelGatewayError(
          "CHANNEL_UNAVAILABLE",
          "This WhatsApp connection moved to another worker; nothing was sent.",
          true
        );
      socket = active.socket;
    }
    const key = createHash("sha256").update(request.idempotencyKey).digest("hex");
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          request.conversationId,
          request.endpoint.externalConversationId,
          request.text,
          request.quotedMessage ?? null,
          media
            ? [
                media.filename,
                media.mimeType,
                createHash("sha256").update(media.bytes).digest("hex")
              ]
            : null
        ])
      )
      .digest("hex");
    const existing = active.data.sent[key];
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new ChannelGatewayError(
          "CHANNEL_SEND_FAILED",
          "The delivery key was already used for another message."
        );
      if (existing.status === "pending")
        throw new ChannelGatewayError(
          "CHANNEL_SEND_FAILED",
          "Delivery is uncertain; check WhatsApp before sending again."
        );
      return { accepted: true, providerMessageId: existing.id, status: "sent" };
    }
    // Settled keys age out (pruneLinkedSentJournal); an uncertain one is never evicted, because
    // forgetting it could resend. Only a backlog of uncertain deliveries can refuse a send.
    pruneLinkedSentJournal(active.data.sent, this.now());
    if (
      Object.values(active.data.sent).filter((entry) => entry.status === "pending").length >=
      linkedSentJournalLimits.pendingMax
    )
      throw new ChannelGatewayError(
        "CHANNEL_SEND_FAILED",
        "Too many WhatsApp deliveries are uncertain. Check WhatsApp, then reconnect this account."
      );
    const id = createHash("sha256")
      .update(`${active.data.businessId}:${key}`)
      .digest("hex")
      .slice(0, 32)
      .toUpperCase();
    active.data.sent[key] = {
      fingerprint,
      id,
      status: "pending",
      automated: request.idempotencyKey.startsWith("whatsapp-reply:"),
      at: this.now()
    };
    this.persist(active);
    const deliveredId = await socket.send(
      request.endpoint.externalConversationId,
      request.text,
      id,
      media,
      request.quotedMessage
    );
    if (!this.current(active))
      throw new ChannelGatewayError("CHANNEL_SEND_FAILED", "Connection changed during delivery.");
    active.data.sent[key] = {
      fingerprint,
      id: deliveredId,
      status: "sent",
      automated: request.idempotencyKey.startsWith("whatsapp-reply:"),
      at: this.now()
    };
    this.persist(active);
    return { accepted: true, providerMessageId: deliveredId, status: "sent" };
  }
}

/**
 * Bounds the delivery journal in place. Settled (`sent`) entries older than the retention window
 * go first; if more than `settledMax` remain, the oldest settled ones go too. Pending entries are
 * uncertain deliveries and are never removed here: forgetting one could resend a message the
 * customer already has. Returns how many entries were removed.
 */
export function pruneLinkedSentJournal(sent: Record<string, LinkedSentEntry>, now: number): number {
  const cutoff = now - linkedSentJournalLimits.settledRetainMs;
  const settled: Array<[string, number]> = [];
  let removed = 0;
  for (const [key, entry] of Object.entries(sent)) {
    // Entries from before `at` existed start their retention now rather than living forever.
    if (typeof entry.at !== "number" || !Number.isFinite(entry.at)) entry.at = now;
    if (entry.status !== "sent") continue;
    if (entry.at < cutoff) {
      delete sent[key];
      removed++;
    } else settled.push([key, entry.at]);
  }
  if (settled.length > linkedSentJournalLimits.settledMax) {
    settled.sort((left, right) => left[1] - right[1]);
    for (const [key] of settled.slice(0, settled.length - linkedSentJournalLimits.settledMax)) {
      delete sent[key];
      removed++;
    }
  }
  return removed;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
