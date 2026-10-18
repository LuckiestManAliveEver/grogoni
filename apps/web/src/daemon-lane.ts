import type {
  DaemonClaim,
  DaemonClaimResponse,
  DaemonDeviceOutcome,
  PublicDaemonTask
} from "@grogoni/shared-types";

/**
 * The browser lane of the daemon (docs/deployment/daemon-lanes.md). While a signed-in user has the
 * app open, one of their tabs claims their due background tasks and runs them: on an installed
 * on-device model when there is one, otherwise by asking the API to run the claimed task. If the
 * app closes mid-task the lease simply expires; the server takes the task over after its
 * takeover delay. The only credential this code ever holds is a claim's lease token. Timings
 * come from the server (lease length, execute timeout, next due delay), never from comparing
 * server times with this device's clock.
 */

export interface DaemonDeviceRunner {
  modelId: string;
  generate(message: string, signal: AbortSignal): Promise<string>;
}

export interface DaemonLaneRequest {
  <T>(
    path: string,
    init?: { method?: string; body?: unknown; timeoutMs?: number; signal?: AbortSignal }
  ): Promise<T>;
}

export interface DaemonLaneEvent {
  type:
    | "claimed"
    | "device_completed"
    | "device_failed"
    | "server_completed"
    | "released"
    | "release_failed"
    | "lease_lost"
    | "lane_error";
  taskId?: string;
  detail?: string;
}

export interface BrowserDaemonLaneDependencies {
  request: DaemonLaneRequest;
  /** Looked up per task; null when this device cannot run a model (no WebGPU, none installed). */
  device: () => DaemonDeviceRunner | null;
  report?: (event: DaemonLaneEvent) => void;
}

export type BrowserTaskOutcome = { ran: true } | { ran: false; nextDueInMs: number | null };

/** True when the response says this claim is gone (expired, settled, or never ours). */
function leaseLost(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 404 || status === 409;
}

/**
 * Claims and runs one due task. `signal` is the lane stopping (sign-out, unmount): a task in
 * progress is then handed back with /release, never sent to the server to run.
 */
export async function runNextBrowserTask(
  dependencies: BrowserDaemonLaneDependencies,
  signal?: AbortSignal
): Promise<BrowserTaskOutcome> {
  // Not aborted by `signal`: a claim the server commits must come back, so it can be released.
  const sentAt = performance.now();
  const response = await dependencies.request<DaemonClaimResponse>("/v1/daemon/claims", {
    method: "POST",
    body: {}
  });
  if (response.claim === null) return { ran: false, nextDueInMs: response.nextDueInMs };
  await runClaim(dependencies, response.claim, sentAt, signal);
  return { ran: true };
}

async function runClaim(
  { request, device: deviceFor, report }: BrowserDaemonLaneDependencies,
  claim: DaemonClaim,
  claimSentAt: number,
  signal?: AbortSignal
): Promise<void> {
  const taskId = claim.task.id;
  report?.({ type: "claimed", taskId });
  const id = encodeURIComponent(taskId);
  const lease = { leaseToken: claim.leaseToken };
  const executeOnServer = async () => {
    await request<{ task: PublicDaemonTask }>(`/v1/daemon/claims/${id}/execute`, {
      method: "POST",
      body: lease,
      timeoutMs: claim.executeTimeoutMs
    });
    report?.({ type: "server_completed", taskId });
  };
  const release = async () => {
    try {
      await request(`/v1/daemon/claims/${id}/release`, { method: "POST", body: lease });
      report?.({ type: "released", taskId });
    } catch (error) {
      // The lease lapses instead and the task becomes claimable again; one attempt is spent.
      report?.({
        type: leaseLost(error) ? "lease_lost" : "release_failed",
        taskId,
        detail: error instanceof Error ? error.message : "release failed"
      });
    }
  };
  try {
    if (signal?.aborted) return await release();
    const device = claim.message === null ? null : deviceFor();
    if (device === null || claim.message === null) return await executeOnServer();
    const outcome = await generateUnderLease(
      request,
      claim,
      claim.message,
      device,
      claimSentAt,
      signal
    );
    if (outcome === "lost") return report?.({ type: "lease_lost", taskId });
    if (outcome === "stopped") return await release();
    if (outcome.ok) {
      try {
        await request(`/v1/daemon/claims/${id}/settle`, {
          method: "POST",
          body: { ...lease, outcome: outcome.settle }
        });
        return report?.({ type: "device_completed", taskId });
      } catch (error) {
        // The server refused this device's result (too long, not storable): it runs it instead.
        if ((error as { status?: unknown } | null)?.status !== 400) throw error;
        report?.({ type: "device_failed", taskId, detail: "result rejected" });
        return await executeOnServer();
      }
    }
    // The device could not run it (out of memory, model evicted, an empty reply): let the server
    // run the same claim now rather than burn an attempt and make the user wait for a retry.
    report?.({ type: "device_failed", taskId, detail: outcome.detail });
    await executeOnServer();
  } catch (error) {
    if (!leaseLost(error)) throw error;
    report?.({ type: "lease_lost", taskId });
  }
}

/**
 * Runs the device model while renewing the lease every third of its length. A renewal the server
 * refuses means another worker owns the task; renewals that keep failing for two thirds of the
 * lease abandon it before it can lapse under us. Either way nothing is settled.
 */
