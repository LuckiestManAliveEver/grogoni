import { describe, expect, it } from "vitest";
import type { LinkedLeaseStore } from "./lease.js";

/**
 * Test support only. One behavioural contract, run against both MemoryLinkedLeaseStore (fake
 * database clock) and PostgresLinkedLeaseStore (real SQL, real clock), so the fake used by the
 * connector tests is proven to match the production semantics.
 */
export interface LeaseStoreHarness {
  store: LinkedLeaseStore;
  /** TTL to pass to the store for these cases. */
  ttlMs: number;
  /** Lets every lease taken so far expire by the store's own clock. */
  expire(): Promise<void>;
  /** Unique business id per case, so cases never share rows. */
  business(): string;
}

export function describeLinkedLeaseStoreContract(
  name: string,
  make: () => Promise<LeaseStoreHarness> | LeaseStoreHarness,
  options: { concurrency?: number; timeout?: number } = {}
): void {
  const timeout = options.timeout ?? 5_000;
  describe(`${name} lease store contract`, () => {
    it(
      "acquires when absent, refuses a second holder, and lets the holder re-acquire with a new generation",
      async () => {
        const h = await make();
        const business = h.business();
        expect(await h.store.acquire(business, "worker-a", h.ttlMs)).toBe("1");
        expect(await h.store.acquire(business, "worker-b", h.ttlMs)).toBeNull();
        expect(await h.store.verify(business, "worker-b", "1")).toBe(false);
        // A holder re-acquiring fences its own previous tenure.
        expect(await h.store.acquire(business, "worker-a", h.ttlMs)).toBe("2");
        expect(await h.store.verify(business, "worker-a", "1")).toBe(false);
        expect(await h.store.verify(business, "worker-a", "2")).toBe(true);
        expect(await h.store.renew(business, "worker-a", "1", h.ttlMs)).toBe(false);
      },
      timeout
    );

    it(
      "renews only for the current holder and generation",
      async () => {
        const h = await make();
        const business = h.business();
        const generation = (await h.store.acquire(business, "worker-a", h.ttlMs))!;
        expect(await h.store.renew(business, "worker-a", generation, h.ttlMs)).toBe(true);
        expect(await h.store.renew(business, "worker-b", generation, h.ttlMs)).toBe(false);
        expect(await h.store.renew(business, "worker-a", "999", h.ttlMs)).toBe(false);
        expect(await h.store.renew(h.business(), "worker-a", generation, h.ttlMs)).toBe(false);
      },
      timeout
    );

    it(
      "after expiry, a new holder takes over with a higher generation and the old one is fenced",
      async () => {
        const h = await make();
        const business = h.business();
        const old = (await h.store.acquire(business, "worker-a", h.ttlMs))!;
        await h.expire();
        const next = (await h.store.acquire(business, "worker-b", h.ttlMs))!;
        expect(BigInt(next)).toBe(BigInt(old) + 1n);
        expect(await h.store.renew(business, "worker-a", old, h.ttlMs)).toBe(false);
        expect(await h.store.verify(business, "worker-a", old)).toBe(false);
        expect(await h.store.release(business, "worker-a", old)).toBe(false);
        expect(await h.store.verify(business, "worker-b", next)).toBe(true);
      },
      timeout
    );

    it(
      "refuses to renew an expired lease even when nobody took it over",
      async () => {
        const h = await make();
        const business = h.business();
        const generation = (await h.store.acquire(business, "worker-a", h.ttlMs))!;
        await h.expire();
        expect(await h.store.renew(business, "worker-a", generation, h.ttlMs)).toBe(false);
        expect(await h.store.verify(business, "worker-a", generation)).toBe(false);
        expect(await h.store.acquire(business, "worker-a", h.ttlMs)).toBe(
          String(BigInt(generation) + 1n)
        );
      },
      timeout
    );

    it(
      "release hands the lease over at once, only once, and never repeats a generation",
      async () => {
        const h = await make();
        const business = h.business();
        const seen: bigint[] = [];
        for (const holder of ["worker-a", "worker-b", "worker-a", "worker-c"]) {
          const generation = await h.store.acquire(business, holder, h.ttlMs);
          expect(generation).not.toBeNull();
          seen.push(BigInt(generation!));
          expect(await h.store.release(business, holder, generation!)).toBe(true);
          expect(await h.store.release(business, holder, generation!)).toBe(false);
          expect(await h.store.verify(business, holder, generation!)).toBe(false);
        }
        expect(seen).toEqual([1n, 2n, 3n, 4n]);
      },
      timeout
    );

    it(
      "lets exactly one of many concurrent acquirers win",
      async () => {
        const h = await make();
        const concurrency = options.concurrency ?? 8;
        for (let round = 0; round < 5; round++) {
          const business = h.business();
          const results = await Promise.all(
            Array.from({ length: concurrency }, (_, index) =>
              h.store.acquire(business, `worker-${index}`, h.ttlMs)
            )
          );
          expect(results.filter((result) => result !== null)).toEqual(["1"]);
        }
      },
      timeout * 2
    );

    it(
      "never lets a renewal and a takeover both succeed",
      async () => {
        const h = await make();
        // Before expiry: the holder's renewal wins, the challenger is refused.
        const live = h.business();
        const generation = (await h.store.acquire(live, "worker-a", h.ttlMs))!;
        const [renewed, taken] = await Promise.all([
          h.store.renew(live, "worker-a", generation, h.ttlMs),
          h.store.acquire(live, "worker-b", h.ttlMs)
        ]);
        expect([renewed, taken]).toEqual([true, null]);
        // After expiry: the late renewal is refused, the challenger takes over.
        await h.expire();
        const [late, takeover] = await Promise.all([
          h.store.renew(live, "worker-a", generation, h.ttlMs),
          h.store.acquire(live, "worker-b", h.ttlMs)
        ]);
        expect(late).toBe(false);
        expect(takeover).toBe(String(BigInt(generation) + 1n));
      },
      timeout
    );

    it("rejects malformed identifiers before touching storage", async () => {
      const h = await make();
      const business = h.business();
      await expect(h.store.renew(business, "worker-a", "0", h.ttlMs)).rejects.toThrow("generation");
      await expect(h.store.verify(business, "worker-a", "1; drop")).rejects.toThrow("generation");
      await expect(h.store.acquire("", "worker-a", h.ttlMs)).rejects.toThrow("business");
      await expect(h.store.acquire(business, "", h.ttlMs)).rejects.toThrow("holder");
      await expect(h.store.acquire(business, "worker-a", 0)).rejects.toThrow("TTL");
    });
  });
}
