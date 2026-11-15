import { randomBytes, randomUUID } from "node:crypto";
import { createServer as createNetServer, type Server, type Socket } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import type { AddressInfo } from "node:net";
import {
  linkedWorkerInboundWindow,
  linkedWorkerProtocolVersion,
  linkedWorkerTimeouts,
  parseLinkedWorkerWorkerMessage,
  type LinkedWorkerHubMessage,
  type LinkedWorkerRefusal,
  type LinkedWorkerSocketMethod
} from "@grogoni/shared-types";
import {
  LinkedWorkerOffline,
  type LinkedDriver,
  type LinkedInbound,
  type LinkedSocket
} from "./connector.js";
import type { LinkedMedia } from "./media.js";
import { isLoopbackHost, LinkedFrameConnection, linkedSessionKey } from "./remote-transport.js";
import type { LinkedWorkerRegistry } from "./worker-registry.js";

/**
 * API side of remote connector workers (docs/architecture/whatsapp-linked-devices.md, "Remote
 * connector workers"). An enrolled worker process dials this hub, authenticates with its
 * credential and then runs the protocol driver for its one business. The connector, the vault,
 * the inbound journal, idempotency and leases all stay here; `RemoteLinkedDriver` makes the
 * worker look like any other `LinkedDriver`.
 */

type DriverInput = Parameters<LinkedDriver["open"]>[0];

export interface LinkedHubLogEvent {
  event: "whatsapp_linked.remote_worker";
  action: "attached" | "refused" | "detached";
  workerId?: string;
  businessId?: string;
  reason?: string;
}

export interface LinkedWorkerHubOptions {
  registry: LinkedWorkerRegistry;
  /** Throws unless `ownerId` still owns `businessId` (store.validateLinkedWhatsAppOwner). */
  authorize: (businessId: string, ownerId: string) => void;
  /** This API worker's lease holder id and internal URL; recorded on attach for forwarding. */
  holderId: string;
  holderUrl: string | null;
  /** Called after a worker attaches, so its business's session can open now. */
  onAttach?: (businessId: string) => void;
  log?: (event: LinkedHubLogEvent) => void;
  /** Attachment claim duration and re-check period. */
  attachTtlMs?: number;
  recheckMs?: number;
  timeouts?: Partial<typeof linkedWorkerTimeouts>;
}

