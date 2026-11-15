import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OutboundChannelMessage } from "../channel-gateway.js";
import { ChannelGatewayError } from "../channel-errors.js";
import { LinkedWhatsAppConnector, type LinkedDriver } from "./connector.js";
import {
  LinkedConnectorRouter,
  LinkedForwardVerifier,
  linkedForwardPath,
  registerLinkedForwardRoute,
  signLinkedForward
} from "./forwarding.js";
import { LinkedLeaseKeeper, MemoryLinkedLeaseStore, defaultLinkedLeaseSettings } from "./lease.js";
import { LinkedSessionVault } from "./vault.js";

const TOKEN = "t".repeat(40);
const BUSINESS = "business-1";
const OWNER = "owner-1";
const CHAT = "254711111111@s.whatsapp.net";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("internal forward signatures", () => {
  it("accepts a fresh signed call once and refuses tampering, replays, stale and foreign tokens", () => {
    let now = 1_000_000;
    const verifier = new LinkedForwardVerifier(TOKEN, () => now);
    const body = '{"op":"status"}';
    const headers = signLinkedForward(TOKEN, body, now);
    expect(verifier.verify(headers, '{"op":"disconnect"}')).toBe("unauthorized");
    expect(verifier.verify(signLinkedForward("x".repeat(40), body, now), body)).toBe(
      "unauthorized"
    );
    expect(verifier.verify({}, body)).toBe("unauthorized");
    expect(verifier.verify(headers, body)).toBe("ok");
    expect(verifier.verify(headers, body)).toBe("replayed");
    now += 31_000;
    expect(verifier.verify(signLinkedForward(TOKEN, body, now - 31_000), body)).toBe("replayed");
    expect(verifier.verify(signLinkedForward(TOKEN, body, now), body)).toBe("ok");
  });
});

const outbound = (key: string): OutboundChannelMessage => ({
  businessId: BUSINESS,
  conversationId: "conversation-1",
  customerId: null,
  idempotencyKey: key,
  text: "Hello from another worker",
  endpoint: {
    businessId: BUSINESS,
    conversationId: "conversation-1",
    channelId: "channel-1",
    channelIdentityId: "identity-1",
    customerId: null,
    provider: "whatsapp_linked",
    externalUserId: CHAT,
    externalConversationId: CHAT,
    configured: true,
    authorized: true,
    status: "available",
    capabilities: ["CAN_REPLY"],
    lastInboundAt: null,
    lastOutboundAt: null
  }
});

