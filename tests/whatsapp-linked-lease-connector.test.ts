import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboundChannelMessage } from "../services/api/src/messaging/channel-gateway";
import { LinkedSessionVault } from "../services/api/src/messaging/whatsapp-linked/vault";
import {
  LinkedLeaseUnavailable,
  LinkedWhatsAppConnector,
  type LinkedDriver,
  type LinkedInbound
} from "../services/api/src/messaging/whatsapp-linked/connector";
import {
  LinkedLeaseKeeper,
  MemoryLinkedLeaseStore,
  defaultLinkedLeaseSettings,
  type LinkedLeaseStore
} from "../services/api/src/messaging/whatsapp-linked/lease";

// Several workers in one test process: each has its own connector, driver and lease keeper, and
// all share one lease store whose clock is the (fake) database clock. `shared: true` puts both
// vaults on one directory, modelling a shared encrypted volume, so a standby can take over.
const { ttlMs, skewMs, retryMs } = defaultLinkedLeaseSettings;
const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  // setImmediate stays real: the connector drains its journal on it.
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    now: 0
  });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.useRealTimers();
});
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const BUSINESS = "business-1";
const OWNER = "owner-1";
const CHAT = "254711111111@s.whatsapp.net";

/** A store wrapper that can be partitioned from the database (every call rejects). */
function partitionable(store: LinkedLeaseStore) {
  let down = false;
  const guard =
    <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
    (...args: A) =>
      down ? Promise.reject(new Error("partitioned")) : call(...args);
  return {
    partition: () => {
      down = true;
    },
    store: {
      acquire: guard(store.acquire.bind(store)),
      renew: guard(store.renew.bind(store)),
      release: guard(store.release.bind(store)),
      verify: guard(store.verify.bind(store))
    } satisfies LinkedLeaseStore
  };
}

function cluster() {
  const store = new MemoryLinkedLeaseStore(Date.now);
  let sharedRoot: string | undefined;
  function worker(name: string, options: { shared?: boolean } = {}) {
    const root = options.shared
      ? (sharedRoot ??= mkdtempSync(join(tmpdir(), "grogoni-wa-lease-")))
      : mkdtempSync(join(tmpdir(), "grogoni-wa-lease-"));
    roots.push(root);
    const vault = new LinkedSessionVault(root, Buffer.alloc(32, 7));
    const events: Parameters<LinkedDriver["open"]>[0][] = [];
    const send = vi.fn(async (_chat: string, _text: string, id: string) => id);
    const close = vi.fn();
    const driver: LinkedDriver = {
      open: vi.fn(async (input) => {
        events.push(input);
        return { send, close, logout: async () => undefined, pairingCode: async () => "CODE1234" };
      })
    };
    const receive = vi.fn<
      (
        businessId: string,
        ownerId: string,
        generation: string,
        message: LinkedInbound
      ) => Promise<void>
    >(async () => undefined);
    const link = partitionable(store);
    const keeper = new LinkedLeaseKeeper(
      link.store,
      { holderId: name, ...defaultLinkedLeaseSettings },
      { now: Date.now }
    );
    const states: string[] = [];
    const make = () =>
      new LinkedWhatsAppConnector({
        vault,
        driver,
        receive,
        authorize: () => undefined,
        lease: keeper,
        event: ({ state }) => states.push(state)
      });
    const connector = make();
    cleanups.push(() => connector.stop());
    return {
      name,
      vault,
      events,
      send,
      close,
      driver,
      receive,
      keeper,
      connector,
      states,
      partition: link.partition,
      async pair() {
        await connector.connect(BUSINESS, OWNER, "254700000000");
        events.at(-1)!.save(`auth-from-${name}`);
        events.at(-1)!.state("open");
        connector.approve(BUSINESS, OWNER, CHAT, "conversation-1");
      },
      state: () => connector.status(BUSINESS, OWNER).state
    };
  }
  return { store, worker };
}

