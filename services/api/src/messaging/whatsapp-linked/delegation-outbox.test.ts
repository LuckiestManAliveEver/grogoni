import { describe, expect, it } from "vitest";
import {
  deferLinkedDelegationResult,
  isLinkedDelegationResultEntry,
  linkedAutomatedAdmission,
  linkedDelegationOutboxLimits,
  linkedDelegationResultAbandoned,
  linkedDelegationResultDue,
  linkedDelegationResultExpired,
  linkedDelegationResultKey,
  mergeLinkedDelegationResult,
  newLinkedDelegationResultEntry,
  prunableLinkedDelegationResult,
  retryLinkedDelegationResult,
  settleLinkedDelegationResult
} from "./delegation-outbox.js";
import { createCp2Store } from "../../cp2/store.js";

const t0 = new Date("2026-11-08T10:00:00.000Z");
const at = (ms: number) => new Date(t0.getTime() + ms);
const entry = newLinkedDelegationResultEntry(
  {
    businessId: "business",
    turnId: "turn-1",
    delegation: {
      channelId: "channel",
      grantId: "grant",
      ownerId: "owner",
      sourceMessageId: "source",
      actorId: "254711111111@s.whatsapp.net"
    },
    toolName: "product.create",
    outcome: "executed",
    resolvedBy: "owner"
  },
  t0
);

describe("delegated-result outbox entries", () => {
  it("is keyed by the originating turn and due at once", () => {
    expect(linkedDelegationResultKey("turn-1")).toBe("whatsapp-result:turn-1");
    expect(entry).toMatchObject({
      id: "whatsapp-result:turn-1",
      idempotencyKey: "whatsapp-result:turn-1",
      status: "pending",
      attempts: 0,
      settledAt: null
    });
    expect(linkedDelegationResultDue(entry, t0)).toBe(true);
    expect(isLinkedDelegationResultEntry(entry)).toBe(true);
  });

  it("backs off exponentially, capped, and settles after the last attempt", () => {
    let current = entry;
    const delays: number[] = [];
    let now = t0;
    for (let attempt = 1; attempt < linkedDelegationOutboxLimits.maxAttempts; attempt += 1) {
      current = retryLinkedDelegationResult(current, now, "CHANNEL_UNAVAILABLE");
      expect(current.status).toBe("pending");
      delays.push(Date.parse(current.nextAttemptAt) - now.getTime());
      expect(linkedDelegationResultDue(current, now)).toBe(false);
      now = new Date(current.nextAttemptAt);
      expect(linkedDelegationResultDue(current, now)).toBe(true);
    }
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 480_000]);
    current = retryLinkedDelegationResult(current, now, "CHANNEL_UNAVAILABLE");
    expect(current).toMatchObject({
      status: "failed",
      reason: "retries_exhausted",
      attempts: 6,
      lastErrorCode: "CHANNEL_UNAVAILABLE"
    });
    expect(linkedDelegationResultDue(current, at(10 ** 9))).toBe(false);
    // Long outages never exceed the cap.
    const many = retryLinkedDelegationResult({ ...entry, attempts: 4 }, t0, "x");
    expect(Date.parse(many.nextAttemptAt) - t0.getTime()).toBe(480_000);
    expect(
      Date.parse(retryLinkedDelegationResult({ ...entry, attempts: -20 }, t0, "x").nextAttemptAt) -
        t0.getTime()
    ).toBeLessThanOrEqual(linkedDelegationOutboxLimits.maxBackoffMs);
  });

  it("defers without spending an attempt", () => {
    const deferred = deferLinkedDelegationResult(entry, at(60_000), t0);
    expect(deferred.attempts).toBe(0);
    expect(linkedDelegationResultDue(deferred, at(59_999))).toBe(false);
    expect(linkedDelegationResultDue(deferred, at(60_000))).toBe(true);
  });

  it("expires after a day pending and is pruned a week after settling", () => {
    expect(linkedDelegationResultExpired(entry, at(24 * 3_600_000 - 1))).toBe(false);
    expect(linkedDelegationResultExpired(entry, at(24 * 3_600_000))).toBe(true);
    const sent = settleLinkedDelegationResult(entry, "sent", at(1000), { messageId: "m" });
    expect(linkedDelegationResultExpired(sent, at(10 ** 10))).toBe(false);
    expect(prunableLinkedDelegationResult(entry, at(10 ** 10))).toBe(false);
    expect(prunableLinkedDelegationResult(sent, at(1000 + 7 * 24 * 3_600_000 - 1))).toBe(false);
    expect(prunableLinkedDelegationResult(sent, at(1000 + 7 * 24 * 3_600_000))).toBe(true);
  });

  it("never lets a stale pending copy reopen a settled entry", () => {
    const sent = settleLinkedDelegationResult(entry, "sent", at(1000), { messageId: "m" });
    expect(mergeLinkedDelegationResult(sent, entry)).toBe(sent);
    expect(mergeLinkedDelegationResult(entry, sent)).toBe(sent);
    expect(mergeLinkedDelegationResult(undefined, entry)).toBe(entry);
    const later = deferLinkedDelegationResult(entry, at(5000), at(2000));
    expect(mergeLinkedDelegationResult(entry, later)).toBe(later);
    expect(mergeLinkedDelegationResult(later, entry)).toBe(later);
  });

  it("ignores malformed or mismatched stored rows", () => {
    expect(isLinkedDelegationResultEntry(null)).toBe(false);
    expect(isLinkedDelegationResultEntry({ ...entry, id: "whatsapp-result:other" })).toBe(false);
    expect(isLinkedDelegationResultEntry({ ...entry, status: "sending" })).toBe(false);
    expect(isLinkedDelegationResultEntry({ ...entry, outcome: "approved" })).toBe(false);
    expect(isLinkedDelegationResultEntry({ ...entry, delegation: { channelId: "c" } })).toBe(false);
    expect(isLinkedDelegationResultEntry({ ...entry, createdAt: "yesterday" })).toBe(false);
  });
});

