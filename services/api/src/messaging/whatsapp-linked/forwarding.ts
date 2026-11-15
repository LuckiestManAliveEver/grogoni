import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ChannelProviderReadiness } from "@grogoni/shared-types";
import type {
  ChannelSendResult,
  MessagingChannelAdapter,
  OutboundChannelMessage
} from "../channel-gateway.js";
import { ChannelGatewayError, type ChannelErrorCode } from "../channel-errors.js";
import { Cp2Error } from "../../cp2/cp2-error.js";
import { LinkedLeaseUnavailable, type LinkedWhatsAppConnector } from "./connector.js";
import type { LinkedLeaseDirectory } from "./lease.js";

/**
 * Multi-worker request routing (docs/architecture/whatsapp-linked-devices.md, "Requests that
 * land on another worker").
 *
 * Owner requests and channel sends reach whichever API worker the load balancer picks. Only the
 * worker holding a business's lease has its socket, so every other worker forwards the call to
 * the holder over an authenticated internal RPC. The holder's internal URL comes from its lease
 * row (migration 138). Forwarding is chosen over making each operation durable because two of
 * them need the live socket's answer synchronously: a pairing code and the group list.
 *
 * Safety never depends on routing being right. The holder runs the same connector methods, and
 * every connector method that touches the session checks the lease itself; a request that lands
 * on the wrong worker fails closed with CHANNEL_UNAVAILABLE (retryable) instead of acting.
 */

export const linkedForwardPath = "/internal/whatsapp-linked/forward";
const signatureHeader = "x-grogoni-linked-signature";
const timestampHeader = "x-grogoni-linked-timestamp";
const nonceHeader = "x-grogoni-linked-nonce";
/** Accepted clock difference between two API workers, and how long a nonce is remembered. */
const maxSkewMs = 30_000;
const nonceMemoryMs = 2 * maxSkewMs;
const maxRememberedNonces = 100_000;
/** Base64 of the 7 MiB attachment limit plus the JSON around it. */
const forwardBodyLimit = 12 * 1024 * 1024;

export type LinkedForwardOp =
  "status" | "connect" | "disconnect" | "approve" | "revoke" | "groups" | "send";

const timeouts: Record<LinkedForwardOp, number> = {
  status: 10_000,
  // Pairing asks WhatsApp for a code through the holder's socket.
  connect: 45_000,
  // The holder waits up to 5 s for WhatsApp's logout before erasing locally.
  disconnect: 20_000,
  approve: 10_000,
  revoke: 10_000,
  groups: 20_000,
  send: 45_000
};

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
function signature(token: string, timestamp: string, nonce: string, body: string): string {
  return createHmac("sha256", token)
    .update(`POST\n${linkedForwardPath}\n${timestamp}\n${nonce}\n${digest(body)}`)
    .digest("base64url");
}

/** Headers for one forwarded call. A new nonce each time; the body is bound by its digest. */
export function signLinkedForward(
  token: string,
  body: string,
  now = Date.now()
): Record<string, string> {
  const timestamp = String(now);
  const nonce = randomBytes(18).toString("base64url");
  return {
    [timestampHeader]: timestamp,
    [nonceHeader]: nonce,
    [signatureHeader]: signature(token, timestamp, nonce, body)
  };
}

/** Replay-protected verification: fresh timestamp, valid MAC, and a nonce never seen before. */
export class LinkedForwardVerifier {
  private readonly seen = new Map<string, number>();
  constructor(
    private readonly token: string,
    private readonly now: () => number = Date.now
  ) {}
  verify(headers: Record<string, unknown>, body: string): "ok" | "unauthorized" | "replayed" {
    const timestamp = headers[timestampHeader];
    const nonce = headers[nonceHeader];
    const mac = headers[signatureHeader];
    if (
      typeof timestamp !== "string" ||
      typeof nonce !== "string" ||
      typeof mac !== "string" ||
      !/^[0-9]{1,16}$/.test(timestamp) ||
      !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)
    )
      return "unauthorized";
    const expected = Buffer.from(signature(this.token, timestamp, nonce, body));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given))
      return "unauthorized";
    const now = this.now();
    if (Math.abs(now - Number(timestamp)) > maxSkewMs) return "replayed";
    this.prune(now);
    if (this.seen.has(nonce)) return "replayed";
    // Fail closed rather than forget a nonce that is still inside the acceptance window.
    if (this.seen.size >= maxRememberedNonces) return "replayed";
    this.seen.set(nonce, now + nonceMemoryMs);
    return "ok";
  }
  private prune(now: number): void {
    if (this.seen.size < 1024) return;
    for (const [nonce, until] of this.seen) if (until <= now) this.seen.delete(nonce);
  }
}

