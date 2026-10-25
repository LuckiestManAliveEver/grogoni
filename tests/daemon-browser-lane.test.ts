import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClaim, PublicDaemonTask } from "../packages/shared-types/src";
import {
  runNextBrowserTask,
  startBrowserDaemonLane,
  type BrowserDaemonLaneDependencies,
  type DaemonLaneEvent
} from "../apps/web/src/daemon-lane";

const task = (id: string, status: PublicDaemonTask["status"]): PublicDaemonTask => ({
  id,
  key: `user:u:${id}`,
  payload: { kind: "agent", message: "hello", modelId: "gpt-6-luna", agentAdapterId: "grogoni" },
  status,
  runAt: "2026-10-12T00:00:00.000Z",
  intervalMs: null,
  attempts: 1,
  maxAttempts: 3,
  executions: 0,
  leaseUntil: null,
  result: null,
  errorCode: null,
  lane: "browser",
  createdAt: "2026-10-12T00:00:00.000Z",
  updatedAt: "2026-10-12T00:00:00.000Z"
});
const leaseToken = "11111111-1111-4111-8111-111111111111";
/** leaseUntil is deliberately absurd: the lane must use leaseMs, never this device's clock. */
const claimFor = (id: string, leaseMs = 60_000): DaemonClaim => ({
  task: task(id, "running"),
  leaseToken,
  leaseUntil: "1999-01-01T00:00:00.000Z",
  leaseMs,
  executeTimeoutMs: 90_000,
  message: "hello"
});
class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/** A scripted API: answers by path suffix and records every call. */
function api(answers: Record<string, (body: unknown) => unknown>) {
  const calls: { path: string; body: unknown; timeoutMs?: number }[] = [];
  const request = (async (path: string, init?: { body?: unknown; timeoutMs?: number }) => {
    calls.push({
      path,
      body: init?.body,
      ...(init?.timeoutMs ? { timeoutMs: init.timeoutMs } : {})
    });
    const key = Object.keys(answers).find((suffix) => path.endsWith(suffix));
    if (key === undefined) throw new Error(`unexpected ${path}`);
    return answers[key]!(init?.body);
  }) as BrowserDaemonLaneDependencies["request"];
  return { request, calls, paths: () => calls.map((call) => call.path) };
}
const done = () => ({ task: task("t", "completed") });
const neverEnding = (signal: AbortSignal) =>
  new Promise<string>((_, reject) =>
    signal.addEventListener("abort", () => reject(new Error("aborted")))
  );