const inbound = (id: string): LinkedInbound => ({
  id,
  chat: CHAT,
  sender: CHAT,
  text: "Habari",
  fromMe: false,
  mentioned: false,
  timestamp: "2026-11-08T10:00:00.000Z"
});
const outbound = (key: string): OutboundChannelMessage => ({
  businessId: BUSINESS,
  conversationId: "conversation-1",
  customerId: null,
  idempotencyKey: key,
  text: "Hello",
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

describe("WhatsApp Linked Devices multi-worker leasing", () => {
  it("opens a session only on the worker that holds the lease", async () => {
    const c = cluster();
    const a = c.worker("worker-a");
    const b = c.worker("worker-b");
    await a.pair();
    expect(a.state()).toBe("CONNECTED");
    expect(c.store.row(BUSINESS)).toMatchObject({ holderId: "worker-a", generation: "1" });
    await expect(b.connector.connect(BUSINESS, OWNER, "254700000000")).rejects.toBeInstanceOf(
      LinkedLeaseUnavailable
    );
    expect(b.driver.open).not.toHaveBeenCalled();
    // The lease generation prefixes the socket epoch handed to canonical ingress.
    a.events[0]!.inbound(inbound("m-1"));
    await settle();
    expect(a.receive).toHaveBeenCalledTimes(1);
    expect(a.receive.mock.calls[0]![2]).toMatch(/^1:/);
    // Heartbeats keep it across many TTLs.
    await vi.advanceTimersByTimeAsync(5 * ttlMs);
    expect(a.state()).toBe("CONNECTED");
    expect(a.connector.readiness({ businessId: BUSINESS }).status).toBe("available");
  });

  it("takes over after the holder dies: new generation, and the old holder's late events and sends are rejected", async () => {
    const c = cluster();
    const a = c.worker("worker-a", { shared: true });
    await a.pair();
    const b = c.worker("worker-b", { shared: true });
    await b.connector.restore();
    expect(b.state()).toBe("SUSPENDED");
    expect(b.driver.open).not.toHaveBeenCalled();
    // A keeps advancing the shared record after B cached it (Signal keys rotate constantly).
    a.events[0]!.save("auth-rotated-by-a");

    // A is cut off from the database (dead network, hung host). Its timers still run.
    a.partition();
    await vi.advanceTimersByTimeAsync(ttlMs - skewMs);
    // A fenced itself at its local deadline: socket closed, nothing live.
    expect(a.close).toHaveBeenCalled();
    expect(a.state()).toBe("SUSPENDED");
    expect(b.driver.open).not.toHaveBeenCalled();

    // B's standby retries win only once the database row has expired.
    await vi.advanceTimersByTimeAsync(skewMs + retryMs);
    expect(b.driver.open).toHaveBeenCalledTimes(1);
    expect(c.store.row(BUSINESS)).toMatchObject({ holderId: "worker-b", generation: "2" });
    // B resumed from the shared record A wrote, not from its own stale cache.
    expect(b.events[0]!.auth).toBe("auth-rotated-by-a");
    b.events[0]!.state("open");
    expect(b.state()).toBe("CONNECTED");

    // Late events from A's old socket go nowhere and cannot overwrite B's record.
    a.events[0]!.save("stale-auth-from-a");
    a.events[0]!.inbound(inbound("late-1"));
    a.events[0]!.state("open");
    await settle();
    expect(a.receive).not.toHaveBeenCalled();
    expect(JSON.parse(a.vault.read(BUSINESS)!).auth).toBe("auth-rotated-by-a");
    await expect(a.connector.sendMessage(outbound("late-send"))).rejects.toThrow();
    expect(a.send).not.toHaveBeenCalled();

    // B serves the business under generation 2.
    b.events[0]!.inbound(inbound("m-2"));
    await settle();
    expect(b.receive).toHaveBeenCalledTimes(1);
    expect(b.receive.mock.calls[0]![2]).toMatch(/^2:/);
    await expect(b.connector.sendMessage(outbound("send-b"))).resolves.toMatchObject({
      accepted: true
    });
    expect(b.send).toHaveBeenCalledTimes(1);
  });

  it("confirms the lease with the database before every send, so a stale holder sends nothing", async () => {
    const c = cluster();
    const a = c.worker("worker-a");
    await a.pair();
    // Simulate the window where A still believes it holds (e.g. drift beyond the skew bound):
    // the row was taken over by worker-b while A's local deadline has not passed.
    await c.store.release(BUSINESS, "worker-a", "1");
    expect(await c.store.acquire(BUSINESS, "worker-b", ttlMs)).toBe("2");
    expect(a.state()).toBe("CONNECTED");
    await expect(a.connector.sendMessage(outbound("send-1"))).rejects.toThrow(
      "moved to another worker"
    );
    expect(a.send).not.toHaveBeenCalled();
    // The failed verification fenced A completely.
    expect(a.close).toHaveBeenCalled();
    expect(a.state()).toBe("SUSPENDED");
    expect(JSON.parse(a.vault.read(BUSINESS)!).sent).toEqual({});
  });

  it("a rejected renewal closes the socket and stops ingress for that business only", async () => {
    const c = cluster();
    const a = c.worker("worker-a");
    await a.pair();
    await a.connector.connect("business-2", OWNER, "254700000001");
    a.events.at(-1)!.save("auth-2");
    a.events.at(-1)!.state("open");
    const firstSocket = a.events[0]!;
    // Another worker took business-1's row (generation 2) between heartbeats.
    await c.store.release(BUSINESS, "worker-a", "1");
    await c.store.acquire(BUSINESS, "worker-b", ttlMs);
    await vi.advanceTimersByTimeAsync(defaultLinkedLeaseSettings.heartbeatMs);
    expect(a.state()).toBe("SUSPENDED");
    expect(a.connector.status("business-2", OWNER).state).toBe("CONNECTED");
    firstSocket.inbound(inbound("after-loss"));
    await settle();
    expect(a.receive).not.toHaveBeenCalled();
    expect(a.connector.readiness({ businessId: BUSINESS }).status).toBe("unavailable");
  });

  it("releases the lease on disconnect so another worker can connect immediately", async () => {
    const c = cluster();
    const a = c.worker("worker-a");
    const b = c.worker("worker-b");
    await a.pair();
    await a.connector.disconnect(BUSINESS, OWNER);
    await settle();
    expect(c.store.row(BUSINESS)!.expiresAt).toBeLessThanOrEqual(Date.now());
    await b.connector.connect(BUSINESS, OWNER, "254700000000");
    expect(b.driver.open).toHaveBeenCalledTimes(1);
    expect(c.store.row(BUSINESS)).toMatchObject({ holderId: "worker-b", generation: "2" });
  });

  it("releases on graceful stop and on terminal provider states", async () => {
    const c = cluster();
    const a = c.worker("worker-a");
    await a.pair();
    a.events[0]!.state("close", "revoked");
    await settle();
    expect(a.state()).toBe("REVOKED");
    expect(c.store.row(BUSINESS)!.expiresAt).toBeLessThanOrEqual(Date.now());
    const b = c.worker("worker-b");
    await b.connector.connect("business-3", OWNER, "254700000003");
    await b.connector.stop();
    expect(c.store.row("business-3")!.expiresAt).toBeLessThanOrEqual(Date.now());
  });

  it("keeps the lease across an ordinary reconnect and reuses the same generation", async () => {
    const c = cluster();
    const a = c.worker("worker-a");
    await a.pair();
    a.events[0]!.state("close", "restart");
    await vi.advanceTimersByTimeAsync(200);
    expect(a.driver.open).toHaveBeenCalledTimes(2);
    a.events[1]!.state("open");
    expect(a.state()).toBe("CONNECTED");
    expect(c.store.row(BUSINESS)).toMatchObject({ holderId: "worker-a", generation: "1" });
    // The replaced socket's late events stay fenced by the epoch within the same generation.
    a.events[0]!.inbound(inbound("old-socket"));
    a.events[1]!.inbound(inbound("new-socket"));
    await settle();
    expect(a.receive).toHaveBeenCalledTimes(1);
    expect(a.receive.mock.calls[0]![3].id).toBe("new-socket");
  });

  it("fails closed when the lease store is unreachable at startup, then recovers", async () => {
    const c = cluster();
    const a = c.worker("worker-a", { shared: true });
    await a.pair();
    await a.connector.stop();
    const b = c.worker("worker-b", { shared: true });
    const acquire = vi.spyOn(b.keeper, "acquire").mockRejectedValueOnce(new Error("db down"));
    await b.connector.restore();
    expect(b.state()).toBe("SUSPENDED");
    expect(b.driver.open).not.toHaveBeenCalled();
    acquire.mockRestore();
    await vi.advanceTimersByTimeAsync(retryMs);
    expect(b.driver.open).toHaveBeenCalledTimes(1);
  });

  it("drops an unfinished pairing on lease loss instead of making it restorable", async () => {
    const c = cluster();
    const a = c.worker("worker-a");
    await a.connector.connect(BUSINESS, OWNER, "254700000000");
    expect(a.state()).toBe("PAIRING");
    a.partition();
    await vi.advanceTimersByTimeAsync(ttlMs - skewMs);
    expect(a.state()).toBe("AUTH_REQUIRED");
    expect(a.close).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4 * retryMs);
    expect(a.driver.open).toHaveBeenCalledTimes(1);
  });
});
