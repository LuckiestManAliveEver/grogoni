import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  linkedWorkerInboundQueueLimit,
  linkedWorkerProtocolVersion,
  parseLinkedWorkerCredential
} from "@grogoni/shared-types";
import type { LinkedDriver, LinkedInbound } from "./connector.js";
import { LinkedWorkerOffline } from "./connector.js";
import {
  LinkedWorkerHub,
  linkedDriverSelector,
  linkedHubListenFromEnvironment,
  parseRemoteInbound
} from "./remote-driver.js";
import { LinkedRemoteWorker, parseLinkedHubUrl } from "./remote-worker.js";
import { linkedSessionKey, sealLinkedFrame } from "./remote-transport.js";
import { MemoryLinkedWorkerRegistry, formatLinkedWorkerCredential } from "./worker-registry.js";

const BUSINESS = "business-remote";
const OWNER = "owner-remote";
const CHAT = "254711111111@s.whatsapp.net";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const until = async (check: () => boolean, ms = 3_000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const inbound = (id: string): LinkedInbound => ({
  id,
  chat: CHAT,
  sender: CHAT,
  text: `message ${id}`,
  timestamp: new Date(0).toISOString(),
  fromMe: false,
  mentioned: false
});

/** A worker-side mock driver whose socket records every call. */
function mockDriver() {
  const calls: string[] = [];
  let input: Parameters<LinkedDriver["open"]>[0] | undefined;
  const driver: LinkedDriver = {
    open: vi.fn(async (next) => {
      input = next;
      calls.push(`open:${next.auth}`);
      return {
        pairingCode: async (phone: string) => `CODE-${phone.slice(-4)}`,
        groups: async () => [{ chat: "123456789@g.us", name: "Group" }],
        send: async (chat: string, text: string, id: string) => {
          calls.push(`send:${chat}:${text}`);
          return `wa-${id}`;
        },
        downloadMedia: async () => Buffer.from("media-bytes"),
        logout: async () => {
          calls.push("logout");
        },
        close: () => calls.push("close")
      };
    })
  };
  return { driver, calls, input: () => input! };
}

async function fixture(
  options: { authorize?: (businessId: string, ownerId: string) => void } = {}
) {
  const registry = new MemoryLinkedWorkerRegistry();
  const onAttach = vi.fn();
  const hub = new LinkedWorkerHub({
    registry,
    authorize: options.authorize ?? (() => undefined),
    holderId: "api-1",
    holderUrl: "http://127.0.0.1:1",
    onAttach,
    recheckMs: 60_000
  });
  const port = await hub.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(() => hub.stop());
  const issued = await registry.enroll({
    businessId: BUSINESS,
    ownerId: OWNER,
    label: "test worker",
    ttlMs: 86_400_000
  });
  const credential = formatLinkedWorkerCredential(issued.record.id, issued.secret);
  const startWorker = (driver: LinkedDriver, value = credential) => {
    const worker = new LinkedRemoteWorker({
      hubUrl: `tcp://127.0.0.1:${port}`,
      credential: value,
      driver,
      reconnect: { minMs: 50, maxMs: 200 }
    });
    worker.start();
    cleanups.push(() => worker.stop());
    return worker;
  };
  const localDriver: LinkedDriver = { open: vi.fn(async () => ({}) as never) };
  const selector = linkedDriverSelector({ local: localDriver, hub, registry });
  return { registry, hub, port, issued, credential, startWorker, selector, localDriver, onAttach };
}

function hostInput() {
  const events: string[] = [];
  const received: LinkedInbound[] = [];
  const saved: string[] = [];
  const input: Parameters<LinkedDriver["open"]>[0] = {
    businessId: BUSINESS,
    auth: "AUTH-1",
    approvedContacts: () => [CHAT],
    save: (auth) => saved.push(auth),
    state: (state, reason) => events.push(reason ? `${state}:${reason}` : state),
    inbound: (message) => received.push(message)
  };
  return { input, events, received, saved };
}

describe("remote connector worker transport", () => {
  it("runs every driver callback and socket method across the process boundary", async () => {
    const f = await fixture();
    const worker = mockDriver();
    f.startWorker(worker.driver);
    await until(() => f.hub.attached(BUSINESS) !== undefined);
    expect(f.onAttach).toHaveBeenCalledWith(BUSINESS);
    const host = hostInput();
    const socket = await f.selector.open(host.input);
    expect(worker.calls).toContain("open:AUTH-1");
    expect(worker.input().businessId).toBe(BUSINESS);
    expect(worker.input().approvedContacts?.()).toEqual([CHAT]);

    worker.input().save("AUTH-2");
    worker.input().state("open");
    worker.input().inbound(inbound("m1"));
    await until(() => host.received.length === 1 && host.events.includes("open"));
    expect(host.saved).toEqual(["AUTH-2"]);
    expect(host.received[0]!.id).toBe("m1");

    expect(await socket.pairingCode("254700001234")).toBe("CODE-1234");
    expect(await socket.groups!()).toEqual([{ chat: "123456789@g.us", name: "Group" }]);
    expect(await socket.send(CHAT, "hi", "ID1")).toBe("wa-ID1");
    expect(worker.calls).toContain(`send:${CHAT}:hi`);
    const media = await socket.downloadMedia!(
      {
        type: "document",
        mimeType: "application/pdf",
        filename: "a.pdf",
        size: 11,
        directPath: "/x",
        key: "k",
        sha256: "s"
      },
      new AbortController().signal
    );
    expect(media.toString()).toBe("media-bytes");
    await socket.logout();
    expect(worker.calls).toContain("logout");
    socket.close();
    await until(() => worker.calls.includes("close"));
  });

  it("keeps a session off the local driver while its enrolled worker is offline", async () => {
    const f = await fixture();
    await expect(f.selector.open(hostInput().input)).rejects.toBeInstanceOf(LinkedWorkerOffline);
    expect(f.localDriver.open).not.toHaveBeenCalled();
    // A business without an enrolled worker still uses the local driver.
    await f.selector.open({ ...hostInput().input, businessId: "other-business" });
    expect(f.localDriver.open).toHaveBeenCalledTimes(1);
  });

  it("reports a retryable close to the connector when the worker process goes away", async () => {
    const f = await fixture();
    const worker = mockDriver();
    const process = f.startWorker(worker.driver);
    await until(() => f.hub.attached(BUSINESS) !== undefined);
    const host = hostInput();
    const socket = await f.selector.open(host.input);
    process.stop();
    await until(() => host.events.includes("close:retry"));
    await expect(socket.send(CHAT, "x", "ID2")).rejects.toThrow(/closed|disconnected/i);
  });

  it("applies back-pressure: a bounded window of unacknowledged inbound, then a retryable close", async () => {
    const f = await fixture();
    const worker = mockDriver();
    f.startWorker(worker.driver);
    await until(() => f.hub.attached(BUSINESS) !== undefined);
    const host = hostInput();
    // A hub whose connector is stuck never returns from inbound: model it by swallowing acks.
    let blocked = true;
    const attached = f.hub.attached(BUSINESS)!;
    const send = (attached as unknown as { connection: { send: (m: unknown) => boolean } })
      .connection;
    const original = send.send.bind(send);
    send.send = (message: unknown) =>
      blocked && (message as { type?: string }).type === "ack" ? true : original(message);
    await f.selector.open(host.input);
    for (let index = 0; index < linkedWorkerInboundQueueLimit; index++)
      worker.input().inbound(inbound(`b${index}`));
    await until(() => host.received.length === 16);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Only the window is in flight; the rest waits in the worker's bounded queue.
    expect(host.received).toHaveLength(16);
    // The queue is full: one more event closes the WhatsApp socket instead of dropping it.
    worker.input().inbound(inbound("overflow"));
    await until(() => host.events.includes("close:retry"));
    expect(worker.calls).toContain("close");
    blocked = false;
  });

  it("refuses a revoked, rotated, expired or wrong credential and a worker whose owner lost the business", async () => {
    let authorized = true;
    const f = await fixture({
      authorize: () => {
        if (!authorized) throw new Error("not the owner");
      }
    });
    const wrong = formatLinkedWorkerCredential(f.issued.record.id, "A".repeat(43));
    const refused = f.startWorker(mockDriver().driver, wrong);
    expect(await refused.finished).toBe("credential_invalid");

    authorized = false;
    expect(await f.startWorker(mockDriver().driver).finished).toBe("owner_unauthorized");
    authorized = true;

    const live = f.startWorker(mockDriver().driver);
    await until(() => f.hub.attached(BUSINESS) !== undefined);
    const rotated = await f.registry.rotate({
      businessId: BUSINESS,
      workerId: f.issued.record.id,
      ownerId: OWNER,
      ttlMs: 86_400_000
    });
    // Another host rotated it: the periodic re-check closes the old credential's connection.
    await f.hub.recheck();
    expect(await live.finished).toBe("credential_revoked");
    expect(await f.startWorker(mockDriver().driver).finished).toBe("credential_invalid");

    const fresh = f.startWorker(
      mockDriver().driver,
      formatLinkedWorkerCredential(f.issued.record.id, rotated!.secret)
    );
    await until(() => f.hub.attached(BUSINESS) !== undefined);
    await f.registry.revoke(BUSINESS, f.issued.record.id);
    f.hub.disconnect(f.issued.record.id);
    expect(await fresh.finished).toBe("credential_revoked");
    expect(
      await f.startWorker(
        mockDriver().driver,
        formatLinkedWorkerCredential(f.issued.record.id, rotated!.secret)
      ).finished
    ).toBe("credential_revoked");
  });

  it("refuses an expired credential", async () => {
    let now = 1_000_000;
    const registry = new MemoryLinkedWorkerRegistry(() => now);
    const hub = new LinkedWorkerHub({
      registry,
      authorize: () => undefined,
      holderId: "api-1",
      holderUrl: null
    });
    const port = await hub.listen({ host: "127.0.0.1", port: 0 });
    cleanups.push(() => hub.stop());
    const issued = await registry.enroll({
      businessId: BUSINESS,
      ownerId: OWNER,
      label: "w",
      ttlMs: 1_000
    });
    now += 1_001;
    const worker = new LinkedRemoteWorker({
      hubUrl: `tcp://127.0.0.1:${port}`,
      credential: formatLinkedWorkerCredential(issued.record.id, issued.secret),
      driver: mockDriver().driver
    });
    worker.start();
    cleanups.push(() => worker.stop());
    expect(await worker.finished).toBe("credential_expired");
  });

  it("refuses a second attachment of one worker on another host", async () => {
    const f = await fixture();
    await f.registry.attach(f.issued.record.id, 1, "api-2", "http://127.0.0.1:2", 60_000);
    const worker = f.startWorker(mockDriver().driver);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(f.hub.attached(BUSINESS)).toBeUndefined();
    worker.stop();
  });
});

/** A raw client speaking the protocol by hand, to send what a real worker never would. */
async function raw(port: number) {
  const socket: Socket = connect({ host: "127.0.0.1", port });
  const lines: Array<Record<string, unknown>> = [];
  let buffer = "";
  let closed = false;
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buffer.slice(0, index)) as Record<string, unknown>);
      buffer = buffer.slice(index + 1);
    }
  });
  socket.on("close", () => (closed = true));
  socket.on("error", () => (closed = true));
  cleanups.push(() => void socket.destroy());
  await until(() => lines.length > 0);
  return {
    lines,
    write: (frame: unknown) => socket.write(JSON.stringify(frame) + "\n"),
    closed: () => closed
  };
}

