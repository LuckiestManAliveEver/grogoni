/**
 * Versioned contracts for WhatsApp Linked Devices remote connector workers
 * (docs/architecture/whatsapp-linked-devices.md, "Remote connector workers").
 *
 * Two contracts live here so both sides import one definition:
 *
 * 1. The owner-only enrollment API: an owner issues a credential that lets one worker process
 *    carry one business's WhatsApp socket. The credential is shown once, stored hashed, expires,
 *    can be rotated and revoked.
 * 2. The worker transport: newline-delimited JSON frames on one TCP/TLS connection that the
 *    worker dials to the API's hub. The hub runs the connector (vault, journals, leases); the
 *    worker runs the protocol driver (Baileys) in its own process and reports back.
 *
 * Side-effect free: parsing and validation only. Cryptography stays in the API and the worker.
 */

/** Transport version. A peer that speaks another version is refused during the handshake. */
export const linkedWorkerProtocolVersion = "grogoni.whatsapp-linked-worker/1" as const;

/** Every frame is one line of JSON. Larger frames close the connection. */
export const linkedWorkerFrameLimitBytes = 16 * 1024 * 1024;

/** Inbound events the worker may have sent but the hub has not acknowledged yet. */
export const linkedWorkerInboundWindow = 16;

/**
 * Inbound events the worker buffers in total (window included). Equal to the connector's own
 * bounded journal: beyond it the worker closes the WhatsApp socket instead of dropping events.
 */
export const linkedWorkerInboundQueueLimit = 64;

/** Timeouts, in milliseconds, that both sides apply. */
export const linkedWorkerTimeouts = {
  handshake: 5_000,
  open: 30_000,
  pairingCode: 30_000,
  send: 30_000,
  downloadMedia: 60_000,
  groups: 15_000,
  logout: 5_000,
  /** Each side pings this often... */
  ping: 10_000,
  /** ...and closes the connection after this long without any frame from the peer. */
  idle: 30_000
} as const;

/** `gwlw1.<workerId>.<secret>`; the secret is 32 random bytes, base64url. */
export const linkedWorkerCredentialPattern =
  /^gwlw1\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/u;

export function parseLinkedWorkerCredential(
  value: string
): { workerId: string; secret: string } | null {
  const match = linkedWorkerCredentialPattern.exec(value.trim());
  return match ? { workerId: match[1]!, secret: match[2]! } : null;
}

// ---------------------------------------------------------------------------------------------
// Enrollment API (owner-only routes under /businesses/:businessId/channels/whatsapp-linked/workers)
// ---------------------------------------------------------------------------------------------

export type LinkedWorkerStatus = "active" | "revoked" | "expired";

/** What the owner sees. Never includes the credential or its hash. */
export interface LinkedWorkerSummary {
  id: string;
  businessId: string;
  label: string;
  status: LinkedWorkerStatus;
  createdAt: string;
  rotatedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  /** Credential generation; rotation increments it and invalidates the previous one at once. */
  credentialVersion: number;
  /** Set while the worker is connected to a hub. */
  attached: boolean;
  lastSeenAt: string | null;
}

/** POST .../workers and POST .../workers/:workerId/rotate answer this once. */
export interface LinkedWorkerCredentialIssued {
  worker: LinkedWorkerSummary;
  /** Shown once. Configure it as WHATSAPP_LINKED_WORKER_CREDENTIAL on the worker host. */
  credential: string;
}

export interface LinkedWorkerEnrollRequest {
  /** Must be `true`: the worker receives this business's WhatsApp device credentials. */
  consent: true;
  /** 1-80 printable characters naming the host, e.g. "shop back-office PC". */
  label: string;
}

export function parseLinkedWorkerLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  return label.length >= 1 && label.length <= 80 && /^[\p{L}\p{N} .,_'()-]+$/u.test(label)
    ? label
    : null;
}

// ---------------------------------------------------------------------------------------------
// Transport frames
// ---------------------------------------------------------------------------------------------

/** Handshake frames are unsigned; every later frame is a signed envelope. */
export interface LinkedWorkerChallengeFrame {
  type: "challenge";
  v: typeof linkedWorkerProtocolVersion;
  /** 32 random bytes, base64url. Fresh per connection. */
  nonce: string;
}
export interface LinkedWorkerHelloFrame {
  type: "hello";
  v: typeof linkedWorkerProtocolVersion;
  workerId: string;
  /** The credential secret. Only ever sent over TLS, or to a loopback hub. */
  secret: string;
  /** Echo of the challenge nonce: a hello captured from another connection is refused. */
  challenge: string;
  /** 32 random bytes, base64url, chosen by the worker. */
  nonce: string;
}
export interface LinkedWorkerRefusedFrame {
  type: "refused";
  code: LinkedWorkerRefusal;
}
export type LinkedWorkerRefusal =
  | "version_unsupported"
  | "handshake_invalid"
  | "credential_invalid"
  | "credential_revoked"
  | "credential_expired"
  | "owner_unauthorized"
  | "already_attached"
  | "hub_unavailable";

/**
 * Signed envelope: `body` is the JSON text of a `LinkedWorkerMessage`, `seq` starts at 1 for each
 * direction and increases by exactly one, and `mac` is base64url HMAC-SHA256 under the session
 * key over `<direction>\n<seq>\n<body>` (direction `hub` or `worker`). The session key is
 * HMAC-SHA256(secret, `grogoni-linked-worker-session\n<challenge>\n<worker nonce>`), so a frame
 * from another connection, a repeated frame or a reordered frame never verifies.
 */
