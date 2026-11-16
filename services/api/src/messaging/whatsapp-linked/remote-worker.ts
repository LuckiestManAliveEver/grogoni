import { randomBytes } from "node:crypto";
import { connect as connectNet } from "node:net";
import { connect as connectTls } from "node:tls";
import {
  linkedWorkerInboundQueueLimit,
  linkedWorkerInboundWindow,
  linkedWorkerProtocolVersion,
  linkedWorkerTimeouts,
  parseLinkedWorkerCredential,
  parseLinkedWorkerHubMessage,
  type LinkedWorkerRefusal,
  type LinkedWorkerWorkerMessage
} from "@grogoni/shared-types";
import type { LinkedDriver, LinkedInbound, LinkedSocket } from "./connector.js";
import type { LinkedDownloadedMedia, LinkedMedia } from "./media.js";
import { isLoopbackHost, LinkedFrameConnection, linkedSessionKey } from "./remote-transport.js";

/**
 * Worker side of remote connector workers: a separate process that holds only the protocol
 * driver (Baileys in production) for the one business its credential is bound to. It dials the
 * API hub, authenticates, and does what the hub asks. It keeps no session data on disk: device
 * credentials arrive with each `open` and every change goes back as `save`.
 *
 * Back-pressure: at most `linkedWorkerInboundWindow` inbound events are unacknowledged, and at
 * most `linkedWorkerInboundQueueLimit` are buffered, the same bound as the connector's journal.
 * On overflow the worker closes the WhatsApp socket and reports a retryable close instead of
 * silently dropping events; the connector reconnects.
 */

/** Refusals that will not change by retrying with the same credential. */
const permanent = new Set<LinkedWorkerRefusal>([
  "version_unsupported",
  "credential_invalid",
  "credential_revoked",
  "credential_expired",
  "owner_unauthorized"
]);

export interface LinkedRemoteWorkerLogEvent {
  event: "whatsapp_linked.worker";
  action: "connected" | "refused" | "disconnected" | "stopped" | "overflow";
  reason?: string;
  businessId?: string;
}

export interface LinkedRemoteWorkerOptions {
  /** `tls://host:port`, or `tcp://<loopback>:port`. */
  hubUrl: string;
  /** `gwlw1.<workerId>.<secret>` from enrollment. */
  credential: string;
  driver: LinkedDriver;
  /** Extra CA certificates for the hub's TLS certificate (PEM). */
  ca?: Buffer;
  log?: (event: LinkedRemoteWorkerLogEvent) => void;
  reconnect?: { minMs: number; maxMs: number };
  timeouts?: Partial<typeof linkedWorkerTimeouts>;
}

export function parseLinkedHubUrl(value: string): { tls: boolean; host: string; port: number } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("WHATSAPP_LINKED_HUB_URL must be tls://host:port or tcp://127.0.0.1:port.");
  }
  const port = Number(url.port);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    (url.protocol !== "tls:" && url.protocol !== "tcp:") ||
    !Number.isInteger(port) ||
    port < 1 ||
    url.pathname.replace(/^\/$/, "") !== "" ||
    url.username ||
    url.search
  )
    throw new Error("WHATSAPP_LINKED_HUB_URL must be tls://host:port or tcp://127.0.0.1:port.");
  if (url.protocol === "tcp:" && !isLoopbackHost(host))
    throw new Error("Plain tcp:// is allowed only to a loopback hub; use tls://.");
  return { tls: url.protocol === "tls:", host, port };
}

export class LinkedRemoteWorker {
  private connection: LinkedFrameConnection | undefined;
  private socket: LinkedSocket | undefined;
  private socketId: string | undefined;
  private contacts: string[] = [];
  private queue: Array<{ socketId: string; message: LinkedInbound }> = [];
  private sentUpTo = 0;
  private ackedUpTo = 0;
  private window = linkedWorkerInboundWindow;
  private readonly cancels = new Map<number, AbortController>();
  private stopped = false;
  private delay: number;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly hub: { tls: boolean; host: string; port: number };
  private readonly workerId: string;
  private readonly secret: string;
  private readonly timeouts: typeof linkedWorkerTimeouts;
  private settleStopped!: (reason: string) => void;
  /** Resolves with the reason once the worker stops for good (stop() or a permanent refusal). */
  readonly finished = new Promise<string>((resolve) => (this.settleStopped = resolve));
  businessId: string | undefined;