describe("remote worker replay protection", () => {
  it("refuses a hello replayed on a new connection", async () => {
    const f = await fixture();
    const { workerId, secret } = parseLinkedWorkerCredential(f.credential)!;
    const first = await raw(f.port);
    const hello = {
      type: "hello",
      v: linkedWorkerProtocolVersion,
      workerId,
      secret,
      challenge: first.lines[0]!.nonce,
      nonce: "n".repeat(43)
    };
    first.write(hello);
    await until(() => f.hub.attached(BUSINESS) !== undefined);
    const second = await raw(f.port);
    second.write(hello); // carries the first connection's challenge
    await until(() => second.lines.length === 2);
    expect(second.lines[1]).toEqual({ type: "refused", code: "handshake_invalid" });
    await until(() => second.closed());
  });

  it("closes the connection on a replayed, reordered or forged signed frame", async () => {
    const f = await fixture();
    const { workerId, secret } = parseLinkedWorkerCredential(f.credential)!;
    for (const attack of ["replay", "skip", "forge"] as const) {
      const client = await raw(f.port);
      const challenge = client.lines[0]!.nonce as string;
      const nonce = "m".repeat(43);
      client.write({
        type: "hello",
        v: linkedWorkerProtocolVersion,
        workerId,
        secret,
        challenge,
        nonce
      });
      await until(() => f.hub.attached(BUSINESS) !== undefined);
      const key = linkedSessionKey(secret, challenge, nonce);
      const ping = sealLinkedFrame(key, "worker", 1, { type: "ping" });
      client.write(ping);
      if (attack === "replay") client.write(ping);
      if (attack === "skip") client.write(sealLinkedFrame(key, "worker", 3, { type: "ping" }));
      if (attack === "forge")
        client.write(sealLinkedFrame(Buffer.alloc(32, 1), "worker", 2, { type: "ping" }));
      await until(() => client.closed());
      await until(() => f.hub.attached(BUSINESS) === undefined);
    }
  });

  it("refuses an unknown protocol version and silence during the handshake", async () => {
    const f = await fixture();
    const client = await raw(f.port);
    client.write({ type: "hello", v: "grogoni.whatsapp-linked-worker/0" });
    await until(() => client.lines.length === 2);
    expect(client.lines[1]).toEqual({ type: "refused", code: "version_unsupported" });
  });
});