export interface LinkedWorkerEnvelope {
  seq: number;
  body: string;
  mac: string;
}

export type LinkedWorkerSocketMethod =
  "pairingCode" | "send" | "downloadMedia" | "groups" | "logout";

/** Hub to worker. */
export type LinkedWorkerHubMessage =
  | { type: "welcome"; businessId: string; window: number }
  | {
      type: "open";
      socketId: string;
      auth: string | null;
      expectedPhone?: string;
      contacts: string[];
    }
  | { type: "contacts"; socketId: string; contacts: string[] }
  | { type: "close"; socketId: string }
  | {
      type: "call";
      id: number;
      socketId: string;
      method: LinkedWorkerSocketMethod;
      args: unknown[];
    }
  | { type: "cancel"; id: number }
  /** Acknowledges every inbound event up to and including `upto`. */
  | { type: "ack"; upto: number }
  | { type: "ping" }
  | { type: "revoked" };

/** Worker to hub. */
export type LinkedWorkerWorkerMessage =
  | { type: "opened"; socketId: string }
  | { type: "open_failed"; socketId: string; error: string }
  | { type: "result"; id: number; ok: true; value: unknown }
  | { type: "result"; id: number; ok: false; error: string }
  | { type: "inbound"; socketId: string; n: number; message: unknown }
  | {
      type: "state";
      socketId: string;
      state: "open" | "close";
      reason?: "revoked" | "restart" | "retry" | "auth";
    }
  | { type: "save"; socketId: string; auth: string }
  | { type: "ping" };

export type LinkedWorkerMessage = LinkedWorkerHubMessage | LinkedWorkerWorkerMessage;

const hubTypes = new Set([
  "welcome",
  "open",
  "contacts",
  "close",
  "call",
  "cancel",
  "ack",
  "ping",
  "revoked"
]);
const workerTypes = new Set([
  "opened",
  "open_failed",
  "result",
  "inbound",
  "state",
  "save",
  "ping"
]);
const methods = new Set(["pairingCode", "send", "downloadMedia", "groups", "logout"]);
const closeReasons = new Set(["revoked", "restart", "retry", "auth"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const isId = (value: unknown) =>
  typeof value === "string" && value.length > 0 && value.length <= 100;
const isCount = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isContacts = (value: unknown) =>
  Array.isArray(value) &&
  value.length <= 200 &&
  value.every((entry) => typeof entry === "string" && entry.length <= 64);

/** Structural validation of a decoded hub message. Unknown shapes return null. */
export function parseLinkedWorkerHubMessage(value: unknown): LinkedWorkerHubMessage | null {
  if (!isRecord(value) || typeof value.type !== "string" || !hubTypes.has(value.type)) return null;
  switch (value.type) {
    case "welcome":
      return isId(value.businessId) && isCount(value.window)
        ? (value as LinkedWorkerHubMessage)
        : null;
    case "open":
      return isId(value.socketId) &&
        (value.auth === null || typeof value.auth === "string") &&
        (value.expectedPhone === undefined || typeof value.expectedPhone === "string") &&
        isContacts(value.contacts)
        ? (value as LinkedWorkerHubMessage)
        : null;
    case "contacts":
      return isId(value.socketId) && isContacts(value.contacts)
        ? (value as LinkedWorkerHubMessage)
        : null;
    case "close":
      return isId(value.socketId) ? (value as LinkedWorkerHubMessage) : null;
    case "call":
      return isCount(value.id) &&
        isId(value.socketId) &&
        typeof value.method === "string" &&
        methods.has(value.method) &&
        Array.isArray(value.args)
        ? (value as LinkedWorkerHubMessage)
        : null;
    case "cancel":
      return isCount(value.id) ? (value as LinkedWorkerHubMessage) : null;
    case "ack":
      return isCount(value.upto) ? (value as LinkedWorkerHubMessage) : null;
    default:
      return value as LinkedWorkerHubMessage;
  }
}

/** Structural validation of a decoded worker message. Unknown shapes return null. */
export function parseLinkedWorkerWorkerMessage(value: unknown): LinkedWorkerWorkerMessage | null {
  if (!isRecord(value) || typeof value.type !== "string" || !workerTypes.has(value.type))
    return null;
  switch (value.type) {
    case "opened":
      return isId(value.socketId) ? (value as LinkedWorkerWorkerMessage) : null;
    case "open_failed":
      return isId(value.socketId) && typeof value.error === "string"
        ? (value as LinkedWorkerWorkerMessage)
        : null;
    case "result":
      return isCount(value.id) &&
        (value.ok === true || (value.ok === false && typeof value.error === "string"))
        ? (value as LinkedWorkerWorkerMessage)
        : null;
    case "inbound":
      return isId(value.socketId) && isCount(value.n) && isRecord(value.message)
        ? (value as LinkedWorkerWorkerMessage)
        : null;
    case "state":
      return isId(value.socketId) &&
        (value.state === "open" || value.state === "close") &&
        (value.reason === undefined ||
          (typeof value.reason === "string" && closeReasons.has(value.reason)))
        ? (value as LinkedWorkerWorkerMessage)
        : null;
    case "save":
      return isId(value.socketId) && typeof value.auth === "string"
        ? (value as LinkedWorkerWorkerMessage)
        : null;
    default:
      return value as LinkedWorkerWorkerMessage;
  }
}