describe("browser daemon lane: one task", () => {
  // performance too: the lane measures lease ownership on the monotonic clock.
  beforeEach(() =>
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"]
    })
  );
  afterEach(() => vi.useRealTimers());

  it("reports idle with the server's delay until this user's next task", async () => {
    const { request } = api({ "/claims": () => ({ claim: null, nextDueInMs: 42_000 }) });
    expect(await runNextBrowserTask({ request, device: () => null })).toEqual({
      ran: false,
      nextDueInMs: 42_000
    });
  });

  it("runs on the device model and settles only the text with the lease token", async () => {
    const { request, calls, paths } = api({
      "/claims": () => ({ claim: claimFor("t1"), nextDueInMs: null }),
      "/settle": done
    });
    const events: DaemonLaneEvent[] = [];
    const result = await runNextBrowserTask({
      request,
      device: () => ({ modelId: "Qwen-MLC", generate: async (message) => `device: ${message}` }),
      report: (event) => events.push(event)
    });
    expect(result).toEqual({ ran: true });
    expect(paths()).toEqual(["/v1/daemon/claims", "/v1/daemon/claims/t1/settle"]);
    expect(calls[1]!.body).toEqual({
      leaseToken,
      outcome: { text: "device: hello", modelId: "Qwen-MLC" }
    });
    expect(events.map((event) => event.type)).toEqual(["claimed", "device_completed"]);
  });

  it("sends skill requests through the server even when a device model is available", async () => {
    const claim = claimFor("skill-task");
    claim.message =
      "/business 11111111-1111-4111-8111-111111111111 /skill inventory-check Check stock";
    const server = api({ "/claims": () => ({ claim }), "/execute": done });
    const generate = vi.fn(async () => "unverified stock");
    await runNextBrowserTask({
      request: server.request,
      device: () => ({ modelId: "gpt-6-luna", generate })
    });
    expect(generate).not.toHaveBeenCalled();
    expect(server.paths()).toContain("/v1/daemon/claims/skill-task/execute");
  });
  it("asks the server to run the claim, with the server's timeout, when there is no model", async () => {
    const { request, calls, paths } = api({
      "/claims": () => ({ claim: claimFor("t2"), nextDueInMs: null }),
      "/execute": done
    });
    await runNextBrowserTask({ request, device: () => null });
    expect(paths()).toEqual(["/v1/daemon/claims", "/v1/daemon/claims/t2/execute"]);
    expect(calls[1]).toMatchObject({ body: { leaseToken }, timeoutMs: 90_000 });
  });

  for (const [label, generate] of [
    [
      "fails",
      async () => {
        throw new Error("out of GPU memory");
      }
    ],
    ["returns an empty reply", async () => "  \n"]
  ] as const)
    it(`has the server run the same claim when the device ${label}`, async () => {
      const { request, paths } = api({
        "/claims": () => ({ claim: claimFor("t3"), nextDueInMs: null }),
        "/execute": done
      });
      const events: DaemonLaneEvent[] = [];
      await runNextBrowserTask({
        request,
        device: () => ({ modelId: "m", generate }),
        report: (event) => events.push(event)
      });
      expect(paths().at(-1)).toBe("/v1/daemon/claims/t3/execute");
      expect(paths().some((path) => path.endsWith("/settle"))).toBe(false);
      expect(events.some((event) => event.type === "device_failed")).toBe(true);
    });

  it("hands the task back, never to a paid server run, when the lane stops mid-generation", async () => {
    const { request, calls, paths } = api({
      "/claims": () => ({ claim: claimFor("t4"), nextDueInMs: null }),
      "/release": done
    });
    const stopping = new AbortController();
    const events: DaemonLaneEvent[] = [];
    const running = runNextBrowserTask(
      {
        request,
        device: () => ({ modelId: "m", generate: (_m, signal) => neverEnding(signal) }),
        report: (event) => events.push(event)
      },
      stopping.signal
    );
    await vi.advanceTimersByTimeAsync(1_000);
    stopping.abort();
    expect(await running).toEqual({ ran: true });
    expect(paths()).toEqual(["/v1/daemon/claims", "/v1/daemon/claims/t4/release"]);
    expect(calls[1]!.body).toEqual({ leaseToken });
    expect(events.at(-1)?.type).toBe("released");
  });

  it("renews by the server's lease length, whatever this device's clock says", async () => {
    let renewals = 0;
    const { request } = api({
      "/claims": () => ({ claim: claimFor("t5", 30_000), nextDueInMs: null }),
      "/renew": () => {
        renewals++;
        return { renewed: true };
      },
      "/settle": done
    });
    let finish: (text: string) => void = () => {};
    const running = runNextBrowserTask({
      request,
      device: () => ({
        modelId: "m",
        generate: () => new Promise<string>((resolve) => (finish = resolve))
      })
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(renewals).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(renewals).toBe(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(renewals).toBe(3);
    finish("ok");
    expect(await running).toEqual({ ran: true });
  });

  it("stops without settling when the server refuses a renewal", async () => {
    const { request, paths } = api({
      "/claims": () => ({ claim: claimFor("t6", 15_000), nextDueInMs: null }),
      "/renew": () => {
        throw new HttpError(409);
      }
    });
    const events: DaemonLaneEvent[] = [];
    const running = runNextBrowserTask({
      request,
      device: () => ({ modelId: "m", generate: (_m, signal) => neverEnding(signal) }),
      report: (event) => events.push(event)
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await running).toEqual({ ran: true });
    expect(events.map((event) => event.type)).toEqual(["claimed", "lease_lost"]);
    expect(paths().some((path) => /settle|execute|release/u.test(path))).toBe(false);
  });

  it("abandons the claim before it can lapse when renewals keep failing on the network", async () => {
    const { request, paths } = api({
      "/claims": () => ({ claim: claimFor("t7", 30_000), nextDueInMs: null }),
      "/renew": () => {
        throw new TypeError("Failed to fetch");
      }
    });
    const events: DaemonLaneEvent[] = [];
    const running = runNextBrowserTask({
      request,
      device: () => ({ modelId: "m", generate: (_m, signal) => neverEnding(signal) }),
      report: (event) => events.push(event)
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events.at(-1)?.type).toBe("claimed");
    // Two thirds of a 30s lease with no successful renewal: given up well before it lapses.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await running).toEqual({ ran: true });
    expect(events.at(-1)?.type).toBe("lease_lost");
    expect(paths().some((path) => /settle|execute/u.test(path))).toBe(false);
  });

  it("treats an /execute refused for a lost lease as finished, not as a lane failure", async () => {
    const { request } = api({
      "/claims": () => ({ claim: claimFor("t8"), nextDueInMs: null }),
      "/execute": () => {
        throw new HttpError(409);
      }
    });
    const events: DaemonLaneEvent[] = [];
    await expect(
      runNextBrowserTask({ request, device: () => null, report: (event) => events.push(event) })
    ).resolves.toEqual({ ran: true });
    expect(events.at(-1)?.type).toBe("lease_lost");
  });

  it("has the server run the claim when the server rejects the device's result", async () => {
    const { request, paths } = api({
      "/claims": () => ({ claim: claimFor("r1"), nextDueInMs: null }),
      "/settle": () => {
        throw new HttpError(400);
      },
      "/execute": done
    });
    const events: DaemonLaneEvent[] = [];
    await runNextBrowserTask({
      request,
      device: () => ({ modelId: "m", generate: async () => "x".repeat(40_000) }),
      report: (event) => events.push(event)
    });
    expect(paths()).toEqual([
      "/v1/daemon/claims",
      "/v1/daemon/claims/r1/settle",
      "/v1/daemon/claims/r1/execute"
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "claimed",
      "device_failed",
      "server_completed"
    ]);
  });

  it("reports a release that failed, never a release that did not happen", async () => {
    const { request } = api({
      "/claims": () => ({ claim: claimFor("r2"), nextDueInMs: null }),
      "/release": () => {
        throw new HttpError(401);
      }
    });
    const stopping = new AbortController();
    stopping.abort();
    const events: DaemonLaneEvent[] = [];
    await runNextBrowserTask(
      { request, device: () => null, report: (event) => events.push(event) },
      stopping.signal
    );
    expect(events.map((event) => event.type)).toEqual(["claimed", "release_failed"]);
  });

  it("counts lease ownership from when the claim was sent, not when it arrived", async () => {
    let renewals = 0;
    // The claim takes 9s to come back on a 15s lease: 2/3 of it (10s) is nearly gone.
    const { request } = api({
      "/claims": async () => {
        await new Promise((resolve) => setTimeout(resolve, 9_000));
        return { claim: claimFor("r3", 15_000), nextDueInMs: null };
      },
      "/renew": () => {
        renewals++;
        throw new TypeError("Failed to fetch");
      }
    });
    const events: DaemonLaneEvent[] = [];
    const running = runNextBrowserTask({
      request,
      device: () => ({ modelId: "m", generate: (_m, signal) => neverEnding(signal) }),
      report: (event) => events.push(event)
    });
    await vi.advanceTimersByTimeAsync(9_000);
    // A renewal goes out at once (the claim was slow); it fails, and the first check 5s after
    // arrival (14s after sending) is past 2/3 of the lease, so the claim is abandoned.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await running).toEqual({ ran: true });
    expect(events.at(-1)?.type).toBe("lease_lost");
    expect(renewals).toBe(1);
  });

  it("keeps a slowly delivered claim alive by renewing at once", async () => {
    let renewals = 0;
    // 11s of a 15s lease gone before the claim arrives.
    const { request, paths } = api({
      "/claims": async () => {
        await new Promise((resolve) => setTimeout(resolve, 11_000));
        return { claim: claimFor("r4", 15_000), nextDueInMs: null };
      },
      "/renew": () => {
        renewals++;
        return { renewed: true };
      },
      "/settle": done
    });
    let finish: (text: string) => void = () => {};
    const events: DaemonLaneEvent[] = [];
    const running = runNextBrowserTask({
      request,
      device: () => ({
        modelId: "m",
        generate: () => new Promise<string>((resolve) => (finish = resolve))
      }),
      report: (event) => events.push(event)
    });
    await vi.advanceTimersByTimeAsync(11_000);
    expect(renewals).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    finish("done");
    expect(await running).toEqual({ ran: true });
    expect(events.at(-1)?.type).toBe("device_completed");
    expect(paths().at(-1)).toBe("/v1/daemon/claims/r4/settle");
  });

  it("leaves no abort listener behind, however many tasks it runs", async () => {
    const { request } = api({
      "/claims": () => ({ claim: claimFor("t9"), nextDueInMs: null }),
      "/settle": done
    });
    const lane = new AbortController();
    let added = 0;
    let removed = 0;
    const add = lane.signal.addEventListener.bind(lane.signal);
    const remove = lane.signal.removeEventListener.bind(lane.signal);
    lane.signal.addEventListener = ((...args: Parameters<typeof add>) => {
      added++;
      add(...args);
    }) as typeof add;
    lane.signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
      removed++;
      remove(...args);
    }) as typeof remove;
    for (let index = 0; index < 20; index++)
      await runNextBrowserTask(
        { request, device: () => ({ modelId: "m", generate: async () => "ok" }) },
        lane.signal
      );
    expect(added).toBe(20);
    expect(removed).toBe(20);
  });
});

describe("browser daemon lane: the loop", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const loopWith = (
    request: BrowserDaemonLaneDependencies["request"],
    extra: Partial<Parameters<typeof startBrowserDaemonLane>[0]> = {}
  ) => {
    let wake: () => void = () => {};
    const stop = startBrowserDaemonLane({
      request,
      device: () => null,
      isActive: () => true,
      exclusive: (action) => action(),
      onWake: (listener) => {
        wake = listener;
        return () => undefined;
      },
      minPollMs: 1_000,
      idlePollMs: 60_000,
      ...extra
    });
    return { stop, wake: () => wake() };
  };

  it("sleeps until the user's next task is due, within its bounds, and wakes on demand", async () => {
    const delays = [5_000, 10, null];
    let claims = 0;
    const { request } = api({
      "/claims": () => ({ claim: null, nextDueInMs: delays[Math.min(claims++, 2)] })
    });
    const lane = loopWith(request);
    await vi.advanceTimersByTimeAsync(0);
    expect(claims).toBe(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(claims).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(claims).toBe(2);
    // Due in 10ms still waits the minimum: an open tab never polls faster than minPollMs.
    await vi.advanceTimersByTimeAsync(999);
    expect(claims).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(claims).toBe(3);
    // Nothing queued: the idle pace.
    await vi.advanceTimersByTimeAsync(59_999);
    expect(claims).toBe(3);
    lane.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(claims).toBe(4);
    lane.stop();
  });

  it("runs at most maxTasksPerWake tasks back to back, then yields", async () => {
    let claims = 0;
    const { request } = api({
      "/claims": () => {
        claims++;
        return { claim: claimFor(`t${claims}`), nextDueInMs: null };
      },
      "/execute": done
    });
    const lane = loopWith(request, { maxTasksPerWake: 3 });
    await vi.advanceTimersByTimeAsync(0);
    expect(claims).toBe(3);
    await vi.advanceTimersByTimeAsync(999);
    expect(claims).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(claims).toBe(6);
    lane.stop();
  });

  it("works only while active and backs off after failures", async () => {
    let active = false;
    let claims = 0;
    let failing = false;
    const { request } = api({
      "/claims": () => {
        claims++;
        if (failing) throw new HttpError(503);
        return { claim: null, nextDueInMs: 0 };
      }
    });
    const lane = loopWith(request, { isActive: () => active });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(claims).toBe(0);
    active = true;
    lane.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(claims).toBe(1);
    failing = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(claims).toBe(2);
    // After one failure the next look waits 2s, after two 4s.
    await vi.advanceTimersByTimeAsync(1_999);
    expect(claims).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(claims).toBe(3);
    lane.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(claims).toBe(3);
  });

  it("skips a round when another tab holds the lane", async () => {
    const { request, calls } = api({ "/claims": () => ({ claim: null, nextDueInMs: null }) });
    const lane = loopWith(request, { exclusive: async () => null });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(calls).toHaveLength(0);
    lane.stop();
  });

  it("looks again soon, not at the idle pace, while another tab holds the lane", async () => {
    let held = true;
    let claims = 0;
    const { request } = api({
      "/claims": () => {
        claims++;
        return { claim: null, nextDueInMs: null };
      }
    });
    const lane = loopWith(request, {
      exclusive: async (action) => (held ? null : action())
    });
    await vi.advanceTimersByTimeAsync(500);
    held = false;
    // minPollMs is 1s here; the idle pace (60s) would leave the new tab waiting.
    await vi.advanceTimersByTimeAsync(600);
    expect(claims).toBe(1);
    await lane.stop();
  });

  it("stops its batch when the tab stops being active", async () => {
    let active = true;
    let claims = 0;
    const { request } = api({
      "/claims": () => {
        claims++;
        if (claims === 2) active = false;
        return { claim: claimFor(`a${claims}`), nextDueInMs: null };
      },
      "/execute": done
    });
    const lane = loopWith(request, { isActive: () => active, maxTasksPerWake: 10 });
    await vi.advanceTimersByTimeAsync(0);
    expect(claims).toBe(2);
    await lane.stop();
  });

  it("stopped during a claim request: releases what came back, logs no error, stops cleanly", async () => {
    let answer: (value: unknown) => void = () => {};
    const { request, paths } = api({
      "/claims": () => new Promise((resolve) => (answer = resolve)),
      "/release": done
    });
    const events: DaemonLaneEvent[] = [];
    const lane = loopWith(request, { report: (event) => events.push(event) });
    await vi.advanceTimersByTimeAsync(0);
    const stopped = lane.stop();
    answer({ claim: claimFor("s1"), nextDueInMs: null });
    await stopped;
    expect(paths()).toEqual(["/v1/daemon/claims", "/v1/daemon/claims/s1/release"]);
    expect(events.map((event) => event.type)).toEqual(["claimed", "released"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resolves stop only after the task in progress is released", async () => {
    let released = false;
    const { request } = api({
      "/claims": () => ({ claim: claimFor("s2"), nextDueInMs: null }),
      "/release": async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        released = true;
        return done();
      }
    });
    const lane = loopWith(request, {
      device: () => ({ modelId: "m", generate: (_m, signal) => neverEnding(signal) })
    });
    await vi.advanceTimersByTimeAsync(50);
    const stopped = lane.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(released).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await stopped;
    expect(released).toBe(true);
  });

  it("stopping mid-task releases the claim and makes no further requests", async () => {
    const { request, paths } = api({
      "/claims": () => ({ claim: claimFor("t1"), nextDueInMs: null }),
      "/release": done
    });
    const lane = loopWith(request, {
      device: () => ({ modelId: "m", generate: (_m, signal) => neverEnding(signal) })
    });
    await vi.advanceTimersByTimeAsync(100);
    lane.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(paths()).toEqual(["/v1/daemon/claims", "/v1/daemon/claims/t1/release"]);
  });
  it("preserves a wake received while an idle claim request is in flight", async () => {
    let answer: (value: unknown) => void = () => {};
    let claims = 0;
    const { request } = api({
      "/claims": () => {
        claims++;
        return claims === 1
          ? new Promise((resolve) => {
              answer = resolve;
            })
          : { claim: null, nextDueInMs: null };
      }
    });
    const lane = loopWith(request);
    await vi.advanceTimersByTimeAsync(0);
    lane.wake();
    answer({ claim: null, nextDueInMs: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(claims).toBe(2);
    await lane.stop();
  });
});