/** Listener settings from the environment; undefined when remote workers are off. */
export function linkedHubListenFromEnvironment(
  environment: Record<string, string | undefined>,
  readFile: (path: string) => Buffer
): { host: string; port: number; tls?: { cert: Buffer; key: Buffer } } | undefined {
  const listen = environment.WHATSAPP_LINKED_HUB_LISTEN?.trim();
  if (!listen) return undefined;
  const match = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):([0-9]{1,5})$/.exec(listen);
  const port = Number(match?.[2]);
  if (!match || !Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("WHATSAPP_LINKED_HUB_LISTEN must be host:port.");
  const host = match[1]!.replace(/^\[|\]$/g, "");
  const certFile = environment.WHATSAPP_LINKED_HUB_TLS_CERT_FILE?.trim();
  const keyFile = environment.WHATSAPP_LINKED_HUB_TLS_KEY_FILE?.trim();
  if (Boolean(certFile) !== Boolean(keyFile))
    throw new Error(
      "Set both WHATSAPP_LINKED_HUB_TLS_CERT_FILE and WHATSAPP_LINKED_HUB_TLS_KEY_FILE, or neither."
    );
  if (!certFile && !isLoopbackHost(host))
    throw new Error(
      "WHATSAPP_LINKED_HUB_LISTEN on a non-loopback address requires TLS (WHATSAPP_LINKED_HUB_TLS_CERT_FILE and _KEY_FILE): workers send their credential on connect."
    );
  return {
    host,
    port,
    ...(certFile && keyFile ? { tls: { cert: readFile(certFile), key: readFile(keyFile) } } : {})
  };
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Remote failures surface as plain errors; the connector treats them like local driver errors. */
class LinkedRemoteError extends Error {}

/** One authenticated worker connection, serving one business. */
export class LinkedAttachedWorker {
  private socketId: string | undefined;
  private input: DriverInput | undefined;
  private opening:
    { socketId: string; resolve: () => void; reject: (error: Error) => void } | undefined;
  private readonly calls = new Map<number, PendingCall>();
  private nextCall = 1;
  private contacts = "[]";
  private contactTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    readonly workerId: string,
    readonly businessId: string,
    readonly credentialVersion: number,
    private readonly connection: LinkedFrameConnection,
    private readonly timeouts: typeof linkedWorkerTimeouts
  ) {
    connection.onMessage((value) => this.message(value));
    connection.onClose(() => this.lost());
  }

  get closed(): boolean {
    return this.connection.isClosed;
  }
  close(reason: "revoked" | "closed" = "closed"): void {
    if (reason === "revoked") this.connection.send({ type: "revoked" });
    this.connection.close(reason);
  }

  /** `LinkedDriver.open` for this worker's business. One socket at a time; a reopen replaces. */
  async open(input: DriverInput): Promise<LinkedSocket> {
    if (this.closed) throw new LinkedWorkerOffline();
    this.retire();
    const socketId = randomUUID();
    this.socketId = socketId;
    this.input = input;
    this.contacts = JSON.stringify(input.approvedContacts?.() ?? []);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.opening = undefined;
        reject(new LinkedRemoteError("The WhatsApp worker did not open the connection in time."));
      }, this.timeouts.open);
      this.opening = {
        socketId,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      };
      this.send({
        type: "open",
        socketId,
        auth: input.auth,
        ...(input.expectedPhone ? { expectedPhone: input.expectedPhone } : {}),
        contacts: JSON.parse(this.contacts) as string[]
      });
    });
    // The worker's driver reads approved contacts synchronously; keep its copy current.
    this.contactTimer = setInterval(() => {
      if (this.socketId !== socketId) return;
      const next = JSON.stringify(input.approvedContacts?.() ?? []);
      if (next === this.contacts) return;
      this.contacts = next;
      this.send({ type: "contacts", socketId, contacts: JSON.parse(next) as string[] });
    }, 2_000);
    this.contactTimer.unref?.();
    const call = (
      method: LinkedWorkerSocketMethod,
      args: unknown[],
      timeout: number,
      signal?: AbortSignal
    ) => this.call(socketId, method, args, timeout, signal);
    return {
      pairingCode: async (phone) => {
        const code = await call("pairingCode", [phone], this.timeouts.pairingCode);
        if (typeof code !== "string" || code.length > 32)
          throw new LinkedRemoteError("Invalid pairing code from the worker.");
        return code;
      },
      groups: async () => {
        const groups = await call("groups", [], this.timeouts.groups);
        if (!Array.isArray(groups)) throw new LinkedRemoteError("Invalid group list.");
        return groups
          .filter(
            (group): group is { chat: string; name: string } =>
              typeof group === "object" &&
              group !== null &&
              typeof (group as { chat?: unknown }).chat === "string" &&
              typeof (group as { name?: unknown }).name === "string"
          )
          .slice(0, 500);
      },
      send: async (chat, text, messageId, media, quote) => {
        const id = await call(
          "send",
          [
            chat,
            text,
            messageId,
            media ? { ...media, bytes: media.bytes.toString("base64") } : null,
            quote ?? null
          ],
          this.timeouts.send
        );
        if (typeof id !== "string" || id.length === 0 || id.length > 128)
          throw new LinkedRemoteError("Invalid delivery id from the worker.");
        return id;
      },
      downloadMedia: async (media: LinkedMedia, signal: AbortSignal) => {
        const encoded = await call("downloadMedia", [media], this.timeouts.downloadMedia, signal);
        if (typeof encoded !== "string") throw new LinkedRemoteError("Invalid media.");
        return Buffer.from(encoded, "base64");
      },
      logout: async () => {
        await call("logout", [], this.timeouts.logout);
      },
      close: () => {
        if (this.socketId !== socketId) return;
        this.send({ type: "close", socketId });
        this.retire();
      }
    };
  }

  private send(message: LinkedWorkerHubMessage): void {
    this.connection.send(message);
  }
  /** Forget the current socket: its later events are ignored and its calls fail. */
  private retire(): void {
    clearInterval(this.contactTimer);
    const previous = this.socketId;
    this.socketId = undefined;
    this.input = undefined;
    this.opening?.reject(new LinkedRemoteError("Superseded."));
    this.opening = undefined;
    if (previous)
      for (const [id, call] of this.calls)
        this.settle(id, call, new LinkedRemoteError("Socket closed."));
  }
  private settle(id: number, call: PendingCall, error?: Error, value?: unknown): void {
    clearTimeout(call.timer);
    this.calls.delete(id);
    if (error) call.reject(error);
    else call.resolve(value);
  }
  private call(
    socketId: string,
    method: LinkedWorkerSocketMethod,
    args: unknown[],
    timeout: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (this.closed || this.socketId !== socketId)
      return Promise.reject(new LinkedRemoteError("The WhatsApp worker connection closed."));
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Aborted."));
    const id = this.nextCall++;
    return new Promise((resolve, reject) => {
      const pending: PendingCall = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.send({ type: "cancel", id });
          this.settle(
            id,
            pending,
            new LinkedRemoteError(`The WhatsApp worker timed out (${method}).`)
          );
        }, timeout)
      };
      this.calls.set(id, pending);
      signal?.addEventListener(
        "abort",
        () => {
          if (!this.calls.has(id)) return;
          this.send({ type: "cancel", id });
          this.settle(id, pending, new Error("Aborted."));
        },
        { once: true }
      );
      this.send({ type: "call", id, socketId, method, args });
    });
  }

  private message(value: unknown): void {
    const message = parseLinkedWorkerWorkerMessage(value);
    if (!message) return this.connection.close("frame_invalid");
    switch (message.type) {
      case "ping":
        return;
      case "opened":
      case "open_failed": {
        if (this.opening?.socketId !== message.socketId) return;
        const opening = this.opening;
        this.opening = undefined;
        if (message.type === "opened") opening.resolve();
        else opening.reject(new LinkedRemoteError("The WhatsApp worker could not connect."));
        return;
      }
      case "result": {
        const call = this.calls.get(message.id);
        if (!call) return;
        if (message.ok) this.settle(message.id, call, undefined, message.value);
        else this.settle(message.id, call, new LinkedRemoteError(message.error.slice(0, 300)));
        return;
      }
      case "inbound": {
        // Acknowledge whether or not the event is still wanted: the window must keep moving.
        // The connector's inbound callback journals synchronously, so the ack follows it.
        if (message.socketId === this.socketId && this.input) {
          const inbound = parseRemoteInbound(message.message);
          if (inbound) this.input.inbound(inbound);
        }
        this.send({ type: "ack", upto: message.n });
        return;
      }
      case "state": {
        if (message.socketId !== this.socketId || !this.input) return;
        const input = this.input;
        if (message.state === "close") this.retire();
        input.state(message.state, message.reason);
        return;
      }
      case "save": {
        if (message.socketId === this.socketId && message.auth.length <= 8 * 1024 * 1024)
          this.input?.save(message.auth);
        return;
      }
    }
  }

  private lost(): void {
    const input = this.socketId ? this.input : undefined;
    this.retire();
    for (const [id, call] of this.calls)
      this.settle(id, call, new LinkedRemoteError("Worker disconnected."));
    // The connector reconnects; until the worker is back that open waits as LinkedWorkerOffline.
    input?.state("close", "retry");
  }
}

