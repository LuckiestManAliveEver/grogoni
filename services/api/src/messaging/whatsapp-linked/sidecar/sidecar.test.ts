import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LinkedDriver, LinkedInbound } from "../connector.js";
import { LinkedSessionVault } from "../vault.js";
import { parseSidecarConfig, runSidecar, type SidecarHandle } from "./main.js";
import { FrameReader, maxFrameBytes, parseClientFrame, tokenMatches } from "./protocol.js";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
const businessId = "biz_sidecar_1";
const chat = "254700000001@s.whatsapp.net";
const hex = () => randomBytes(32).toString("hex");

function mockDriver() {
  const opens: Parameters<LinkedDriver["open"]>[0][] = [];
  const socket = {
    pairingCode: vi.fn(async () => "PAIR1234"),
    groups: vi.fn(async () => [{ chat: "12345678@g.us", name: "Shop group" }]),
    send: vi.fn(async (_chat: string, _text: string, id: string) => id),
    close: vi.fn(),
    logout: vi.fn(async () => undefined),
    downloadMedia: vi.fn(async () => Buffer.from("never"))
  };
  const driver: LinkedDriver = {
    open: vi.fn(async (input) => {
      opens.push(input);
      return socket;
    })
  };
  return { driver, socket, opens, last: () => opens[opens.length - 1]! };
}

class Client {
  private readonly frames: Record<string, unknown>[] = [];
  private readonly waiters: Array<() => void> = [];
  private id = 0;
  closed = false;
  constructor(readonly socket: Socket) {
    const reader = new FrameReader();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      for (const line of reader.push(chunk) ?? []) this.frames.push(JSON.parse(line));
      this.waiters.splice(0).forEach((wake) => wake());
    });
    socket.on("close", () => {
      this.closed = true;
      this.waiters.splice(0).forEach((wake) => wake());
    });
  }
  static async open(port: number): Promise<Client> {
    const socket = connect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) =>
      socket.once("connect", resolve).once("error", reject)
    );
    return new Client(socket);
  }
  write(frame: unknown) {
    this.socket.write(`${JSON.stringify(frame)}\n`);
  }
  async next(match: (frame: Record<string, unknown>) => boolean, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.frames.findIndex(match);
      if (index >= 0) return this.frames.splice(index, 1)[0]!;
      if (this.closed) throw new Error("connection closed");
      if (Date.now() > deadline) throw new Error("frame timeout");
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }
  has(match: (frame: Record<string, unknown>) => boolean) {
    return this.frames.some(match);
  }
  async call(method: string, params: Record<string, unknown> = {}) {
    const id = ++this.id;
    this.write({ type: "request", id, method, params });
    return (await this.next((frame) => frame.type === "response" && frame.id === id)) as {
      ok: boolean;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions read arbitrary result shapes
      result?: any;
      error?: { code: string; message: string };
    };
  }
  close() {
    this.socket.destroy();
  }
}