async function generateUnderLease(
  request: DaemonLaneRequest,
  claim: DaemonClaim,
  message: string,
  device: DaemonDeviceRunner,
  claimSentAt: number,
  signal?: AbortSignal
): Promise<
  "lost" | "stopped" | { ok: true; settle: DaemonDeviceOutcome } | { ok: false; detail: string }
> {
  const path = `/v1/daemon/claims/${encodeURIComponent(claim.task.id)}/renew`;
  const generation = new AbortController();
  const stop = () => generation.abort();
  signal?.addEventListener("abort", stop, { once: true });
  let lost = false;
  // The lease started no earlier than the claim was sent: measuring from then can only
  // underestimate how long it is still held.
  let ownedAt = claimSentAt;
  const renew = () => {
    const sentAt = performance.now();
    void request(path, { method: "POST", body: { leaseToken: claim.leaseToken } }).then(
      () => {
        ownedAt = Math.max(ownedAt, sentAt);
      },
      (error: unknown) => {
        if (leaseLost(error)) {
          lost = true;
          generation.abort();
        }
      }
    );
  };
  // A slow claim response has already used part of the lease: renew at once, so the first
  // check below does not find the claim stale before any renewal was even tried.
  if (performance.now() - claimSentAt >= claim.leaseMs / 3) renew();
  const renewal = setInterval(
    () => {
      if (performance.now() - ownedAt >= (claim.leaseMs * 2) / 3) {
        lost = true;
        generation.abort();
        return;
      }
      renew();
    },
    Math.floor(claim.leaseMs / 3)
  );
  try {
    const text = await device.generate(message, generation.signal);
    if (lost) return "lost";
    if (signal?.aborted) return "stopped";
    if (text.trim() === "") return { ok: false, detail: "empty reply" };
    return { ok: true, settle: { text, modelId: device.modelId } };
  } catch (error) {
    if (lost) return "lost";
    if (signal?.aborted) return "stopped";
    return {
      ok: false,
      detail: error instanceof Error ? error.message : "device generation failed"
    };
  } finally {
    clearInterval(renewal);
    signal?.removeEventListener("abort", stop);
  }
}

export interface BrowserDaemonLaneLoop extends BrowserDaemonLaneDependencies {
  /** Visible, online, and not in explicit offline mode. */
  isActive: () => boolean;
  /** Runs the action only if no other tab holds the lane; resolves null when one does. */
  exclusive: <T>(action: () => Promise<T>) => Promise<T | null>;
  /** Calls the listener when the lane should look again (tab shown, network back). */
  onWake: (listener: () => void) => () => void;
  /** Shortest wait between looks, even when the server says work is due sooner. */
  minPollMs?: number;
  /** Longest wait between looks while idle: picks up tasks created on another device. */
  idlePollMs?: number;
  /** Tasks run back to back before the lane yields and looks again. */
  maxTasksPerWake?: number;
}

/**
 * Starts the lane. The returned function stops it (sign-out, unmount) and resolves once the lane
 * has finished: a task in progress released, no request left in flight.
 */
export function startBrowserDaemonLane(loop: BrowserDaemonLaneLoop): () => Promise<void> {
  const stop = new AbortController();
  const minPollMs = loop.minPollMs ?? 30_000;
  const idlePollMs = loop.idlePollMs ?? 5 * 60_000;
  const maxTasks = loop.maxTasksPerWake ?? 10;
  let failures = 0;
  let wake: (() => void) | null = null;
  // A wake may arrive while a claim/execute request is in flight. Remember it until pause.
  let pendingWake = false;
  const unsubscribe = loop.onWake(() => {
    pendingWake = true;
    wake?.();
  });
  const pause = (ms: number) =>
    stop.signal.aborted || pendingWake
      ? ((pendingWake = false), Promise.resolve())
      : new Promise<void>((resolve) => {
          const timer = setTimeout(finish, ms);
          function finish() {
            clearTimeout(timer);
            wake = null;
            pendingWake = false;
            stop.signal.removeEventListener("abort", finish);
            resolve();
          }
          wake = finish;
          stop.signal.addEventListener("abort", finish, { once: true });
        });
  const finished = (async () => {
    while (!stop.signal.aborted) {
      let waitMs = idlePollMs;
      if (loop.isActive()) {
        try {
          const held = await loop.exclusive(async () => {
            for (let ran = 0; ran < maxTasks && !stop.signal.aborted && loop.isActive(); ran++) {
              const outcome = await runNextBrowserTask(loop, stop.signal);
              if (!outcome.ran) return { next: outcome.nextDueInMs };
            }
            // Ran a full batch, or became inactive: look again soon.
            return { next: 0 };
          });
          failures = 0;
          // Another tab holds the lane (it may be closing, or a previous account's lane still
          // shutting down): look again soon. Nothing queued: the idle pace.
          waitMs =
            held === null
              ? minPollMs
              : held.next === null
                ? idlePollMs
                : Math.min(Math.max(held.next, minPollMs), idlePollMs);
        } catch (error) {
          if (stop.signal.aborted) break;
          failures++;
          loop.report?.({
            type: "lane_error",
            detail: error instanceof Error ? error.message : "lane request failed"
          });
          // Back off after failures (an outage, a 503) so an open tab never hammers the API.
          waitMs = Math.min(minPollMs * 2 ** Math.min(failures, 4), 10 * 60_000);
        }
      }
      await pause(waitMs);
    }
  })();
  return async () => {
    stop.abort();
    unsubscribe();
    await finished;
  };
}