interface ForwardRequest {
  op: LinkedForwardOp;
  /** The holder this call was meant for; another worker refuses it. */
  target: string;
  businessId: string;
  ownerId: string;
  args: unknown[];
}

type WireError =
  | { kind: "channel"; code: ChannelErrorCode; message: string; retryable: boolean }
  | { kind: "cp2"; statusCode: number; code: string; message: string }
  | { kind: "plain"; message: string }
  | { kind: "not_holder" };

function toWire(error: unknown): WireError {
  if (error instanceof ChannelGatewayError)
    return {
      kind: "channel",
      code: error.code,
      message: error.message,
      retryable: error.retryable
    };
  if (error instanceof Cp2Error)
    return {
      kind: "cp2",
      statusCode: error.statusCode,
      code: error.code,
      message: error.message
    };
  // Connector validation messages are written for owners (e.g. "Connect WhatsApp first.").
  return {
    kind: "plain",
    message: error instanceof Error ? error.message.slice(0, 300) : "Request failed."
  };
}
function fromWire(error: WireError): Error {
  switch (error.kind) {
    case "channel":
      return new ChannelGatewayError(error.code, error.message, error.retryable);
    case "cp2":
      return new Cp2Error(error.statusCode, error.code, error.message);
    case "plain":
      return new Error(error.message);
    default:
      return new LinkedLeaseUnavailable();
  }
}

type ConnectorApi = Pick<
  LinkedWhatsAppConnector,
  | "status"
  | "connect"
  | "disconnect"
  | "approve"
  | "revoke"
  | "groups"
  | "sendMessage"
  | "readiness"
  | "getCapabilities"
  | "servesLocally"
>;
type Status = ReturnType<LinkedWhatsAppConnector["status"]>;
type Groups = Awaited<ReturnType<LinkedWhatsAppConnector["groups"]>>;

export interface LinkedForwardLogEvent {
  event: "whatsapp_linked.forward";
  op: LinkedForwardOp;
  businessId: string;
  target: string;
  outcome: "ok" | "error" | "unreachable" | "not_holder";
  durationMs: number;
}

export interface LinkedRouterOptions {
  connector: ConnectorApi;
  directory: LinkedLeaseDirectory;
  holderId: string;
  token: string;
  /**
   * Where a business's enrolled remote worker is attached, when nobody holds its lease yet
   * (remote-driver.ts). A pairing request must reach that host, the only one that can open.
   */
  attachment?: (businessId: string) => Promise<{ holderId: string; url: string } | null>;
  fetch?: typeof fetch;
  log?: (event: LinkedForwardLogEvent) => void;
  now?: () => number;
}

/**
 * The adapter the store and routes use in lease mode. Every call runs locally when this worker
 * holds the business's lease (or nobody does), and is forwarded to the holder otherwise.
 */
export class LinkedConnectorRouter implements MessagingChannelAdapter {
  readonly provider = "whatsapp_linked" as const;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  /** Connection states other workers published, refreshed by `poll`; keyed by business. */
  private remote = new Map<string, string>();
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: LinkedRouterOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** Refreshes the readiness view from the lease table every `intervalMs`. */
  startPolling(intervalMs = 5_000): void {
    clearInterval(this.pollTimer);
    void this.poll();
    this.pollTimer = setInterval(() => void this.poll(), intervalMs);
    this.pollTimer.unref?.();
  }
  stop(): void {
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }
  async poll(): Promise<void> {
    try {
      const rows = await this.options.directory.live();
      this.remote = new Map(
        rows
          .filter((row) => row.holderId !== this.options.holderId && row.holderState)
          .map((row) => [row.businessId, row.holderState!])
      );
    } catch {
      // Database unreachable: stop claiming other workers are ready rather than serve stale data.
      this.remote = new Map();
    }
  }

  readiness(context?: { businessId?: string }): ChannelProviderReadiness {
    const local = this.options.connector.readiness(context);
    if (local.status === "available" || !context?.businessId) return local;
    if (this.remote.get(context.businessId) !== "CONNECTED") return local;
    // Another worker runs this socket; a send from here is forwarded to it.
    return { ...local, authorized: true, status: "available", configurationRequirement: null };
  }
  getCapabilities() {
    return this.options.connector.getCapabilities();
  }

