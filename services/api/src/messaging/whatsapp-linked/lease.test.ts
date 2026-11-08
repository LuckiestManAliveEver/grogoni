import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LinkedLeaseKeeper,
  MemoryLinkedLeaseStore,
  createLinkedLeaseKeeper,
  defaultLinkedLeaseSettings,
  linkedLeaseSettingsFromEnvironment,
  validateLinkedLeaseSettings,
  type LinkedLeaseLogEvent,
  type LinkedLeaseSettings,
  type LinkedLeaseStore
} from "./lease.js";
import { describeLinkedLeaseStoreContract } from "./lease-conformance.test-support.js";

let sequence = 0;
describeLinkedLeaseStoreContract("in-memory", () => {
  let clock = 0;
  return {
    store: new MemoryLinkedLeaseStore(() => clock),
    ttlMs: 30_000,
    expire: async () => {
      clock += 30_000;
    },
    business: () => `business-${++sequence}`
  };
});

const settings = (overrides: Partial<LinkedLeaseSettings> = {}): LinkedLeaseSettings => ({
  holderId: "worker-a",
  ...defaultLinkedLeaseSettings,
  ...overrides
});

describe("LinkedLeaseKeeper", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: 0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("heartbeats below the TTL and keeps the lease across many TTLs", async () => {
    const store = new MemoryLinkedLeaseStore(Date.now);
    const keeper = new LinkedLeaseKeeper(store, settings(), { now: Date.now });
    const renew = vi.spyOn(store, "renew");
    const generation = await keeper.acquire("b");
    expect(generation).toBe("1");
    await vi.advanceTimersByTimeAsync(10 * defaultLinkedLeaseSettings.ttlMs);
    expect(keeper.holds("b", "1")).toBe(true);
    expect(renew.mock.calls.length).toBeGreaterThanOrEqual(30);
    expect(store.row("b")!.expiresAt).toBeGreaterThan(Date.now());
    // A second worker is refused throughout.
    const other = new LinkedLeaseKeeper(store, settings({ holderId: "worker-b" }), {
      now: Date.now
    });
    expect(await other.acquire("b")).toBeNull();
    await keeper.stop();
    await other.stop();
  });

  it("coalesces concurrent acquisitions and reuses a held generation without a query", async () => {
    const store = new MemoryLinkedLeaseStore(Date.now);
    const acquire = vi.spyOn(store, "acquire");
    const keeper = new LinkedLeaseKeeper(store, settings(), { now: Date.now });
    expect(await Promise.all([keeper.acquire("b"), keeper.acquire("b")])).toEqual(["1", "1"]);
    expect(await keeper.acquire("b")).toBe("1");
    expect(acquire).toHaveBeenCalledTimes(1);
    await keeper.stop();
  });

  it("reports loss when a renewal is rejected because another generation exists", async () => {
    const store = new MemoryLinkedLeaseStore(Date.now);
    const events: LinkedLeaseLogEvent[] = [];
    const keeper = new LinkedLeaseKeeper(store, settings(), {
      now: Date.now,
      log: (event) => events.push(event)
    });
    const lost = vi.fn();
    keeper.onLost(lost);
    await keeper.acquire("b");
    // An operator (or a bug) re-grants the row to someone else.
    await store.release("b", "worker-a", "1");
    await store.acquire("b", "worker-b", 30_000);
    await vi.advanceTimersByTimeAsync(defaultLinkedLeaseSettings.heartbeatMs);
    expect(lost).toHaveBeenCalledWith("b", "1");
    expect(keeper.holds("b", "1")).toBe(false);
    expect(events.at(-1)).toMatchObject({ action: "lost", reason: "rejected", generation: "1" });
    // Loss never expires the successor's lease.
    expect(await store.verify("b", "worker-b", "2")).toBe(true);
    await keeper.stop();
  });

  it("stops acting at the local deadline when the database is unreachable, before a takeover is possible", async () => {
    const store = new MemoryLinkedLeaseStore(Date.now);
    const { ttlMs, skewMs } = defaultLinkedLeaseSettings;
    const keeper = new LinkedLeaseKeeper(store, settings(), { now: Date.now });
    const lost = vi.fn<(businessId: string, generation: string) => void>();
    keeper.onLost(lost);
    await keeper.acquire("b");
    vi.spyOn(store, "renew").mockRejectedValue(new Error("connection refused"));
    vi.spyOn(store, "release").mockRejectedValue(new Error("connection refused"));
    await vi.advanceTimersByTimeAsync(ttlMs - skewMs - 1);
    expect(keeper.holds("b", "1")).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(keeper.holds("b", "1")).toBe(false);
    expect(lost).toHaveBeenCalledTimes(1);
    // The database still considers the row live for `skew` more ms: nobody can overlap.
    const b = new LinkedLeaseKeeper(store, settings({ holderId: "worker-b" }), { now: Date.now });
    expect(await b.acquire("b")).toBeNull();
    await vi.advanceTimersByTimeAsync(skewMs);
    expect(await b.acquire("b")).toBe("2");
    vi.restoreAllMocks();
    await keeper.stop();
    await b.stop();
  });

  it("counts the safe window from when the request was sent, not when it answered", async () => {
    const store = new MemoryLinkedLeaseStore(Date.now);
    const { ttlMs, skewMs } = defaultLinkedLeaseSettings;
    const real = store.acquire.bind(store);
    const slow = (delay: number) =>
      vi.spyOn(store, "acquire").mockImplementationOnce(async (...args) => {
        const result = await real(...args);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return result;
      });
    const keeper = new LinkedLeaseKeeper(store, settings(), { now: Date.now });
    slow(20_000);
    const renew = vi.spyOn(store, "renew").mockRejectedValue(new Error("down"));
    const pending = keeper.acquire("b");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await pending).toBe("1");
    // Only ttl - skew - latency remains, and renewal is pulled forward to fit inside it.
    await vi.advanceTimersByTimeAsync(ttlMs - skewMs - 20_000 - 1);
    expect(renew.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(keeper.holds("b", "1")).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(keeper.holds("b", "1")).toBe(false);
    vi.restoreAllMocks();
    // An answer slower than the whole safe window is never used, and is handed back.
    await vi.advanceTimersByTimeAsync(ttlMs);
    slow(ttlMs);
    const late = keeper.acquire("b");
    await vi.advanceTimersByTimeAsync(ttlMs);
    expect(await late).toBeNull();
    expect(store.row("b")!.expiresAt).toBeLessThanOrEqual(Date.now());
    await keeper.stop();
  });

  it("renewal race: a renewal answered after the local deadline is discarded and a successor wins", async () => {
    const store = new MemoryLinkedLeaseStore(Date.now);
    const { ttlMs, skewMs, heartbeatMs } = defaultLinkedLeaseSettings;
    const keeper = new LinkedLeaseKeeper(store, settings(), { now: Date.now });
    const lost = vi.fn();
    keeper.onLost(lost);
    await keeper.acquire("b");
    const real = store.renew.bind(store);
    // Every renewal reaches the database but its answer is stuck for 20 s (congested link).
    const congested = vi.spyOn(store, "renew").mockImplementation(async (...args) => {
      const result = await real(...args);
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      return result;
    });
    await vi.advanceTimersByTimeAsync(ttlMs - skewMs);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(keeper.holds("b", "1")).toBe(false);
    // Loss released the row although the in-flight renewal had extended it. (The worker-a
    // renewal already in flight keeps its stuck answer; new renewals are healthy again.)
    congested.mockRestore();
    const b = new LinkedLeaseKeeper(store, settings({ holderId: "worker-b" }), { now: Date.now });
    expect(await b.acquire("b")).toBe("2");
    // The late "renewed" answers arrive now and must not resurrect worker-a.
    await vi.advanceTimersByTimeAsync(heartbeatMs + 20_000);
    expect(keeper.holds("b", "1")).toBe(false);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(await store.verify("b", "worker-b", "2")).toBe(true);
    await keeper.stop();
    await b.stop();
  });

  describe("clock skew bound", () => {
    // Worker clock runs slower than the database clock. Over one TTL it falls behind by
    // ttl * rate. Safety holds exactly while that is below `skew` (5s of 30s here).
    async function overlap(slowdown: number) {
      const store = new MemoryLinkedLeaseStore(Date.now);
      const local = () => Date.now() * (1 - slowdown);
      const a = new LinkedLeaseKeeper(store, settings(), { now: local });
      let lostAt: number | undefined;
      a.onLost(() => (lostAt ??= Date.now()));
      await a.acquire("b");
      // A is partitioned from the database: neither its renewals nor its release arrive.
      vi.spyOn(store, "renew").mockRejectedValue(new Error("partitioned"));
      vi.spyOn(store, "release").mockRejectedValue(new Error("partitioned"));
      const b = new LinkedLeaseKeeper(store, settings({ holderId: "worker-b" }), {
        now: Date.now
      });
      let takenAt: number | undefined;
      for (let t = 0; t < 40_000 && takenAt === undefined; t += 100) {
        await vi.advanceTimersByTimeAsync(100);
        // A believes it holds the lease while B also does: that would be split brain.
        if ((await b.acquire("b")) !== null) takenAt = Date.now();
      }
      const aStillActing = a.holds("b", "1");
      vi.restoreAllMocks();
      await a.stop();
      await b.stop();
      return { lostAt, takenAt, aStillActing };
    }

    it("never overlaps when drift stays inside the skew bound (10% slow over one TTL = 3s < 5s)", async () => {
      const { lostAt, takenAt, aStillActing } = await overlap(0.1);
      // A stops at 25s / 0.9 = 27.8s of database time; B can only take over at 30s.
      expect(lostAt).toBeLessThan(takenAt!);
      expect(aStillActing).toBe(false);
      expect(takenAt).toBe(defaultLinkedLeaseSettings.ttlMs);
    });

    it("documents the break point: 20% slow (6s > 5s) lets the old holder outlive its lease", async () => {
      const { lostAt, takenAt, aStillActing } = await overlap(0.2);
      // B owns it from 30s while A's local window runs to 25s / 0.8 = 31.25s.
      expect(takenAt).toBe(defaultLinkedLeaseSettings.ttlMs);
      expect(lostAt).toBeUndefined();
      expect(aStillActing).toBe(true);
    });
  });

  it("verify consults the database and fences on revocation; database errors fail closed", async () => {
    const store = new MemoryLinkedLeaseStore(Date.now);
    const keeper = new LinkedLeaseKeeper(store, settings(), { now: Date.now });
    const lost = vi.fn();
    keeper.onLost(lost);
    await keeper.acquire("b");
    expect(await keeper.verify("b", "1")).toBe(true);
    expect(await keeper.verify("b", "2")).toBe(false);
    const failing = vi.spyOn(store, "verify").mockRejectedValueOnce(new Error("down"));
    expect(await keeper.verify("b", "1")).toBe(false);
    expect(keeper.holds("b", "1")).toBe(true);
    failing.mockRestore();
    await store.release("b", "worker-a", "1");
    expect(await keeper.verify("b", "1")).toBe(false);
    expect(lost).toHaveBeenCalledWith("b", "1");
    await keeper.stop();
  });

  it("release and stop hand leases back without reporting a loss", async () => {
    const store = new MemoryLinkedLeaseStore(Date.now);
    const keeper = new LinkedLeaseKeeper(store, settings(), { now: Date.now });
    const lost = vi.fn();
    keeper.onLost(lost);
    await keeper.acquire("b1");
    await keeper.acquire("b2");
    await keeper.release("b1", "1");
    expect(keeper.holds("b1", "1")).toBe(false);
    expect(store.row("b1")!.expiresAt).toBe(Date.now());
    await keeper.stop();
    expect(store.row("b2")!.expiresAt).toBe(Date.now());
    expect(await keeper.acquire("b3")).toBeNull();
    expect(lost).not.toHaveBeenCalled();
  });

  it("swallows store failures on release; the row expires on its own", async () => {
    const store: LinkedLeaseStore = new MemoryLinkedLeaseStore(Date.now);
    const keeper = new LinkedLeaseKeeper(store, settings(), { now: Date.now });
    await keeper.acquire("b");
    vi.spyOn(store, "release").mockRejectedValue(new Error("down"));
    await expect(keeper.release("b", "1")).resolves.toBeUndefined();
    expect(keeper.holds("b", "1")).toBe(false);
    vi.restoreAllMocks();
    await keeper.stop();
  });
});