describe("shared automatic-reply admission", () => {
  const hour = linkedDelegationOutboxLimits.admissionWindowMs;
  const full = (now: number) =>
    new Map(Array.from({ length: 60 }, (_, index) => [`k${index}`, now - hour + 1000 + index]));

  it("admits until 60 sends sit in the rolling hour", () => {
    const now = t0.getTime();
    const ledger = new Map(Array.from({ length: 59 }, (_, index) => [`k${index}`, now - index]));
    expect(linkedAutomatedAdmission(ledger, "new", now)).toEqual({ admitted: true });
    expect(linkedAutomatedAdmission(full(now), "new", now)).toEqual({
      admitted: false,
      retryAt: now + 1000
    });
  });

  it("re-admits a key already in the window for free", () => {
    const now = t0.getTime();
    expect(linkedAutomatedAdmission(full(now), "k3", now)).toEqual({ admitted: true });
  });

  it("forgets sends older than an hour", () => {
    const now = t0.getTime();
    expect(linkedAutomatedAdmission(full(now), "new", now + 1000)).toEqual({ admitted: true });
  });
});

describe("abandoned outbox entries", () => {
  const day = linkedDelegationOutboxLimits.expiresAfterMs;
  const grace = linkedDelegationOutboxLimits.abandonGraceMs;

  it("counts an entry as abandoned only past its deadline plus the grace margin", () => {
    expect(linkedDelegationResultAbandoned(entry, at(day))).toBe(false);
    expect(linkedDelegationResultAbandoned(entry, at(day + grace - 1))).toBe(false);
    expect(linkedDelegationResultAbandoned(entry, at(day + grace))).toBe(true);
    const sent = settleLinkedDelegationResult(entry, "sent", t0, { messageId: "m" });
    expect(linkedDelegationResultAbandoned(sent, at(10 ** 10))).toBe(false);
  });

  it("settles entries of businesses nobody serves, including rows only storage holds", async () => {
    const store = createCp2Store();
    const resolve = (businessId: string, turnId: string) => ({
      businessId,
      turnId,
      delegation: entry.delegation,
      toolName: "product.create" as const,
      outcome: "executed" as const,
      resolvedBy: "owner"
    });
    await store.deliverLinkedDelegationResult(resolve("never-reconnects", "local"));
    const createdAt = Date.parse(store.linkedDelegationResultEntries()[0]!.createdAt);
    const when = (ms: number) => () => new Date(createdAt + ms);
    // A row another process wrote for another unserved business.
    const stored = newLinkedDelegationResultEntry(
      resolve("also-unserved", "stored"),
      new Date(createdAt)
    );
    const nobody = () => false;

    // Inside the deadline plus grace: nobody serves them, and nothing happens.
    expect(
      await store.drainLinkedDelegationResults({
        ready: nobody,
        stored: [stored],
        now: when(day + grace - 1)
      })
    ).toEqual({ sent: 0, suppressed: 0, failed: 0, deferred: 0 });
    expect(store.linkedDelegationResultEntries().map((item) => item.status)).toEqual(["pending"]);

    const report = await store.drainLinkedDelegationResults({
      ready: nobody,
      stored: [stored],
      now: when(day + grace)
    });
    expect(report).toEqual({ sent: 0, suppressed: 0, failed: 2, deferred: 0 });
    expect(
      store
        .linkedDelegationResultEntries()
        .map((item) => [item.businessId, item.status, item.reason])
        .sort()
    ).toEqual([
      ["also-unserved", "failed", "expired_unserved"],
      ["never-reconnects", "failed", "expired_unserved"]
    ]);
    expect(
      store.snapshot().auditEvents.filter((event) => event.payload.reason === "expired_unserved")
    ).toHaveLength(2);

    // Settled rows of unserved businesses are pruned after the retention period too.
    await store.drainLinkedDelegationResults({
      ready: nobody,
      now: when(day + grace + linkedDelegationOutboxLimits.retainSettledMs)
    });
    expect(store.linkedDelegationResultEntries()).toEqual([]);
  });

  it("never sweeps a served business's entry; the serving drain expires it", async () => {
    const store = createCp2Store();
    await store.deliverLinkedDelegationResult({
      businessId: "served",
      turnId: "served-turn",
      delegation: entry.delegation,
      toolName: "product.create",
      outcome: "executed",
      resolvedBy: "owner"
    });
    const createdAt = Date.parse(store.linkedDelegationResultEntries()[0]!.createdAt);
    await store.drainLinkedDelegationResults({
      ready: () => true,
      now: () => new Date(createdAt + day + grace)
    });
    expect(store.linkedDelegationResultEntries()[0]).toMatchObject({
      status: "failed",
      reason: "expired"
    });
  });
});
