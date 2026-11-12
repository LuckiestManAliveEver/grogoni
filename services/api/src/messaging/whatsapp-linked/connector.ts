import { createHash, randomUUID } from "node:crypto";
import type { ChannelCapability, ChannelProviderReadiness } from "@grogoni/shared-types";
import type {
  MessagingChannelAdapter,
  OutboundChannelMessage,
  ChannelSendResult
} from "../channel-gateway.js";
import { ChannelGatewayError } from "../channel-errors.js";
import type { LinkedSessionVault } from "./vault.js";
import type { LinkedLeaseGuard } from "./lease.js";
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
  sent: Record<
    string,
    { fingerprint: string; id: string; status: "pending" | "sent"; automated?: boolean }
  >;
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
      receive: (
        businessId: string,
        ownerId: string,
        generation: string,
        message: LinkedInbound,
        media?: LinkedDownloadedMedia[]
      ) => Promise<void>;
      event?: (event: { businessId: string; ownerId: string; state: LinkedState }) => void;
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
    }
  ) {
    this.index = JSON.parse(options.vault.read("$index") ?? "{}");
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
  }
  async restore(): Promise<void> {
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
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private persist(active: Active) {
    // A worker that lost its lease must never overwrite its successor's record.
    if (!this.leased(active)) throw new Error("This worker no longer holds the WhatsApp session.");
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
      state
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
      delete this.index[active.data.businessId];
      this.options.vault.write("$index", JSON.stringify(this.index));
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
    if (!active && Object.keys(this.index).length >= 8)
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
        this.index[businessId] = ownerId;
        this.options.vault.write("$index", JSON.stringify(this.index));
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
    const valid = () =>
      live && this.current(active) && active.data.generation === epoch && this.leased(active);
    active.data.generation = epoch;
    try {
      const socket = await this.options.driver.open({
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
          if (!valid()) return;
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
            active.state !== "CONNECTED" ||
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
          if (active.data.inbox.length >= 64) {
            this.transition(active, "SUSPENDED");
            active.socket?.close();
            return;
          }
          const scope = active.data.scopes.find((entry) => entry.chat === message.chat)!;
          if (/^(?:stop|unsubscribe)$/i.test(message.text.trim())) {
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
      /^(?:stop|start|unsubscribe)$/i.test(message.text.trim())
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
  /** Acknowledge the private journal only after canonical persistence crosses its barrier. */
  private async drain(active: Active): Promise<void> {
    if (active.draining) return;
    active.draining = true;
    const epoch = active.data.generation;
    try {
      while (
        this.current(active) &&
        this.leased(active) &&
        active.state === "CONNECTED" &&
        active.data.inbox.length
      ) {
        const message = active.data.inbox[0]!;
        this.authorizeActive(active);
        if (active.data.scopes.some((scope) => scope.chat === message.chat)) {
          let received = message;
          const media: LinkedDownloadedMedia[] = [];
          if (message.media?.length) {
            const controller = new AbortController();
            active.mediaFetch = { chat: message.chat, controller };
            try {
              if (!active.socket?.downloadMedia) throw new Error("Media download is unavailable.");
              for (const attachment of message.media)
                media.push(
                  validateLinkedMedia(
                    attachment,
                    await active.socket.downloadMedia(
                      attachment,
                      AbortSignal.any([this.shutdown.signal, controller.signal])
                    )
                  )
                );
            } catch (error) {
              if (!active.data.scopes.some((scope) => scope.chat === message.chat)) continue;
              if (!(error instanceof LinkedMediaRejected)) throw error;
              received = {
                ...message,
                media: [],
                text: `${message.text}\n[Attachment rejected: unsupported or invalid media.]`.slice(
                  0,
                  4000
                )
              };
            } finally {
              delete active.mediaFetch;
            }
            if (!this.current(active) || active.data.generation !== epoch) return;
            if (!active.data.scopes.some((scope) => scope.chat === message.chat)) continue;
          }
          // A lost lease leaves the event journaled (unacknowledged) for the next tenure.
          if (!this.leased(active) || active.data.generation !== epoch) return;
          if (message.media?.length)
            await this.options.receive(
              active.data.businessId,
              active.data.ownerId,
              active.data.generation,
              received,
              media
            );
          else
            await this.options.receive(
              active.data.businessId,
              active.data.ownerId,
              active.data.generation,
              message
            );
          if (
            this.shouldAutomate(active, message) &&
            this.options.respond &&
            this.options.deliver
          ) {
            const scope = active.data.scopes.find((entry) => entry.chat === message.chat)!;
            const key =
              "whatsapp-reply:" +
              createHash("sha256").update(this.inboundKey(message)).digest("hex");
            const admissions = (active.data.admissions ??= {});
            let admitted = Boolean(admissions[key]);
            if (!admitted) {
              const cutoff = this.now() - 3_600_000;
              if (Object.values(admissions).filter((time) => time >= cutoff).length < 60) {
                for (const [id, time] of Object.entries(admissions))
                  if (time < cutoff) delete admissions[id];
                admissions[key] = this.now();
                this.persist(active);
                admitted = true;
              }
            }
            if (admitted && this.leased(active)) {
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
              )
                await this.options.deliver(
                  active.data.businessId,
                  active.data.ownerId,
                  message,
                  response,
                  key
                );
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
      }
    } catch {
      if (this.current(active) && active.data.generation === epoch) {
        active.socket?.close();
        const failures = (active.ingressFailures = (active.ingressFailures ?? 0) + 1);
        this.transition(active, failures > 8 ? "ERROR" : "RECONNECTING");
        if (failures <= 8) {
          clearTimeout(active.timer);
          active.timer = setTimeout(
            () => void this.open(active).catch(() => this.transition(active, "ERROR")),
            Math.min(60_000, 1000 * 2 ** failures)
          );
          active.timer.unref?.();
        }
      }
    } finally {
      active.draining = false;
      if (
        this.current(active) &&
        this.leased(active) &&
        active.state === "CONNECTED" &&
        active.data.inbox.length
      )
        setImmediate(() => void this.drain(active));
    }
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
  async disconnect(businessId: string, ownerId: string) {
    const active = this.load(businessId, ownerId);
    if (!active) return;
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
      delete this.index[businessId];
      this.options.vault.write("$index", JSON.stringify(this.index));
      // DISCONNECTED hands the lease back so another worker is never blocked for a full TTL.
      this.transition(active, "DISCONNECTED");
    }
  }
  async stop() {
    this.enabled = false;
    this.shutdown.abort();
    clearInterval(this.authorizationTimer);
    for (const active of this.active.values()) {
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
    // Never evict a delivery key and silently resend. Rotation requires a new connection.
    if (Object.keys(active.data.sent).length >= 10_000)
      throw new ChannelGatewayError("CHANNEL_SEND_FAILED", "Connection delivery journal is full.");
    const id = createHash("sha256")
      .update(`${active.data.businessId}:${key}`)
      .digest("hex")
      .slice(0, 32)
      .toUpperCase();
    active.data.sent[key] = {
      fingerprint,
      id,
      status: "pending",
      automated: request.idempotencyKey.startsWith("whatsapp-reply:")
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
      automated: request.idempotencyKey.startsWith("whatsapp-reply:")
    };
    this.persist(active);
    return { accepted: true, providerMessageId: deliveredId, status: "sent" };
  }
}