  status(businessId: string, ownerId: string): Promise<Status> {
    return this.route("status", businessId, ownerId, [], () =>
      this.options.connector.status(businessId, ownerId)
    );
  }
  connect(businessId: string, ownerId: string, phone?: string): Promise<void> {
    return this.route("connect", businessId, ownerId, phone === undefined ? [] : [phone], () =>
      this.options.connector.connect(businessId, ownerId, phone)
    );
  }
  disconnect(businessId: string, ownerId: string): Promise<void> {
    return this.route("disconnect", businessId, ownerId, [], () =>
      this.options.connector.disconnect(businessId, ownerId)
    );
  }
  approve(
    businessId: string,
    ownerId: string,
    chat: string,
    conversationId: string,
    automation: boolean
  ): Promise<void> {
    return this.route("approve", businessId, ownerId, [chat, conversationId, automation], () =>
      this.options.connector.approve(businessId, ownerId, chat, conversationId, automation)
    );
  }
  revoke(businessId: string, ownerId: string, chat: string): Promise<void> {
    return this.route("revoke", businessId, ownerId, [chat], () =>
      this.options.connector.revoke(businessId, ownerId, chat)
    );
  }
  groups(businessId: string, ownerId: string): Promise<Groups> {
    return this.route("groups", businessId, ownerId, [], () =>
      this.options.connector.groups(businessId, ownerId)
    );
  }
  sendMessage(request: OutboundChannelMessage): Promise<ChannelSendResult> {
    // The owner is re-derived on the holder from its own vault record, never taken from here.
    return this.route("send", request.businessId, "", [request], () =>
      this.options.connector.sendMessage(request)
    );
  }

  /** Where this business's call should run: null for here, otherwise the holder to forward to. */
  private async target(businessId: string): Promise<{ holderId: string; url: string } | null> {
    if (this.options.connector.servesLocally(businessId)) return null;
    let holder;
    try {
      holder = await this.options.directory.holder(businessId);
    } catch {
      throw new LinkedLeaseUnavailable(); // Cannot tell who runs it: never guess.
    }
    if (holder) {
      if (holder.holderId === this.options.holderId) return null;
      if (!holder.holderUrl) throw new LinkedLeaseUnavailable();
      return { holderId: holder.holderId, url: holder.holderUrl };
    }
    const attached = await this.options.attachment?.(businessId).catch(() => null);
    return attached && attached.holderId !== this.options.holderId ? attached : null;
  }

  private async route<T>(
    op: LinkedForwardOp,
    businessId: string,
    ownerId: string,
    args: unknown[],
    local: () => T | Promise<T>
  ): Promise<T> {
    // One rediscovery: the holder can change between the lookup and the call.
    for (let attempt = 0; attempt < 2; attempt++) {
      const target = await this.target(businessId);
      if (!target) return local();
      const outcome = await this.forward<T>(op, target, { businessId, ownerId, args });
      if (outcome.kind === "ok") return outcome.value;
      if (outcome.kind === "error") throw fromWire(outcome.error);
    }
    throw new LinkedLeaseUnavailable();
  }

