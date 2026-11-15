import { createHmac, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import {
  linkedWorkerFrameLimitBytes,
  linkedWorkerTimeouts,
  type LinkedWorkerEnvelope
} from "@grogoni/shared-types";

/**
 * One end of a remote-worker connection (the contract is in packages/shared-types,
 * whatsapp-linked-worker.ts): newline-delimited JSON, unsigned until the handshake derives the
 * session key, then every frame is an envelope with a strictly increasing sequence number and an
 * HMAC. Any malformed, oversized, replayed, reordered or forged frame closes the connection.
 */

export type LinkedPeer = "hub" | "worker";

export function linkedSessionKey(secret: string, challenge: string, workerNonce: string): Buffer {
  return createHmac("sha256", secret)
    .update(`grogoni-linked-worker-session\n${challenge}\n${workerNonce}`)
    .digest();
}

function mac(key: Buffer, from: LinkedPeer, seq: number, body: string): string {
  return createHmac("sha256", key).update(`${from}\n${seq}\n${body}`).digest("base64url");
}

/** Builds the envelope `from` sends as frame number `seq`. Exposed for tests of the verifier. */
export function sealLinkedFrame(
  key: Buffer,
  from: LinkedPeer,
  seq: number,
  message: unknown
): LinkedWorkerEnvelope {
  const body = JSON.stringify(message);
  return { seq, body, mac: mac(key, from, seq, body) };
}

export type LinkedCloseReason =
  | "closed"
  | "idle"
  | "frame_too_large"
  | "frame_invalid"
  | "frame_replayed"
  | "frame_forged"
  | "handshake_timeout"
  | "refused"
  | "revoked"
  | "error";

export class LinkedFrameConnection {
  private chunks: Buffer[] = [];
  private pending = 0;
  private key: Buffer | undefined;
  private sent = 0;
  private received = 0;
  private closed = false;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private plainHandler: ((frame: Record<string, unknown>) => void) | undefined;
  private messageHandler: ((message: unknown) => void) | undefined;
  private readonly closeHandlers: Array<(reason: LinkedCloseReason) => void> = [];

  constructor(
    readonly socket: Socket,
    private readonly self: LinkedPeer,
    private readonly timeouts: { idle: number; ping: number } = linkedWorkerTimeouts
  ) {
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => this.data(chunk));
    socket.on("error", () => this.close("error"));
    socket.on("close", () => this.close("closed"));
    this.touch();
  }

  get isClosed(): boolean {
    return this.closed;
  }
  get secured(): boolean {
    return this.key !== undefined;
  }
  /** Handshake frames, before `secure`. */
  onPlain(handler: (frame: Record<string, unknown>) => void): void {
    this.plainHandler = handler;
  }
  /** Verified messages, after `secure`. */
  onMessage(handler: (message: unknown) => void): void {
    this.messageHandler = handler;
  }
  onClose(handler: (reason: LinkedCloseReason) => void): void {
    if (this.closed) handler("closed");
    else this.closeHandlers.push(handler);
  }

  sendPlain(frame: Record<string, unknown>): void {
    if (this.key) throw new Error("The session is already secured.");
    this.write(JSON.stringify(frame));
  }
  /** Switches both directions to signed envelopes and starts the keep-alive. */
  secure(key: Buffer): void {
    this.key = key;
    this.pingTimer = setInterval(() => this.send({ type: "ping" }), this.timeouts.ping);
    this.pingTimer.unref?.();
  }
  send(message: unknown): boolean {
    if (this.closed || !this.key) return false;
    this.sent += 1;
    return this.write(JSON.stringify(sealLinkedFrame(this.key, this.self, this.sent, message)));
  }
  close(reason: LinkedCloseReason): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    clearInterval(this.pingTimer);
    this.chunks = [];
    this.socket.destroy();
    for (const handler of this.closeHandlers.splice(0)) {
      try {
        handler(reason);
      } catch {
        /* One handler's failure must not keep the others from cleaning up. */
      }
    }
  }

  private write(line: string): boolean {
    if (Buffer.byteLength(line) + 1 > linkedWorkerFrameLimitBytes) {
      this.close("frame_too_large");
      return false;
    }
    return this.socket.write(line + "\n");
  }
  private touch(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close("idle"), this.timeouts.idle);
    this.idleTimer.unref?.();
  }
  private data(chunk: Buffer): void {
    if (this.closed) return;
    let start = 0;
    for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, start)) {
      this.chunks.push(chunk.subarray(start, index));
      const line = Buffer.concat(this.chunks).toString("utf8");
      this.chunks = [];
      this.pending = 0;
      start = index + 1;
      this.frame(line);
      if (this.closed) return;
    }
    const rest = chunk.subarray(start);
    this.pending += rest.length;
    if (this.pending > linkedWorkerFrameLimitBytes) return this.close("frame_too_large");
    if (rest.length) this.chunks.push(rest);
  }
  private frame(line: string): void {
    this.touch();
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return this.close("frame_invalid");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return this.close("frame_invalid");
    // A refusal answers the hello in plaintext, after the worker has already switched keys.
    const refusal =
      this.received === 0 && (value as { type?: unknown }).type === "refused" && !("seq" in value);
    if (!this.key || refusal) {
      this.plainHandler?.(value as Record<string, unknown>);
      return;
    }
    const envelope = value as Partial<LinkedWorkerEnvelope>;
    if (
      typeof envelope.seq !== "number" ||
      typeof envelope.body !== "string" ||
      typeof envelope.mac !== "string"
    )
      return this.close("frame_invalid");
    const peer: LinkedPeer = this.self === "hub" ? "worker" : "hub";
    const expected = Buffer.from(mac(this.key, peer, envelope.seq, envelope.body));
    const given = Buffer.from(envelope.mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given))
      return this.close("frame_forged");
    // Authentic but not the next frame: a replay or a reordering. Never processed.
    if (envelope.seq !== this.received + 1) return this.close("frame_replayed");
    this.received = envelope.seq;
    let message: unknown;
    try {
      message = JSON.parse(envelope.body);
    } catch {
      return this.close("frame_invalid");
    }
    this.messageHandler?.(message);
  }
}

/** Loopback hosts may use plaintext `tcp://`; everything else must use TLS. */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "[::1]" || host === "localhost";
}