describe("lease settings", () => {
  it("defaults to off (single process) and to safe postgres timings", () => {
    expect(linkedLeaseSettingsFromEnvironment({})).toEqual({ mode: "off" });
    expect(createLinkedLeaseKeeper({}, undefined)).toBeUndefined();
    const config = linkedLeaseSettingsFromEnvironment({ WHATSAPP_LINKED_LEASE_MODE: "postgres" });
    expect(config.mode).toBe("postgres");
    if (config.mode !== "postgres") return;
    expect(config.settings).toMatchObject(defaultLinkedLeaseSettings);
    expect(config.settings.holderId).toMatch(/^[A-Za-z0-9._-]+:[0-9]+:[0-9a-f]{8}$/);
    const { ttlMs, heartbeatMs, skewMs } = config.settings;
    expect(heartbeatMs * 3).toBeLessThanOrEqual(ttlMs - skewMs);
  });

  it("generates a distinct worker id per process instance", () => {
    const id = () => linkedLeaseSettingsFromEnvironment({ WHATSAPP_LINKED_LEASE_MODE: "postgres" });
    const [a, b] = [id(), id()];
    expect(a.mode === "postgres" && b.mode === "postgres").toBe(true);
    if (a.mode === "postgres" && b.mode === "postgres")
      expect(a.settings.holderId).not.toBe(b.settings.holderId);
  });

  it("refuses unsafe or malformed configuration", () => {
    const env = (extra: Record<string, string>) => () =>
      linkedLeaseSettingsFromEnvironment({ WHATSAPP_LINKED_LEASE_MODE: "postgres", ...extra });
    expect(() =>
      linkedLeaseSettingsFromEnvironment({ WHATSAPP_LINKED_LEASE_MODE: "redis" })
    ).toThrow("off or postgres");
    expect(env({ WHATSAPP_LINKED_LEASE_HEARTBEAT_MS: "9000" })).toThrow("HEARTBEAT");
    expect(env({ WHATSAPP_LINKED_LEASE_SKEW_MS: "500" })).toThrow("SKEW");
    expect(env({ WHATSAPP_LINKED_LEASE_SKEW_MS: "16000" })).toThrow("SKEW");
    expect(env({ WHATSAPP_LINKED_LEASE_TTL_MS: "1000" })).toThrow("TTL");
    expect(env({ WHATSAPP_LINKED_LEASE_TTL_MS: "30s" })).toThrow("whole number");
    expect(env({ WHATSAPP_LINKED_LEASE_RETRY_MS: "10" })).toThrow("RETRY");
    expect(env({ WHATSAPP_LINKED_WORKER_ID: "bad id with spaces" })).toThrow("WORKER_ID");
    expect(() =>
      createLinkedLeaseKeeper({ WHATSAPP_LINKED_LEASE_MODE: "postgres" }, undefined)
    ).toThrow("requires a Postgres");
    expect(
      validateLinkedLeaseSettings(
        settings({ ttlMs: 60_000, heartbeatMs: 15_000, skewMs: 10_000, retryMs: 20_000 })
      ).heartbeatMs
    ).toBe(15_000);
  });
});