  private async forward<T>(
    op: LinkedForwardOp,
    target: { holderId: string; url: string },
    call: { businessId: string; ownerId: string; args: unknown[] }
  ): Promise<{ kind: "ok"; value: T } | { kind: "error"; error: WireError } | { kind: "moved" }> {
    const started = this.now();
    const body = JSON.stringify({ op, target: target.holderId, ...call } satisfies ForwardRequest);
    const log = (outcome: LinkedForwardLogEvent["outcome"]) =>
      this.options.log?.({
        event: "whatsapp_linked.forward",
        op,
        businessId: call.businessId,
        target: target.holderId,
        outcome,
        durationMs: this.now() - started
      });
    let response: Response;
    try {
      response = await this.fetcher(`${target.url}${linkedForwardPath}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...signLinkedForward(this.options.token, body, this.now())
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(timeouts[op])
      });
    } catch {
      log("unreachable");
      // The holder still owns the socket until its lease expires: acting here could split the
      // session (a local disconnect would only erase this worker's copy). Retry shortly.
      throw new ChannelGatewayError(
        "CHANNEL_UNAVAILABLE",
        op === "send"
          ? "The WhatsApp worker for this business could not be reached; delivery is uncertain only if it already received the request. Check WhatsApp before sending again."
          : "The WhatsApp worker for this business could not be reached. Try again shortly.",
        true
      );
    }
    let payload: { ok?: unknown; value?: unknown; error?: WireError };
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      payload = {};
    }
    if (response.ok && payload.ok === true) {
      log("ok");
      return { kind: "ok", value: payload.value as T };
    }
    if (payload.error?.kind === "not_holder") {
      log("not_holder");
      return { kind: "moved" };
    }
    log("error");
    if (payload.error && typeof payload.error === "object" && "kind" in payload.error)
      return { kind: "error", error: payload.error };
    return {
      kind: "error",
      error: {
        kind: "channel",
        code: "CHANNEL_UNAVAILABLE",
        message: "The WhatsApp worker for this business refused the request.",
        retryable: true
      }
    };
  }
}

function parseForward(value: unknown): ForwardRequest | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;
  const ops: LinkedForwardOp[] = [
    "status",
    "connect",
    "disconnect",
    "approve",
    "revoke",
    "groups",
    "send"
  ];
  if (
    !ops.includes(body.op as LinkedForwardOp) ||
    typeof body.target !== "string" ||
    typeof body.businessId !== "string" ||
    typeof body.ownerId !== "string" ||
    body.businessId.length === 0 ||
    body.businessId.length > 200 ||
    body.ownerId.length > 200 ||
    !Array.isArray(body.args) ||
    body.args.length > 3
  )
    return null;
  return body as unknown as ForwardRequest;
}

function stringArg(args: unknown[], index: number): string {
  const value = args[index];
  if (typeof value !== "string" || value.length > 4096) throw new Error("Invalid request.");
  return value;
}

/** Runs one forwarded call against the local connector. Never forwards again. */
async function execute(connector: ConnectorApi, call: ForwardRequest): Promise<unknown> {
  const { businessId, ownerId, args } = call;
  switch (call.op) {
    case "status":
      return connector.status(businessId, ownerId);
    case "connect":
      await connector.connect(businessId, ownerId, args.length ? stringArg(args, 0) : undefined);
      return null;
    case "disconnect":
      await connector.disconnect(businessId, ownerId);
      return null;
    case "approve":
      if (typeof args[2] !== "boolean") throw new Error("Invalid request.");
      connector.approve(businessId, ownerId, stringArg(args, 0), stringArg(args, 1), args[2]);
      return null;
    case "revoke":
      connector.revoke(businessId, ownerId, stringArg(args, 0));
      return null;
    case "groups":
      return connector.groups(businessId, ownerId);
    case "send": {
      const request = args[0] as OutboundChannelMessage | undefined;
      if (
        typeof request !== "object" ||
        request === null ||
        request.businessId !== businessId ||
        typeof request.endpoint !== "object"
      )
        throw new Error("Invalid request.");
      // The connector re-validates the endpoint, scope, text and attachment itself.
      return connector.sendMessage(request);
    }
  }
}

/**
 * The holder side: POST /internal/whatsapp-linked/forward, HMAC-signed with the shared internal
 * token, refused unless addressed to this worker. Not reachable with a user session.
 */
export function registerLinkedForwardRoute(
  app: FastifyInstance,
  options: {
    connector: ConnectorApi;
    holderId: string;
    token: string;
    now?: () => number;
  }
): void {
  const verifier = new LinkedForwardVerifier(options.token, options.now);
  app.register(async (scope) => {
    // The MAC covers the exact bytes, so this route reads its body as a string itself.
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "string", bodyLimit: forwardBodyLimit },
      (_request, body, done) => done(null, body)
    );
    scope.post<{ Body: string }>(
      linkedForwardPath,
      { bodyLimit: forwardBodyLimit },
      async (request, reply) => {
        reply.header("cache-control", "no-store");
        const raw = typeof request.body === "string" ? request.body : "";
        const verdict = verifier.verify(request.headers, raw);
        if (verdict !== "ok") return reply.code(401).send({ ok: false, error: verdict });
        let call: ForwardRequest | null;
        try {
          call = parseForward(JSON.parse(raw));
        } catch {
          call = null;
        }
        if (!call)
          return reply
            .code(400)
            .send({ ok: false, error: { kind: "plain", message: "Invalid request." } });
        if (call.target !== options.holderId)
          return reply.code(409).send({ ok: false, error: { kind: "not_holder" } });
        try {
          return { ok: true, value: (await execute(options.connector, call)) ?? null };
        } catch (error) {
          const wire = toWire(error);
          const status =
            wire.kind === "cp2" ? wire.statusCode : wire.kind === "channel" ? 503 : 400;
          return reply.code(status).send({ ok: false, error: wire });
        }
      }
    );
  });
}