  constructor(private readonly options: LinkedRemoteWorkerOptions) {
    this.hub = parseLinkedHubUrl(options.hubUrl);
    const credential = parseLinkedWorkerCredential(options.credential);
    if (!credential)
      throw new Error("WHATSAPP_LINKED_WORKER_CREDENTIAL is not a worker credential.");
    this.workerId = credential.workerId;
    this.secret = credential.secret;
    this.timeouts = { ...linkedWorkerTimeouts, ...options.timeouts };
    this.delay = options.reconnect?.minMs ?? 1_000;
  }

  start(): void {
    if (this.stopped || this.connection) return;
    const raw = this.hub.tls
      ? connectTls({
          host: this.hub.host,
          port: this.hub.port,
          servername: this.hub.host,
          minVersion: "TLSv1.2",
          ...(this.options.ca ? { ca: this.options.ca } : {})
        })
      : connectNet({ host: this.hub.host, port: this.hub.port });
    const connection = new LinkedFrameConnection(raw, "worker", this.timeouts);
    this.connection = connection;
    const nonce = randomBytes(32).toString("base64url");
    let challenge: string | undefined;
    const deadline = setTimeout(
      () => connection.close("handshake_timeout"),
      this.timeouts.handshake
    );
    deadline.unref?.();
    connection.onPlain((frame) => {
      if (frame.type === "refused") {
        clearTimeout(deadline);
        const code = String(frame.code) as LinkedWorkerRefusal;
        this.options.log?.({ event: "whatsapp_linked.worker", action: "refused", reason: code });
        if (permanent.has(code)) this.stop(code);
        connection.close("refused");
        return;
      }
      if (challenge !== undefined || frame.type !== "challenge" || typeof frame.nonce !== "string")
        return connection.close("frame_invalid");
      if (frame.v !== linkedWorkerProtocolVersion) {
        this.stop("version_unsupported");
        return connection.close("refused");
      }
      challenge = frame.nonce;
      connection.sendPlain({
        type: "hello",
        v: linkedWorkerProtocolVersion,
        workerId: this.workerId,
        secret: this.secret,
        challenge,
        nonce
      });
      // The hub's first signed frame (welcome) proves it derived the same session key.
      connection.secure(linkedSessionKey(this.secret, challenge, nonce));
    });
    connection.onMessage((value) => {
      clearTimeout(deadline);
      this.message(connection, value);
    });
    connection.onClose((reason) => {
      clearTimeout(deadline);
      if (this.connection === connection) this.connection = undefined;
      this.closeSocket();
      this.options.log?.({ event: "whatsapp_linked.worker", action: "disconnected", reason });
      if (reason === "revoked") this.stop("credential_revoked");
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  stop(reason = "stopped"): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.closeSocket();
    this.connection?.close("closed");
    this.options.log?.({ event: "whatsapp_linked.worker", action: "stopped", reason });
    this.settleStopped(reason);
  }

  private scheduleReconnect(): void {
    clearTimeout(this.retryTimer);
    const max = this.options.reconnect?.maxMs ?? 60_000;
    const wait = this.delay + Math.floor(Math.random() * Math.min(500, this.delay));
    this.delay = Math.min(max, this.delay * 2);
    this.retryTimer = setTimeout(() => this.start(), wait);
    this.retryTimer.unref?.();
  }

  private send(message: LinkedWorkerWorkerMessage): void {
    this.connection?.send(message);
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.socketId = undefined;
    this.queue = [];
    this.sentUpTo = this.ackedUpTo = 0;
    for (const controller of this.cancels.values()) controller.abort();
    this.cancels.clear();
    socket?.close();
  }

  private message(connection: LinkedFrameConnection, value: unknown): void {
    const message = parseLinkedWorkerHubMessage(value);
    if (!message) return connection.close("frame_invalid");
    switch (message.type) {
      case "welcome":
        this.businessId = message.businessId;
        this.window = Math.max(1, Math.min(linkedWorkerInboundWindow, message.window));
        this.delay = this.options.reconnect?.minMs ?? 1_000;
        this.options.log?.({
          event: "whatsapp_linked.worker",
          action: "connected",
          businessId: message.businessId
        });
        return;
      case "ping":
        return;
      case "revoked":
        this.stop("credential_revoked");
        return;
      case "open":
        void this.open(message.socketId, message.auth, message.expectedPhone, message.contacts);
        return;
      case "contacts":
        if (message.socketId === this.socketId) this.contacts = message.contacts;
        return;
      case "close":
        if (message.socketId === this.socketId) this.closeSocket();
        return;
      case "ack":
        if (message.upto > this.ackedUpTo && message.upto <= this.sentUpTo) {
          this.ackedUpTo = message.upto;
          this.pump();
        }
        return;
      case "cancel":
        this.cancels.get(message.id)?.abort();
        return;
      case "call":
        void this.call(message.id, message.socketId, message.method, message.args);
        return;
    }
  }

  private async open(
    socketId: string,
    auth: string | null,
    expectedPhone: string | undefined,
    contacts: string[]
  ): Promise<void> {
    this.closeSocket();
    this.socketId = socketId;
    this.contacts = contacts;
    const current = () => this.socketId === socketId;
    try {
      const socket = await this.options.driver.open({
        ...(this.businessId ? { businessId: this.businessId } : {}),
        auth,
        ...(expectedPhone ? { expectedPhone } : {}),
        approvedContacts: () => this.contacts,
        save: (next) => {
          if (current()) this.send({ type: "save", socketId, auth: next });
        },
        state: (state, reason) => {
          if (current())
            this.send({ type: "state", socketId, state, ...(reason ? { reason } : {}) });
        },
        inbound: (message) => {
          if (current()) this.enqueue(socketId, message);
        }
      });
      if (!current()) {
        socket.close();
        return;
      }
      this.socket = socket;
      this.send({ type: "opened", socketId });
    } catch (error) {
      if (current()) {
        this.socketId = undefined;
        this.send({
          type: "open_failed",
          socketId,
          error: error instanceof Error ? error.message.slice(0, 300) : "open failed"
        });
      }
    }
  }

  private enqueue(socketId: string, message: LinkedInbound): void {
    if (this.queue.length + (this.sentUpTo - this.ackedUpTo) >= linkedWorkerInboundQueueLimit) {
      // The hub is not keeping up. Stop accepting events rather than lose them silently.
      this.options.log?.({ event: "whatsapp_linked.worker", action: "overflow" });
      this.send({ type: "state", socketId, state: "close", reason: "retry" });
      this.closeSocket();
      return;
    }
    this.queue.push({ socketId, message });
    this.pump();
  }

  private pump(): void {
    while (this.queue.length && this.sentUpTo - this.ackedUpTo < this.window) {
      const next = this.queue.shift()!;
      this.sentUpTo += 1;
      this.send({
        type: "inbound",
        socketId: next.socketId,
        n: this.sentUpTo,
        message: next.message
      });
    }
  }

  private async call(id: number, socketId: string, method: string, args: unknown[]): Promise<void> {
    const socket = this.socket;
    if (!socket || socketId !== this.socketId) {
      this.send({ type: "result", id, ok: false, error: "The WhatsApp socket is closed." });
      return;
    }
    const controller = new AbortController();
    this.cancels.set(id, controller);
    try {
      let value: unknown = null;
      switch (method) {
        case "pairingCode":
          value = await socket.pairingCode(String(args[0] ?? ""));
          break;
        case "groups":
          value = socket.groups ? await socket.groups() : [];
          break;
        case "logout":
          await socket.logout();
          break;
        case "send": {
          const [chat, text, messageId, rawMedia, quote] = args as [
            string,
            string,
            string,
            (Omit<LinkedDownloadedMedia, "bytes"> & { bytes: string }) | null,
            Parameters<LinkedSocket["send"]>[4] | null
          ];
          const media = rawMedia
            ? { ...rawMedia, bytes: Buffer.from(rawMedia.bytes, "base64") }
            : undefined;
          value = await socket.send(chat, text, messageId, media, quote ?? undefined);
          break;
        }
        case "downloadMedia": {
          if (!socket.downloadMedia) throw new Error("Media download is unavailable.");
          const bytes = await socket.downloadMedia(args[0] as LinkedMedia, controller.signal);
          value = bytes.toString("base64");
          break;
        }
        default:
          throw new Error("Unknown method.");
      }
      if (!controller.signal.aborted) this.send({ type: "result", id, ok: true, value });
    } catch (error) {
      if (!controller.signal.aborted)
        this.send({
          type: "result",
          id,
          ok: false,
          error: error instanceof Error ? error.message.slice(0, 300) : "failed"
        });
    } finally {
      this.cancels.delete(id);
    }
  }
}