const mutationKinds = new Set(["edit", "delete", "receipt"]);
const receiptStatus = new Set(["sent", "delivered", "read", "failed"]);
const mediaTypes = new Set(["image", "document", "audio"]);
const str = (value: unknown, max: number) => typeof value === "string" && value.length <= max;

/** Structural check of an inbound event from a worker. The connector applies its own rules after. */
export function parseRemoteInbound(value: unknown): LinkedInbound | null {
  if (typeof value !== "object" || value === null) return null;
  const message = value as Record<string, unknown>;
  if (
    !str(message.id, 200) ||
    !str(message.chat, 64) ||
    !str(message.sender, 64) ||
    !str(message.text, 4000) ||
    !str(message.timestamp, 64) ||
    typeof message.fromMe !== "boolean" ||
    typeof message.mentioned !== "boolean" ||
    (message.replyTo !== undefined && !str(message.replyTo, 200))
  )
    return null;
  const inbound: LinkedInbound = {
    id: message.id as string,
    chat: message.chat as string,
    sender: message.sender as string,
    text: message.text as string,
    timestamp: message.timestamp as string,
    fromMe: message.fromMe,
    mentioned: message.mentioned,
    ...(message.replyTo !== undefined ? { replyTo: message.replyTo as string } : {})
  };
  if (message.media !== undefined) {
    if (!Array.isArray(message.media) || message.media.length > 1) return null;
    const media: LinkedMedia[] = [];
    for (const entry of message.media as unknown[]) {
      const item = entry as Record<string, unknown> | null;
      if (
        !item ||
        !mediaTypes.has(item.type as string) ||
        !str(item.mimeType, 200) ||
        !str(item.filename, 300) ||
        typeof item.size !== "number" ||
        !str(item.directPath, 2000) ||
        !str(item.key, 200) ||
        !str(item.sha256, 200)
      )
        return null;
      media.push({
        type: item.type as LinkedMedia["type"],
        mimeType: item.mimeType as string,
        filename: item.filename as string,
        size: item.size,
        directPath: item.directPath as string,
        key: item.key as string,
        sha256: item.sha256 as string
      });
    }
    inbound.media = media;
  }
  if (message.mutation !== undefined) {
    const mutation = message.mutation as Record<string, unknown> | null;
    if (
      !mutation ||
      !mutationKinds.has(mutation.kind as string) ||
      !str(mutation.targetId, 200) ||
      typeof mutation.fromMe !== "boolean"
    )
      return null;
    if (mutation.kind === "receipt") {
      if (mutation.fromMe !== true || !receiptStatus.has(mutation.status as string)) return null;
      inbound.mutation = {
        kind: "receipt",
        targetId: mutation.targetId as string,
        fromMe: true,
        status: mutation.status as "sent" | "delivered" | "read" | "failed"
      };
    } else
      inbound.mutation = {
        kind: mutation.kind as "edit" | "delete",
        targetId: mutation.targetId as string,
        fromMe: mutation.fromMe
      };
  }
  return inbound;
}