/** Two API workers in one process, each with its own HTTP listener, sharing one lease store. */
async function cluster() {
  const urls: Record<string, string> = {};
  const leases = new MemoryLinkedLeaseStore(Date.now, urls);
  const forwards: string[] = [];
  async function worker(name: string) {
    const root = mkdtempSync(join(tmpdir(), "grogoni-wa-forward-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const events: Parameters<LinkedDriver["open"]>[0][] = [];
    const socket = {
      send: vi.fn(async (_chat: string, _text: string, id: string) => id),
      close: vi.fn(),
      logout: vi.fn(async () => undefined),
      pairingCode: async () => "CODE1234",
      groups: async () => [{ chat: "123456789@g.us", name: "Group" }]
    };
    const driver: LinkedDriver = {
      open: vi.fn(async (input) => {
        events.push(input);
        return socket;
      })
    };
    const keeper = new LinkedLeaseKeeper(leases, { holderId: name, ...defaultLinkedLeaseSettings });
    const vault = new LinkedSessionVault(root, Buffer.alloc(32, 3));
    const connector = new LinkedWhatsAppConnector({
      vault,
      driver,
      receive: async () => undefined,
      authorize: () => undefined,
      lease: keeper,
      event: ({ businessId, state, lease }) => {
        if (lease) void leases.publish(businessId, name, lease, state);
      }
    });
    const app: FastifyInstance = Fastify();
    registerLinkedForwardRoute(app, { connector, holderId: name, token: TOKEN });
    await app.listen({ host: "127.0.0.1", port: 0 });
    urls[name] = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const router = new LinkedConnectorRouter({
      connector,
      directory: leases,
      holderId: name,
      token: TOKEN,
      log: (event) => forwards.push(`${event.op}:${event.target}:${event.outcome}`)
    });
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      router.stop();
      await app.close();
      await connector.stop();
    };
    cleanups.push(close);
    return { name, connector, router, socket, events, vault, app, close };
  }
  return { leases, worker, forwards, urls };
}

async function paired(c: Awaited<ReturnType<typeof cluster>>) {
  const a = await c.worker("worker-a");
  const b = await c.worker("worker-b");
  await a.router.connect(BUSINESS, OWNER, "254700000000");
  a.events[0]!.save("auth-a");
  a.events[0]!.state("open");
  return { a, b };
}

describe("requests that land on the worker without the lease", () => {
  it("forwards status, scope approval, groups and sends to the holder", async () => {
    const c = await cluster();
    const { a, b } = await paired(c);
    expect((await b.router.status(BUSINESS, OWNER)).state).toBe("CONNECTED");
    // B has no session of its own: a local status would have said DISCONNECTED.
    expect(b.connector.status(BUSINESS, OWNER).state).toBe("DISCONNECTED");
    await b.router.approve(BUSINESS, OWNER, CHAT, "conversation-1", false);
    expect(a.connector.status(BUSINESS, OWNER).scopes.map((scope) => scope.chat)).toEqual([CHAT]);
    expect(await b.router.groups(BUSINESS, OWNER)).toEqual([
      { chat: "123456789@g.us", name: "Group" }
    ]);
    const sent = await b.router.sendMessage(outbound("key-1"));
    expect(sent.status).toBe("sent");
    expect(a.socket.send).toHaveBeenCalledTimes(1);
    expect(b.socket.send).not.toHaveBeenCalled();
    // The holder's idempotency journal still applies to a forwarded send.
    await b.router.sendMessage(outbound("key-1"));
    expect(a.socket.send).toHaveBeenCalledTimes(1);
    await b.router.revoke(BUSINESS, OWNER, CHAT);
    expect(a.connector.status(BUSINESS, OWNER).scopes).toEqual([]);
    expect(c.forwards.every((entry) => entry.endsWith(":worker-a:ok"))).toBe(true);
  });

  it("disconnect from the non-holder logs the session out on the holder and frees the lease", async () => {
    const c = await cluster();
    const { a, b } = await paired(c);
    await b.router.disconnect(BUSINESS, OWNER);
    expect(a.socket.logout).toHaveBeenCalledTimes(1);
    expect(a.vault.read(BUSINESS)).toBeNull();
    expect(a.connector.status(BUSINESS, OWNER).state).toBe("DISCONNECTED");
    expect(await c.leases.holder(BUSINESS)).toBeNull();
    expect(c.forwards).toContain("disconnect:worker-a:ok");
  });

  it("refuses, retryably, when the holder cannot be reached, and erases nothing", async () => {
    const c = await cluster();
    const { a, b } = await paired(c);
    await a.app.close(); // the holder's API is gone, its lease and socket are not (yet)
    const failure = await b.router.disconnect(BUSINESS, OWNER).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChannelGatewayError);
    expect(failure).toMatchObject({ code: "CHANNEL_UNAVAILABLE", retryable: true });
    expect(a.vault.read(BUSINESS)).not.toBeNull();
    expect(a.socket.logout).not.toHaveBeenCalled();
    expect(c.forwards).toContain("disconnect:worker-a:unreachable");
  });

  it("carries connector errors back unchanged and runs locally once the holder is gone", async () => {
    const c = await cluster();
    const { a, b } = await paired(c);
    await expect(
      b.router.approve(BUSINESS, OWNER, "not-a-chat", "conversation-1", false)
    ).rejects.toThrow("Invalid WhatsApp conversation identifier.");
    await a.close(); // releases the lease on stop
    // Nobody holds it now: B handles the request itself (and takes the lease to do it).
    await b.router.connect(BUSINESS, OWNER, "254700000000");
    expect(b.events).toHaveLength(1);
  });

  it("refuses a forward that is replayed or addressed to another worker", async () => {
    const c = await cluster();
    const { a } = await paired(c);
    const body = JSON.stringify({
      op: "status",
      target: "worker-a",
      businessId: BUSINESS,
      ownerId: OWNER,
      args: []
    });
    const headers = { "content-type": "application/json", ...signLinkedForward(TOKEN, body) };
    const first = await fetch(`${c.urls["worker-a"]}${linkedForwardPath}`, {
      method: "POST",
      headers,
      body
    });
    expect(first.status).toBe(200);
    const replay = await fetch(`${c.urls["worker-a"]}${linkedForwardPath}`, {
      method: "POST",
      headers,
      body
    });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ ok: false, error: "replayed" });
    const elsewhere = JSON.stringify({ ...JSON.parse(body), target: "worker-z" });
    const misdirected = await fetch(`${c.urls["worker-a"]}${linkedForwardPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...signLinkedForward(TOKEN, elsewhere) },
      body: elsewhere
    });
    expect(misdirected.status).toBe(409);
    const unsigned = await fetch(`${c.urls["worker-a"]}${linkedForwardPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body
    });
    expect(unsigned.status).toBe(401);
    expect(a.connector.status(BUSINESS, OWNER).state).toBe("CONNECTED");
  });

  it("reports the business ready on every worker while its holder is connected", async () => {
    const c = await cluster();
    const { b } = await paired(c);
    expect(b.router.readiness({ businessId: BUSINESS }).status).toBe("unavailable");
    await b.router.poll();
    expect(b.router.readiness({ businessId: BUSINESS }).status).toBe("available");
    expect(b.router.readiness({ businessId: "other" }).status).toBe("unavailable");
    await b.router.disconnect(BUSINESS, OWNER);
    await b.router.poll();
    expect(b.router.readiness({ businessId: BUSINESS }).status).toBe("unavailable");
  });
});
