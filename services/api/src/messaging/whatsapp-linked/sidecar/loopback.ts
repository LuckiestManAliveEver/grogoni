import { createServer, type Server, type Socket } from "node:net";
import {
  FrameReader,
  helloTimeoutMs,
  parseClientFrame,
  sidecarProtocolVersion,
  tokenMatches,
  type ServerFrame,
  type SidecarIngressMessage,
  type SidecarMethod
} from "./protocol.js";
import { SidecarRequestError, toSidecarError, type SidecarRelay } from "./host.js";
import type { LinkedState } from "../connector.js";

export interface LoopbackOptions {
  token: string;
  handle: (method: SidecarMethod, params: Record<string, unknown>) => Promise<unknown>;
  /** How long an ingress event waits for the app's acknowledgement. */
  ackTimeoutMs?: number;
  /**
   * Unauthenticated connections held at once. When a new connection arrives with all of them in
   * use, the oldest unauthenticated one is closed to make room: a connection is never refused
   * for lack of a slot, so other apps cannot lock the Grogoni app out. Default 16.
   */
  maxPending?: number;
}

interface PendingAck {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The only listening socket the sidecar opens: 127.0.0.1, an ephemeral port, one authenticated
 * client at a time. Loopback is reachable by every app on the device, so the 256-bit per-start
 * token is the access control: a client that does not present it within two seconds, or sends
 * anything else first, is disconnected. A newer authenticated client replaces the older one (the
 * app reconnects after its own restart); in-flight ingress on the old one is rejected and stays
 * journaled.
 *
 * Slots: any local app can open connections, so holding every slot must not lock the Grogoni app
 * out. There is no connection cap that refuses newcomers; instead the oldest unauthenticated
 * connection is evicted when `maxPending` are waiting. The app sends its hello immediately after
 * connecting, so to keep it out another app would have to open `maxPending` connections in that
 * moment, every time; the app retries its connection anyway. Each waiting connection also has its
 * own two-second hello deadline.
 */
export class LoopbackServer implements SidecarRelay {
  private readonly server: Server;
  private client: Socket | undefined;
  /** Unauthenticated connections, oldest first (a Map keeps insertion order), and how to drop each. */
  private readonly waiting = new Map<Socket, (code: string) => void>();
  private seq = 0;
  private readonly acks = new Map<number, PendingAck>();

  constructor(private readonly options: LoopbackOptions) {
    // No `maxConnections`: a cap refuses the newcomer, which may be the Grogoni app itself.
    this.server = createServer({ noDelay: true }, (socket) => this.accept(socket));
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
        this.server.off("error", reject);
        const address = this.server.address();
        if (!address || typeof address === "string" || address.address !== "127.0.0.1")
          return reject(new Error("Loopback bind failed."));
        resolve(address.port);
      });
    });
  }

  connected(): boolean {
    return this.client !== undefined && !this.client.destroyed;
  }

  ingress(businessId: string, message: SidecarIngressMessage): Promise<void> {
    const client = this.client;
    if (!client || client.destroyed)
      return Promise.reject(
        new SidecarRequestError("relay_unavailable", "No app connection.", true)
      );
    const seq = ++this.seq;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.acks.delete(seq);
        reject(
          new SidecarRequestError("relay_timeout", "Grogoni did not confirm the message.", true)
        );
      }, this.options.ackTimeoutMs ?? 60_000);
      timer.unref?.();
      this.acks.set(seq, { resolve, reject, timer });
      this.send(client, { type: "ingress", seq, businessId, message });
    });
  }

  state(businessId: string, state: LinkedState): void {
    if (this.client && !this.client.destroyed)
      this.send(this.client, { type: "state", businessId, state });
  }

  close(): Promise<void> {
    this.client?.destroy();
    this.failAcks();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private failAcks(): void {
    for (const [seq, ack] of this.acks) {
      clearTimeout(ack.timer);
      ack.reject(new SidecarRequestError("relay_unavailable", "App connection closed.", true));
      this.acks.delete(seq);
    }
  }

  private send(socket: Socket, frame: ServerFrame): void {
    if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
  }

  private accept(socket: Socket): void {
    // Defence in depth: the listener is bound to 127.0.0.1, so a remote peer is impossible.
    if (socket.remoteAddress !== "127.0.0.1") {
      socket.destroy();
      return;
    }
    const max = Math.max(1, this.options.maxPending ?? 16);
    while (this.waiting.size >= max) {
      const [oldest, evict] = this.waiting.entries().next().value!;
      this.waiting.delete(oldest);
      evict("evicted");
    }
    socket.setEncoding("utf8");
    const reader = new FrameReader();
    let authenticated = false;
    const uncount = () => {
      this.waiting.delete(socket);
    };
    const refuse = (code: string) => {
      uncount();
      this.send(socket, { type: "error", code });
      socket.end();
      socket.destroy();
    };
    this.waiting.set(socket, refuse);
    const hello = setTimeout(() => refuse("hello_timeout"), helloTimeoutMs);
    hello.unref?.();
    socket.on("data", (chunk: string) => {
      const lines = reader.push(chunk);
      if (lines === null) return refuse("frame_too_large");
      for (const line of lines) {
        const frame = parseClientFrame(line);
        if (!frame) return refuse("invalid_frame");
        if (!authenticated) {
          if (frame.type !== "hello" || !tokenMatches(this.options.token, frame.token))
            return refuse("unauthorized");
          authenticated = true;
          clearTimeout(hello);
          uncount();
          const previous = this.client;
          this.client = socket;
          if (previous && previous !== socket) {
            this.failAcks();
            previous.destroy();
          }
          this.send(socket, {
            type: "welcome",
            protocol: sidecarProtocolVersion,
            node: process.version,
            pid: process.pid
          });
          continue;
        }
        if (frame.type === "hello") return refuse("invalid_frame");
        if (frame.type === "ack") {
          const ack = this.acks.get(frame.seq);
          if (!ack) continue;
          this.acks.delete(frame.seq);
          clearTimeout(ack.timer);
          if (frame.ok) ack.resolve();
          else
            ack.reject(
              new SidecarRequestError("relay_rejected", "Grogoni refused the message.", true)
            );
          continue;
        }
        const { id, method, params } = frame;
        void this.options.handle(method, params).then(
          (result) => this.send(socket, { type: "response", id, ok: true, result: result ?? null }),
          (error: unknown) =>
            this.send(socket, { type: "response", id, ok: false, error: toSidecarError(error) })
        );
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      clearTimeout(hello);
      uncount();
      if (this.client === socket) {
        this.client = undefined;
        this.failAcks();
      }
    });
  }
}
