import { describe, expect, it, vi } from "vitest";

import { createSessionContextRetry } from "../apps/web/src/session-context-retry";

// Loads whose outcomes each test settles by hand, so every race is written out in order. Each
// call records the shouldApply it was given, so tests can check whether a result would apply.
function controllableLoad() {
  const calls: Array<{
    shouldApply: () => boolean;
    apply: "restore" | "refresh";
    resolve: (ok: boolean) => void;
  }> = [];
  const load = vi.fn(
    (shouldApply: () => boolean, apply: "restore" | "refresh") =>
      new Promise<boolean>((resolve) => {
        calls.push({ shouldApply, apply, resolve });
      })
  );
  // A real loader applies, and reports true, only while its shouldApply holds.
  const answer = async (index: number, serverOk: boolean) => {
    const call = calls[index]!;
    call.resolve(serverOk && call.shouldApply());
    await Promise.resolve();
    await Promise.resolve();
  };
  return { load, calls, answer };
}

function clock() {
  let time = 0;
  return { now: () => time, advance: (ms: number) => (time += ms) };
}

describe("session context retry", () => {
  it("retries after a failure until one load applies, then never loads again", async () => {
    const retry = createSessionContextRetry();
    const { load, answer } = controllableLoad();

    retry.track("account-a", load);
    expect(load).toHaveBeenCalledTimes(1);
    await answer(0, false);

    retry.retry();
    expect(load).toHaveBeenCalledTimes(2);
    await answer(1, true);

    retry.retry();
    retry.retry();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("treats a rejected load as a failure that can be retried", async () => {
    const retry = createSessionContextRetry();
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(true);

    retry.track("account-a", load);
    await Promise.resolve();
    await Promise.resolve();
    retry.retry();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("starts no retry while a load is in flight", () => {
    const retry = createSessionContextRetry();
    const { load } = controllableLoad();

    retry.track("account-a", load);
    retry.retry();
    retry.retry();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("lets a retry replace a load that hung past the lease, and drops the hung result", async () => {
    const time = clock();
    const retry = createSessionContextRetry({ leaseMs: 1_000, now: time.now });
    const { load, calls } = controllableLoad();

    retry.track("account-a", load);
    time.advance(999);
    retry.retry();
    expect(load).toHaveBeenCalledTimes(1);

    time.advance(1);
    retry.retry();
    expect(load).toHaveBeenCalledTimes(2);
    expect(calls[0]!.shouldApply()).toBe(false);
    expect(calls[1]!.shouldApply()).toBe(true);
  });

  it("lets an external load (joinStaffShop) supersede a retry in flight without waiting", () => {
    const retry = createSessionContextRetry();
    const { load, calls } = controllableLoad();

    retry.track("account-a", load);
    const external = retry.beginExternalLoad();

    expect(calls[0]!.shouldApply()).toBe(false);
    expect(external.shouldApply()).toBe(true);
  });

  it("ends retrying once the user joins a shop, even if the join's load fails", () => {
    const retry = createSessionContextRetry();
    const { load, calls } = controllableLoad();

    retry.track("account-a", load);
    calls[0]!.resolve(false);
    const external = retry.beginExternalLoad();
    retry.retry();
    expect(load).toHaveBeenCalledTimes(1);

    external.settle(false);
    retry.retry();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("starts no retry after the lease when a join's load hangs", () => {
    const time = clock();
    const retry = createSessionContextRetry({ leaseMs: 1_000, now: time.now });
    const { load, calls } = controllableLoad();

    retry.track("account-a", load);
    calls[0]!.resolve(false);
    const external = retry.beginExternalLoad();
    time.advance(5_000);
    retry.retry();
    expect(load).toHaveBeenCalledTimes(1);
    expect(external.shouldApply()).toBe(true);
  });

  it("never retries after an external load applied", async () => {
    const retry = createSessionContextRetry();
    const { load, answer } = controllableLoad();

    retry.track("account-a", load);
    await answer(0, false);
    retry.beginExternalLoad().settle(true);

    retry.retry();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("drops a load from before sign-out and keeps the next sign-in's load in charge", async () => {
    const retry = createSessionContextRetry();
    const { load, calls, answer } = controllableLoad();

    retry.track("account-a", load);
    retry.track(null);
    retry.track("account-a", load);
    expect(load).toHaveBeenCalledTimes(2);
    expect(calls[0]!.shouldApply()).toBe(false);

    // The stale load reports even a (wrongly) applied result: it must not end the new load's
    // turn or count for this sign-in.
    calls[0]!.resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    retry.retry();
    expect(load).toHaveBeenCalledTimes(2);

    await answer(1, false);
    retry.retry();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("starts the new account's load at once and drops the old account's result", async () => {
    const retry = createSessionContextRetry();
    const { load, calls, answer } = controllableLoad();

    retry.track("account-a", load);
    retry.track("account-b", load);
    expect(load).toHaveBeenCalledTimes(2);
    expect(calls[0]!.shouldApply()).toBe(false);

    calls[0]!.resolve(true);
    await answer(1, false);
    retry.retry();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("drops an external load whose sign-in ended before it returned", async () => {
    const retry = createSessionContextRetry();
    const { load, answer } = controllableLoad();

    retry.track("account-a", load);
    const external = retry.beginExternalLoad();
    retry.track(null);
    retry.track("account-a", load);

    expect(external.shouldApply()).toBe(false);
    external.settle(true);
    // The stale settle neither ended the new sign-in's load nor counted as applied.
    retry.retry();
    expect(load).toHaveBeenCalledTimes(2);
    await answer(1, false);
    retry.retry();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("drops an external load once its user signs out, even with no new load started", () => {
    const retry = createSessionContextRetry();
    const { load } = controllableLoad();

    retry.track("account-a", load);
    const external = retry.beginExternalLoad();
    retry.track(null);
    expect(external.shouldApply()).toBe(false);
  });

  it("loads again on a new sign-in after an earlier one applied", async () => {
    const retry = createSessionContextRetry();
    const { load, answer } = controllableLoad();

    retry.track("account-a", load);
    await answer(0, true);
    retry.track(null);
    retry.track("account-a", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("restores on the sign-in's first load and only refreshes on retries", async () => {
    const retry = createSessionContextRetry();
    const { load, calls, answer } = controllableLoad();

    retry.track("account-a", load);
    await answer(0, false);
    retry.retry();
    await answer(1, false);
    retry.retry();

    expect(calls.map((call) => call.apply)).toEqual(["restore", "refresh", "refresh"]);
  });

  it("does not restore again when the same account's loader is re-registered (StrictMode)", async () => {
    const retry = createSessionContextRetry();
    const first = controllableLoad();
    const second = controllableLoad();

    retry.track("account-a", first.load);
    // The effect remounts with a fresh loader for the same sign-in.
    retry.track("account-a", second.load);
    await first.answer(0, false);
    retry.retry();

    expect(first.calls.map((call) => call.apply)).toEqual(["restore"]);
    expect(second.calls.map((call) => call.apply)).toEqual(["refresh"]);
  });

  it("restores again on a new sign-in", async () => {
    const retry = createSessionContextRetry();
    const { load, calls, answer } = controllableLoad();

    retry.track("account-a", load);
    await answer(0, false);
    retry.track(null);
    retry.track("account-a", load);

    expect(calls.map((call) => call.apply)).toEqual(["restore", "restore"]);
  });

  it("does nothing while signed out", () => {
    const retry = createSessionContextRetry();
    retry.track(null);
    expect(() => retry.retry()).not.toThrow();
  });
});