/** Accepts worker connections, authenticates them and tracks which business each one serves. */
export class LinkedWorkerHub {
  private server: Server | undefined;
  private readonly workers = new Map<string, LinkedAttachedWorker>();
  private readonly timeouts: typeof linkedWorkerTimeouts;
  private recheckTimer: ReturnType<typeof setInterval> | undefined;
  private readonly attachTtlMs: number;

  constructor(private readonly options: LinkedWorkerHubOptions) {
    this.timeouts = { ...linkedWorkerTimeouts, ...options.timeouts };
    this.attachTtlMs = options.attachTtlMs ?? 30_000;
  }

  async listen(config: {
    host: string;
    port: number;
    tls?: { cert: Buffer; key: Buffer };
  }): Promise<number> {
    const accept = (socket: Socket) => this.accept(socket);
    this.server = config.tls
      ? createTlsServer(
          { cert: config.tls.cert, key: config.tls.key, minVersion: "TLSv1.2" },
          accept
        )
      : createNetServer(accept);
    this.server.maxConnections = 256;
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(config.port, config.host, () => resolve());
    });
    this.recheckTimer = setInterval(() => void this.recheck(), this.options.recheckMs ?? 10_000);
    this.recheckTimer.unref?.();
    return (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    clearInterval(this.recheckTimer);
    for (const worker of this.workers.values()) worker.close();
    this.workers.clear();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve()
    );
  }

  /** The attached worker for a business, if it is connected to this host. */
  attached(businessId: string): LinkedAttachedWorker | undefined {
    const worker = this.workers.get(businessId);
    return worker && !worker.closed ? worker : undefined;
  }

  /** Closes a worker's connection now (revocation or rotation on this host). */
  disconnect(workerId: string, reason: "revoked" | "closed" = "revoked"): void {
    for (const worker of this.workers.values())
      if (worker.workerId === workerId) worker.close(reason);
  }

  /** Revalidates every attached worker and renews its attachment claim. */
  async recheck(): Promise<void> {
    await Promise.all(
      [...this.workers.values()].map(async (worker) => {
        if (worker.closed) return;
        let valid = false;
        try {
          valid = await this.options.registry.stillValid(worker.workerId, worker.credentialVersion);
          if (valid) {
            const record = await this.options.registry.activeForBusiness(worker.businessId);
            if (record) this.options.authorize(record.businessId, record.ownerId);
            valid =
              record?.id === worker.workerId &&
              (await this.options.registry.attach(
                worker.workerId,
                worker.credentialVersion,
                this.options.holderId,
                this.options.holderUrl,
                this.attachTtlMs
              ));
          }
        } catch {
          valid = false; // Cannot confirm authority: stop carrying the session.
        }
        if (!valid) worker.close("revoked");
      })
    );
  }

  private refuse(connection: LinkedFrameConnection, code: LinkedWorkerRefusal, workerId?: string) {
    this.options.log?.({
      event: "whatsapp_linked.remote_worker",
      action: "refused",
      reason: code,
      ...(workerId ? { workerId } : {})
    });
    connection.sendPlain({ type: "refused", code });
    // Let the refusal flush before closing.
    connection.socket.end();
    setTimeout(() => connection.close("refused"), 200).unref?.();
  }

  private accept(socket: Socket): void {
    const connection = new LinkedFrameConnection(socket, "hub", this.timeouts);
    const challenge = randomBytes(32).toString("base64url");
    let handled = false;
    const deadline = setTimeout(
      () => connection.close("handshake_timeout"),
      this.timeouts.handshake
    );
    deadline.unref?.();
    connection.onClose(() => clearTimeout(deadline));
    connection.onPlain((frame) => {
      if (handled) return connection.close("frame_invalid");
      handled = true;
      void this.hello(connection, challenge, frame).finally(() => clearTimeout(deadline));
    });
    connection.sendPlain({ type: "challenge", v: linkedWorkerProtocolVersion, nonce: challenge });
  }

  private async hello(
    connection: LinkedFrameConnection,
    challenge: string,
    frame: Record<string, unknown>
  ): Promise<void> {
    if (frame.type !== "hello") return this.refuse(connection, "handshake_invalid");
    if (frame.v !== linkedWorkerProtocolVersion)
      return this.refuse(connection, "version_unsupported");
    const { workerId, secret, nonce } = frame;
    if (
      frame.challenge !== challenge ||
      typeof workerId !== "string" ||
      typeof secret !== "string" ||
      typeof nonce !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(nonce) ||
      secret.length > 200
    )
      // A hello copied from another connection carries that connection's challenge.
      return this.refuse(connection, "handshake_invalid");
    let result;
    try {
      result = await this.options.registry.authenticate(workerId, secret);
    } catch {
      return this.refuse(connection, "hub_unavailable");
    }
    if ("refusal" in result) return this.refuse(connection, result.refusal, workerId);
    const { record } = result;
    try {
      this.options.authorize(record.businessId, record.ownerId);
    } catch {
      return this.refuse(connection, "owner_unauthorized", workerId);
    }
    if (connection.isClosed) return;
    // A restarted worker replaces its own stale connection on this host.
    const previous = this.workers.get(record.businessId);
    if (previous && !previous.closed) previous.close();
    let claimed: boolean;
    try {
      claimed = await this.options.registry.attach(
        record.id,
        record.credentialVersion,
        this.options.holderId,
        this.options.holderUrl,
        this.attachTtlMs
      );
    } catch {
      return this.refuse(connection, "hub_unavailable", workerId);
    }
    if (!claimed) return this.refuse(connection, "already_attached", workerId);
    if (connection.isClosed) {
      await this.options.registry.detach(record.id, this.options.holderId).catch(() => undefined);
      return;
    }
    connection.secure(linkedSessionKey(secret, challenge, nonce));
    const worker = new LinkedAttachedWorker(
      record.id,
      record.businessId,
      record.credentialVersion,
      connection,
      this.timeouts
    );
    this.workers.set(record.businessId, worker);
    connection.onClose((reason) => {
      if (this.workers.get(record.businessId) === worker) this.workers.delete(record.businessId);
      void this.options.registry.detach(record.id, this.options.holderId).catch(() => undefined);
      this.options.log?.({
        event: "whatsapp_linked.remote_worker",
        action: "detached",
        workerId: record.id,
        businessId: record.businessId,
        reason
      });
    });
    connection.send({
      type: "welcome",
      businessId: record.businessId,
      window: linkedWorkerInboundWindow
    } satisfies LinkedWorkerHubMessage);
    this.options.log?.({
      event: "whatsapp_linked.remote_worker",
      action: "attached",
      workerId: record.id,
      businessId: record.businessId
    });
    this.options.onAttach?.(record.businessId);
  }
}

/**
 * The connector's driver when remote workers are enabled. A business with an active enrolled
 * worker runs only on that worker: here when it is attached to this host, otherwise the open
 * fails with LinkedWorkerOffline and the session waits. Other businesses use the local driver.
 */
export function linkedDriverSelector(options: {
  local: LinkedDriver;
  hub: LinkedWorkerHub;
  registry: LinkedWorkerRegistry;
}): LinkedDriver {
  return {
    async open(input) {
      if (!input.businessId) return options.local.open(input);
      const attached = options.hub.attached(input.businessId);
      if (attached) {
        // Authority may have changed since attach (revoked from another host): check again.
        if (!(await options.registry.stillValid(attached.workerId, attached.credentialVersion))) {
          attached.close("revoked");
          throw new LinkedWorkerOffline();
        }
        return attached.open(input);
      }
      if (await options.registry.activeForBusiness(input.businessId))
        throw new LinkedWorkerOffline();
      return options.local.open(input);
    }
  };
}
