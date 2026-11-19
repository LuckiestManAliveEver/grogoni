import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request stage timings for Edge domain requests, returned as a `Server-Timing` header and
 * logged as `edge_request_timing`. They show where an Edge request's time goes (transaction
 * open, tenant locks, snapshot load, route app build, handler, persistence, commit) so latency
 * work is driven by measurements rather than guesses. Durations only: no payloads or identifiers.
 */
export interface RequestTiming {
  readonly startedAt: number;
  readonly stages: Map<string, number>;
}

const timingContext = new AsyncLocalStorage<RequestTiming>();
const stageName = /^[a-z][a-zA-Z0-9]{0,31}$/u;

export function runWithRequestTiming<T>(work: () => Promise<T>): Promise<T> {
  return timingContext.run({ startedAt: performance.now(), stages: new Map() }, work);
}

export function currentRequestTiming(): RequestTiming | undefined {
  return timingContext.getStore();
}

/** Adds elapsed milliseconds to a stage. Stages repeated in one request (retries) accumulate. */
export function recordStage(name: string, milliseconds: number): void {
  const timing = timingContext.getStore();
  if (timing === undefined || !stageName.test(name) || !Number.isFinite(milliseconds)) return;
  timing.stages.set(name, (timing.stages.get(name) ?? 0) + Math.max(0, milliseconds));
}

/** Times `work` as one stage of the current request; a no-op outside a timed request. */
export async function timeStage<T>(name: string, work: () => Promise<T> | T): Promise<T> {
  const started = performance.now();
  try {
    return await work();
  } finally {
    recordStage(name, performance.now() - started);
  }
}

/** `Server-Timing` value: each stage, then `total` (whole request inside the domain routes). */
export function serverTimingHeader(timing: RequestTiming, now = performance.now()): string {
  const entries = [...timing.stages].map(([name, ms]) => `${name};dur=${ms.toFixed(1)}`);
  entries.push(`total;dur=${(now - timing.startedAt).toFixed(1)}`);
  return entries.join(", ");
}
