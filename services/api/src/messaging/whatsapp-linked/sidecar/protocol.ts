import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Loopback protocol between the Android app (client) and the on-device WhatsApp sidecar
 * (server). Newline-delimited JSON over a TCP socket bound to 127.0.0.1. The first frame from
 * the client must be `hello` carrying the per-start token the app passed over the sidecar's
 * stdin pipe. Everything else is refused until then. Mirrored in Kotlin by
 * apps/android/app/src/main/java/market/grogoni/app/whatsapp/sidecar/SidecarProtocol.kt.
 */
export const sidecarProtocolVersion = 1;
/** Largest accepted frame. A 4,000-character message JSON-escapes to well under this. */
export const maxFrameBytes = 256 * 1024;
export const helloTimeoutMs = 2000;

export type SidecarMethod =
  | "status"
  | "connect"
  | "approve"
  | "revoke"
  | "groups"
  | "send"
  | "deliver"
  | "markRead"
  | "disconnect"
  | "deny"
  | "probe"
  | "vaultCheck"
  | "shutdown";

export const sidecarMethods: ReadonlySet<string> = new Set<SidecarMethod>([
  "status",
  "connect",
  "approve",
  "revoke",
  "groups",
  "send",
  "deliver",
  "markRead",
  "disconnect",
  "deny",
  "probe",
  "vaultCheck",
  "shutdown"
]);

export type ClientFrame =
  | { type: "hello"; token: string; protocol: number }
  | { type: "request"; id: number; method: SidecarMethod; params: Record<string, unknown> }
  | { type: "ack"; seq: number; ok: boolean };

export interface SidecarError {
  code: string;
  message: string;
  retryable: boolean;
}

/** Text-only ingress forwarded to the Grogoni API by the app. Never carries credentials. */
export interface SidecarIngressMessage {
  id: string;
  chat: string;
  sender: string;
  text: string;
  timestamp: string;
  replyTo?: string;
  mutation?: unknown;
}

export type ServerFrame =
  | { type: "welcome"; protocol: number; node: string; pid: number }
  | { type: "error"; code: string }
  | { type: "response"; id: number; ok: true; result: unknown }
  | { type: "response"; id: number; ok: false; error: SidecarError }
  | { type: "state"; businessId: string; state: string }
  | { type: "ingress"; seq: number; businessId: string; message: SidecarIngressMessage };

export function validToken(token: string): boolean {
  return /^[0-9a-f]{64}$/.test(token);
}

/** Constant-time comparison over digests, so neither length nor prefix leaks. */
export function tokenMatches(expected: string, presented: unknown): boolean {
  if (typeof presented !== "string") return false;
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(expected), digest(presented));
}

/** Parses one client frame. Returns null for anything malformed; callers close the socket. */
export function parseClientFrame(line: string): ClientFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const frame = value as Record<string, unknown>;
  switch (frame.type) {
    case "hello":
      return typeof frame.token === "string" && frame.protocol === sidecarProtocolVersion
        ? { type: "hello", token: frame.token, protocol: sidecarProtocolVersion }
        : null;
    case "request": {
      const params = frame.params ?? {};
      if (
        !Number.isSafeInteger(frame.id) ||
        (frame.id as number) < 0 ||
        typeof frame.method !== "string" ||
        !sidecarMethods.has(frame.method) ||
        typeof params !== "object" ||
        params === null ||
        Array.isArray(params)
      )
        return null;
      return {
        type: "request",
        id: frame.id as number,
        method: frame.method as SidecarMethod,
        params: params as Record<string, unknown>
      };
    }
    case "ack":
      return Number.isSafeInteger(frame.seq) && typeof frame.ok === "boolean"
        ? { type: "ack", seq: frame.seq as number, ok: frame.ok }
        : null;
    default:
      return null;
  }
}

/**
 * Splits a byte stream into newline-terminated frames, refusing any frame over the limit
 * before buffering it whole.
 */
export class FrameReader {
  private buffer = "";
  constructor(private readonly limit = maxFrameBytes) {}
  /** Returns complete lines, or null when the peer exceeded the frame limit. */
  push(chunk: string): string[] | null {
    this.buffer += chunk;
    const lines: string[] = [];
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (Buffer.byteLength(line, "utf8") > this.limit) return null;
      if (line.trim()) lines.push(line);
    }
    if (Buffer.byteLength(this.buffer, "utf8") > this.limit) return null;
    return lines;
  }
}