interface Started {
  sidecar: SidecarHandle;
  input: PassThrough;
  token: string;
  ready: Record<string, unknown>;
}

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function tempVault() {
  const root = mkdtempSync(join(tmpdir(), "wa-sidecar-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "vault");
}

async function start(
  driver: LinkedDriver,
  options: { vaultDir?: string; key?: string; ownerId?: string; ackTimeoutMs?: number } = {}
): Promise<Started> {
  const input = new PassThrough();
  const output = new PassThrough();
  const token = hex();
  const lines: string[] = [];
  output.on("data", (chunk: Buffer) => lines.push(...chunk.toString().split("\n").filter(Boolean)));
  input.write(
    `${JSON.stringify({
      protocol: 1,
      token,
      key: options.key ?? hex(),
      vaultDir: options.vaultDir ?? tempVault(),
      ownerId: options.ownerId ?? "acct_owner"
    })}\n`
  );
  const sidecar = await runSidecar({
    input,
    output,
    driver,
    probe: async () => ({ protocolLoaded: true }),
    ...(options.ackTimeoutMs ? { ackTimeoutMs: options.ackTimeoutMs } : {})
  });
  cleanup.push(() => sidecar.stop());
  await settle();
  return { sidecar, input, token, ready: JSON.parse(lines[0]!) };
}

async function authenticated(started: Started) {
  const client = await Client.open(started.sidecar.port);
  cleanup.push(() => client.close());
  client.write({ type: "hello", token: started.token, protocol: 1 });
  await client.next((frame) => frame.type === "welcome");
  return client;
}

/** Pairs, lets the mocked WhatsApp approve, and approves one chat. */
async function linked(started: Started, mock: ReturnType<typeof mockDriver>, client: Client) {
  const pairing = await client.call("connect", { businessId, phone: "254700000009" });
  expect(pairing.ok).toBe(true);
  expect(pairing.result.state).toBe("PAIRING");
  expect(pairing.result.pairingCode).toBe("PAIR1234");
  mock.last().save(JSON.stringify({ creds: { registered: true } }));
  mock.last().state("open");
  await client.next((frame) => frame.type === "state" && frame.state === "CONNECTED");
  const approved = await client.call("approve", { businessId, chat, conversationId: "conv_1" });
  expect(approved.ok, JSON.stringify(approved)).toBe(true);
}

const inbound = (overrides: Partial<LinkedInbound> = {}): LinkedInbound => ({
  id: `MSG${Math.random().toString(16).slice(2, 10)}`,
  chat,
  sender: chat,
  text: "Do you have maize flour?",
  timestamp: new Date().toISOString(),
  fromMe: false,
  mentioned: false,
  ...overrides
});

function journal(vaultDir: string, key: string) {
  const vault = new LinkedSessionVault(vaultDir, Buffer.from(key, "hex"));
  const raw = vault.read(businessId);
  return raw
    ? (JSON.parse(raw) as {
        inbox: LinkedInbound[];
        scopes: { chat: string }[];
        auth: string | null;
      })
    : null;
}

describe("sidecar protocol", () => {
  it("parses only well-formed frames and bounds frame size", () => {
    expect(parseClientFrame('{"type":"hello","token":"x","protocol":1}')).toEqual({
      type: "hello",
      token: "x",
      protocol: 1
    });
    expect(parseClientFrame('{"type":"hello","token":"x","protocol":2}')).toBeNull();
    expect(parseClientFrame('{"type":"request","id":1,"method":"eval","params":{}}')).toBeNull();
    expect(parseClientFrame('{"type":"request","id":-1,"method":"status"}')).toBeNull();
    expect(parseClientFrame("[1]")).toBeNull();
    expect(parseClientFrame("not json")).toBeNull();
    const reader = new FrameReader(16);
    expect(reader.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(reader.push(":2}\n")).toEqual(['{"b":2}']);
    expect(new FrameReader(16).push("x".repeat(17))).toBeNull();
    expect(maxFrameBytes).toBeGreaterThan(4000 * 6);
  });

  it("compares tokens in constant time over digests", () => {
    const token = hex();
    expect(tokenMatches(token, token)).toBe(true);
    expect(tokenMatches(token, token.slice(0, 63))).toBe(false);
    expect(tokenMatches(token, undefined)).toBe(false);
  });

  it("refuses unsafe start-up configuration", () => {
    const base = { protocol: 1, token: hex(), key: hex(), vaultDir: "/data/x", ownerId: "acct_1" };
    expect(parseSidecarConfig(JSON.stringify(base)).ownerId).toBe("acct_1");
    for (const bad of [
      { ...base, protocol: 2 },
      { ...base, token: "short" },
      { ...base, key: base.token },
      { ...base, key: base.key.toUpperCase() },
      { ...base, vaultDir: "relative/vault" },
      { ...base, ownerId: "../escape" }
    ])
      expect(() => parseSidecarConfig(JSON.stringify(bad))).toThrow();
  });
});

describe("sidecar loopback handshake", () => {
  it("binds 127.0.0.1 only and announces the port on stdout", async () => {
    const started = await start(mockDriver().driver);
    expect(started.ready).toMatchObject({ type: "ready", protocol: 1 });
    expect(started.ready.port).toBe(started.sidecar.port);
    const client = await authenticated(started);
    expect(client.socket.remoteAddress).toBe("127.0.0.1");
  });

  it("disconnects a client with the wrong token, a non-hello first frame or no hello", async () => {
    const started = await start(mockDriver().driver);
    const wrong = await Client.open(started.sidecar.port);
    wrong.write({ type: "hello", token: hex(), protocol: 1 });
    expect(await wrong.next((frame) => frame.type === "error")).toEqual({
      type: "error",
      code: "unauthorized"
    });
    await vi.waitFor(() => expect(wrong.closed).toBe(true));

    const early = await Client.open(started.sidecar.port);
    early.write({ type: "request", id: 1, method: "status", params: { businessId } });
    expect((await early.next((frame) => frame.type === "error")).code).toBe("unauthorized");
    expect(early.has((frame) => frame.type === "response")).toBe(false);

    const silent = await Client.open(started.sidecar.port);
    expect((await silent.next((frame) => frame.type === "error", 3500)).code).toBe("hello_timeout");
    await vi.waitFor(() => expect(silent.closed).toBe(true));
  });

  it("never locks the app out when another local app holds every unauthenticated slot", async () => {
    const started = await start(mockDriver().driver);
    // Another app on the phone opens connections and never says hello.
    const squatters: Client[] = [];
    for (let i = 0; i < 16; i++) {
      const squatter = await Client.open(started.sidecar.port);
      cleanup.push(() => squatter.close());
      squatters.push(squatter);
    }
    await settle();
    expect(squatters.every((squatter) => !squatter.closed)).toBe(true);
    // The Grogoni app still gets in: the oldest waiting connection is evicted for it.
    const app = await authenticated(started);
    expect((await app.call("status", { businessId })).result.state).toBe("DISCONNECTED");
    expect((await squatters[0]!.next((frame) => frame.type === "error")).code).toBe("evicted");
    await vi.waitFor(() => expect(squatters[0]!.closed).toBe(true));
    // Refilling the slots while the app is connected does not block its reconnect either.
    for (let i = 0; i < 16; i++) {
      const squatter = await Client.open(started.sidecar.port);
      cleanup.push(() => squatter.close());
    }
    const reconnected = await authenticated(started);
    await vi.waitFor(() => expect(app.closed).toBe(true));
    expect((await reconnected.call("status", { businessId })).result.state).toBe("DISCONNECTED");
  });

  it("lets a newer authenticated client replace the old one", async () => {
    const started = await start(mockDriver().driver);
    const first = await authenticated(started);
    const second = await authenticated(started);
    await vi.waitFor(() => expect(first.closed).toBe(true));
    expect((await second.call("status", { businessId })).result.state).toBe("DISCONNECTED");
  });

  it("exits when the app closes stdin", async () => {
    const started = await start(mockDriver().driver);
    started.input.end();
    await started.sidecar.done;
    await expect(Client.open(started.sidecar.port)).rejects.toThrow();
  });
});

describe("sidecar connector host", () => {
  it("pairs with a code and keeps the vault encrypted in a private directory", async () => {
    const mock = mockDriver();
    const vaultDir = tempVault();
    const key = hex();
    const started = await start(mock.driver, { vaultDir, key });
    const client = await authenticated(started);
    await linked(started, mock, client);
    expect(statSync(vaultDir).mode & 0o777).toBe(0o700);
    for (const name of readdirSync(vaultDir).filter((entry) => entry.endsWith(".session"))) {
      expect(statSync(join(vaultDir, name)).mode & 0o777).toBe(0o600);
      expect(name).not.toContain(businessId);
    }
    expect(journal(vaultDir, key)?.scopes.map((scope) => scope.chat)).toEqual([chat]);
    expect(() => journal(vaultDir, hex())).toThrow();
  });

  it("forwards approved-chat ingress and clears the journal only after the app acknowledges", async () => {
    const mock = mockDriver();
    const vaultDir = tempVault();
    const key = hex();
    const started = await start(mock.driver, { vaultDir, key });
    const client = await authenticated(started);
    await linked(started, mock, client);

    mock.last().inbound(inbound({ chat: "254700000002@s.whatsapp.net" }));
    const message = inbound();
    mock.last().inbound(message);
    const event = await client.next((frame) => frame.type === "ingress");
    expect(event).toMatchObject({
      businessId,
      message: { id: message.id, chat, text: message.text }
    });
    expect(JSON.stringify(event)).not.toContain("fromMe");
    expect(journal(vaultDir, key)?.inbox).toHaveLength(1);
    client.write({ type: "ack", seq: event.seq, ok: true });
    await vi.waitFor(() => expect(journal(vaultDir, key)?.inbox).toHaveLength(0));
    await settle();
    expect(client.has((frame) => frame.type === "ingress")).toBe(false);
  });

  it("keeps a refused event journaled and reconnects instead of dropping it", async () => {
    const mock = mockDriver();
    const vaultDir = tempVault();
    const key = hex();
    const started = await start(mock.driver, { vaultDir, key });
    const client = await authenticated(started);
    await linked(started, mock, client);
    const message = inbound();
    mock.last().inbound(message);
    const event = await client.next((frame) => frame.type === "ingress");
    client.write({ type: "ack", seq: event.seq, ok: false });
    await client.next((frame) => frame.type === "state" && frame.state === "RECONNECTING");
    expect(journal(vaultDir, key)?.inbox.map((entry) => entry.id)).toEqual([message.id]);
  });

  it("strips media before the connector can download it", async () => {
    const mock = mockDriver();
    const started = await start(mock.driver);
    const client = await authenticated(started);
    await linked(started, mock, client);
    mock.last().inbound(
      inbound({
        text: "Invoice attached",
        media: [
          {
            type: "document",
            mimeType: "application/pdf",
            filename: "invoice.pdf",
            size: 10,
            directPath: "/x",
            key: "k",
            sha256: "s"
          }
        ]
      })
    );
    const event = await client.next((frame) => frame.type === "ingress");
    expect((event.message as { text: string }).text).toContain("forwards text only");
    expect(mock.socket.downloadMedia).not.toHaveBeenCalled();
  });

  it("sends outbound text once per idempotency key", async () => {
    const mock = mockDriver();
    const started = await start(mock.driver);
    const client = await authenticated(started);
    await linked(started, mock, client);
    const request = {
      businessId,
      chat,
      conversationId: "conv_1",
      text: "Yes, 2kg is 180 KES.",
      idempotencyKey: "reply-1"
    };
    const first = await client.call("send", request);
    const second = await client.call("send", request);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(second.result.providerMessageId).toBe(first.result.providerMessageId);
    expect(mock.socket.send).toHaveBeenCalledTimes(1);
    const unapproved = await client.call("send", {
      ...request,
      chat: "254700000003@s.whatsapp.net",
      idempotencyKey: "r2"
    });
    expect(unapproved).toMatchObject({ ok: false, error: { code: "CHANNEL_UNAVAILABLE" } });
    const reused = await client.call("send", { ...request, text: "Different" });
    expect(reused.ok).toBe(false);
    expect(mock.socket.send).toHaveBeenCalledTimes(1);
  });

  it("reports outbox outcomes from the journal and never resends an uncertain delivery", async () => {
    const mock = mockDriver();
    const vaultDir = tempVault();
    const key = hex();
    const started = await start(mock.driver, { vaultDir, key });
    const client = await authenticated(started);
    await linked(started, mock, client);
    const request = {
      businessId,
      chat,
      conversationId: "conv_1",
      text: "Karibu!",
      idempotencyKey: "outbox-1",
      quotedMessage: { id: "3EB0Q1", sender: chat, fromMe: false, text: "Hello?" }
    };
    const sent = await client.call("deliver", request);
    expect(sent.result).toEqual({ outcome: "sent", deliveredId: expect.any(String) });
    expect(mock.socket.send).toHaveBeenLastCalledWith(
      chat,
      "Karibu!",
      expect.any(String),
      undefined,
      request.quotedMessage
    );
    // A re-offer of the same claim (the ack was lost) returns the stored id without sending.
    expect((await client.call("deliver", request)).result).toEqual(sent.result);
    expect(mock.socket.send).toHaveBeenCalledTimes(1);

    // WhatsApp took the message but the answer never came: uncertain, then never sent again.
    mock.socket.send.mockRejectedValueOnce(new Error("socket closed"));
    const lost = { ...request, idempotencyKey: "outbox-2", quotedMessage: undefined };
    expect((await client.call("deliver", lost)).result).toEqual({
      outcome: "uncertain",
      code: "WHATSAPP_DELIVERY_UNCERTAIN"
    });
    expect((await client.call("deliver", lost)).result.outcome).toBe("uncertain");
    expect(mock.socket.send).toHaveBeenCalledTimes(2);

    // Refused before anything reached WhatsApp: failed, not retryable for an unapproved chat.
    expect(
      (
        await client.call("deliver", {
          ...lost,
          chat: "254700000003@s.whatsapp.net",
          idempotencyKey: "outbox-3"
        })
      ).result
    ).toEqual({ outcome: "failed", code: "CHANNEL_UNAVAILABLE", retryable: false });
    // A reconnecting session is worth retrying from the outbox.
    mock.last().state("close", "retry");
    await client.next((frame) => frame.type === "state" && frame.state === "RECONNECTING");
    expect((await client.call("deliver", { ...lost, idempotencyKey: "outbox-4" })).result).toEqual({
      outcome: "failed",
      code: "CHANNEL_UNAVAILABLE",
      retryable: true
    });
    expect(mock.socket.send).toHaveBeenCalledTimes(2);
    expect(
      (await client.call("deliver", { ...request, quotedMessage: { id: "../x" } })).error?.code
    ).toBe("invalid_request");
  });

  it("sends read receipts only for approved chats on the connected session", async () => {
    const mock = mockDriver();
    const markRead = vi.fn(async (_chat: string, keys: unknown[]) => keys.length);
    Object.assign(mock.socket, { markRead });
    const started = await start(mock.driver);
    const client = await authenticated(started);
    await linked(started, mock, client);
    const keys = [
      { id: "3EB0R1", sender: chat },
      { id: "3EB0R2", sender: chat }
    ];
    expect((await client.call("markRead", { businessId, chat, keys })).result).toEqual({ sent: 2 });
    expect(markRead).toHaveBeenCalledWith(chat, keys);
    expect(
      (
        await client.call("markRead", {
          businessId,
          chat: "254700000003@s.whatsapp.net",
          keys
        })
      ).result
    ).toEqual({ sent: 0 });
    expect(markRead).toHaveBeenCalledTimes(1);
    for (const bad of [[], [{ id: "x y", sender: chat }], [{ id: "A1", sender: "someone" }]])
      expect((await client.call("markRead", { businessId, chat, keys: bad })).error?.code).toBe(
        "invalid_request"
      );
  });

  it("restores the linked session from the vault after a restart with the same key", async () => {
    const mock = mockDriver();
    const vaultDir = tempVault();
    const key = hex();
    const first = await start(mock.driver, { vaultDir, key });
    await linked(first, mock, await authenticated(first));
    await first.sidecar.stop();

    const restarted = mockDriver();
    const second = await start(restarted.driver, { vaultDir, key });
    await vi.waitFor(() => expect(restarted.opens).toHaveLength(1));
    expect(restarted.last().auth).toContain("registered");
    const client = await authenticated(second);
    const status = await client.call("status", { businessId });
    expect(status.result.scopes).toEqual([{ chat, conversationId: "conv_1", automation: false }]);
  });

  it("refuses to start with the wrong vault key instead of wiping the session", async () => {
    const mock = mockDriver();
    const vaultDir = tempVault();
    const key = hex();
    const first = await start(mock.driver, { vaultDir, key });
    await linked(first, mock, await authenticated(first));
    await first.sidecar.stop();
    await expect(start(mockDriver().driver, { vaultDir })).rejects.toThrow();
    expect(journal(vaultDir, key)?.auth).toContain("registered");
  });

  it("never opens another owner's session and erases a business the API denied", async () => {
    const mock = mockDriver();
    const vaultDir = tempVault();
    const key = hex();
    const owner = await start(mock.driver, { vaultDir, key });
    const client = await authenticated(owner);
    await linked(owner, mock, client);
    const denied = await client.call("deny", { businessId });
    expect(denied.ok).toBe(true);
    expect(mock.socket.logout).toHaveBeenCalled();
    expect(journal(vaultDir, key)).toBeNull();
    const after = await client.call("status", { businessId });
    expect(after).toMatchObject({ ok: false, error: { code: "owner_not_enrolled" } });
  });

  it("refuses a vault that holds another owner's session and leaves it intact", async () => {
    const mock = mockDriver();
    const vaultDir = tempVault();
    const key = hex();
    const first = await start(mock.driver, { vaultDir, key });
    await linked(first, mock, await authenticated(first));
    await first.sidecar.stop();
    const other = mockDriver();
    await expect(start(other.driver, { vaultDir, key, ownerId: "acct_other" })).rejects.toThrow(
      "another Grogoni account"
    );
    expect(other.opens).toHaveLength(0);
    expect(journal(vaultDir, key)?.auth).toContain("registered");
  });

  it("round-trips the self-check record across restarts and only with the same key", async () => {
    const vaultDir = tempVault();
    const key = hex();
    const first = await start(mockDriver().driver, { vaultDir, key });
    const canary = `canary-${hex().slice(0, 16)}`;
    expect((await (await authenticated(first)).call("vaultCheck", { write: canary })).ok).toBe(
      true
    );
    await first.sidecar.stop();
    for (const name of readdirSync(vaultDir))
      expect((await import("node:fs")).readFileSync(join(vaultDir, name)).includes(canary)).toBe(
        false
      );
    const second = await start(mockDriver().driver, { vaultDir, key });
    expect((await (await authenticated(second)).call("vaultCheck")).result).toEqual({
      value: canary
    });
    await second.sidecar.stop();
    const wrong = await start(mockDriver().driver, { vaultDir });
    expect((await (await authenticated(wrong)).call("vaultCheck")).ok).toBe(false);
  });

  it("validates request parameters before touching the connector", async () => {
    const started = await start(mockDriver().driver);
    const client = await authenticated(started);
    expect((await client.call("connect", { businessId, phone: "+254 700" })).error?.code).toBe(
      "phone_invalid"
    );
    expect((await client.call("status", { businessId: "../x" })).error?.code).toBe(
      "invalid_request"
    );
    expect(
      (await client.call("approve", { businessId, chat: "bad", conversationId: "c" })).error?.code
    ).toBe("whatsapp_chat_invalid");
    expect((await client.call("probe")).result).toEqual({ protocolLoaded: true });
  });
});