describe("remote worker settings", () => {
  it("requires TLS off loopback, on both sides", () => {
    expect(() => parseLinkedHubUrl("tcp://10.0.0.5:7443")).toThrow(/loopback/);
    expect(parseLinkedHubUrl("tls://hub.internal:7443")).toEqual({
      tls: true,
      host: "hub.internal",
      port: 7443
    });
    expect(parseLinkedHubUrl("tcp://127.0.0.1:7443").tls).toBe(false);
    expect(() =>
      linkedHubListenFromEnvironment({ WHATSAPP_LINKED_HUB_LISTEN: "0.0.0.0:7443" }, () =>
        Buffer.alloc(0)
      )
    ).toThrow(/TLS/);
    expect(
      linkedHubListenFromEnvironment({ WHATSAPP_LINKED_HUB_LISTEN: "127.0.0.1:7443" }, () =>
        Buffer.alloc(0)
      )
    ).toEqual({ host: "127.0.0.1", port: 7443 });
    expect(linkedHubListenFromEnvironment({}, () => Buffer.alloc(0))).toBeUndefined();
    expect(() =>
      linkedHubListenFromEnvironment(
        { WHATSAPP_LINKED_HUB_LISTEN: "0.0.0.0:7443", WHATSAPP_LINKED_HUB_TLS_CERT_FILE: "/c" },
        () => Buffer.alloc(0)
      )
    ).toThrow(/both/);
    expect(
      () =>
        new LinkedRemoteWorker({
          hubUrl: "tcp://127.0.0.1:1",
          credential: "not-a-credential",
          driver: mockDriver().driver
        })
    ).toThrow(/credential/);
  });

  it("validates inbound events from a worker structurally", () => {
    expect(parseRemoteInbound(inbound("ok"))).toEqual(inbound("ok"));
    expect(parseRemoteInbound({ ...inbound("x"), text: "x".repeat(4001) })).toBeNull();
    expect(parseRemoteInbound({ ...inbound("x"), fromMe: "no" })).toBeNull();
    expect(parseRemoteInbound({ ...inbound("x"), media: [{ type: "video" }] })).toBeNull();
    expect(
      parseRemoteInbound({
        ...inbound("x"),
        mutation: { kind: "receipt", targetId: "t", fromMe: true, status: "read" }
      })?.mutation
    ).toEqual({ kind: "receipt", targetId: "t", fromMe: true, status: "read" });
  });
});
