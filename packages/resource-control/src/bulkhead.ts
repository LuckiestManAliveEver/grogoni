import type { WorkloadClass } from "@grogoni/shared-types";

/**
 * Structured events a Bulkhead emits at the moments docs/architecture/resource-isolation.md
 * section 18 names (resource.capacity_reached / resource.operation_rejected /
 * resource.operation_timed_out). Callers turn these into log lines and/or metrics; this module
 * has no logging/metrics dependency of its own.
 */
export type BulkheadEvent =
  | {
      type: "capacity_reached";
      name: string;
      workloadClass: WorkloadClass;
      active: number;
      queued: number;
    }
  | {
      type: "operation_rejected";
      name: string;
      workloadClass: WorkloadClass;
      reason: "queue_full" | "queue_timeout";
      active: number;
      queued: number;
    };

export interface BulkheadOptions {
  /** Low-cardinality identifier, e.g. "inference", "ocr" - used in events/metrics labels. */
  name: string;
  workloadClass: WorkloadClass;
  /** Maximum operations allowed to run at once. Must be a positive integer. */
  maxConcurrency: number;
  /**
   * Maximum operations allowed to wait for a slot once `maxConcurrency` is saturated. Must be a
   * non-negative integer; 0 means "reject immediately once full" with no waiting at all - the
   * correct choice for a workload that should never queue (see resource-isolation.md §7).
   */
  maxQueue: number;
  /**
   * Maximum time an operation may wait in the queue before being rejected with
   * `BulkheadRejectedError("queue_timeout")`. Omitted means no queue timeout (an operation waits
   * until a slot frees or the queue is drained by process shutdown) - only safe when the
   * underlying operation already has its own timeout, since an unbounded queue wait plus no
   * per-item timeout is exactly the failure mode this module exists to prevent.
   */
  queueTimeoutMs?: number;
  onEvent?: (event: BulkheadEvent) => void;
}

export class BulkheadRejectedError extends Error {
  constructor(
    readonly bulkheadName: string,
    readonly reason: "queue_full" | "queue_timeout"
  ) {
    super(
      reason === "queue_full"
        ? `Bulkhead "${bulkheadName}" is at capacity and its wait queue is full.`
        : `Bulkhead "${bulkheadName}" timed out waiting for a free slot.`
    );
    this.name = "BulkheadRejectedError";
  }
}

export interface BulkheadStats {
  active: number;
  queued: number;
  maxConcurrency: number;
  maxQueue: number;
}

export interface Bulkhead {
  readonly name: string;
  readonly workloadClass: WorkloadClass;
  /** Runs `fn` once a slot is available, or throws `BulkheadRejectedError` if the queue is full
   *  or the wait times out. Always releases the slot, including when `fn` throws. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  stats(): BulkheadStats;
}

interface QueueEntry {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Creates a bounded-concurrency, bounded-queue gate for one named workload. Generalizes the
 *  private per-file semaphore that used to live in services/api/src/cp2/ocr-provider.ts into one
 *  reusable primitive, shared by every bounded workload (see resource-isolation.md §10). */
export function createBulkhead(options: BulkheadOptions): Bulkhead {
  if (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency < 1) {
    throw new Error(`Bulkhead "${options.name}": maxConcurrency must be a positive integer.`);
  }
  if (!Number.isSafeInteger(options.maxQueue) || options.maxQueue < 0) {
    throw new Error(`Bulkhead "${options.name}": maxQueue must be a non-negative integer.`);
  }
  if (
    options.queueTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.queueTimeoutMs) || options.queueTimeoutMs <= 0)
  ) {
    throw new Error(`Bulkhead "${options.name}": queueTimeoutMs must be a positive integer.`);
  }

  const { name, workloadClass, maxConcurrency, maxQueue, queueTimeoutMs, onEvent } = options;
  let active = 0;
  const queue: QueueEntry[] = [];

  function releaseSlot(): void {
    active -= 1;
    const next = queue.shift();
    if (next === undefined) return;
    if (next.timer !== null) clearTimeout(next.timer);
    active += 1;
    next.resolve();
  }

  async function acquire(): Promise<void> {
    if (active < maxConcurrency) {
      active += 1;
      return;
    }
    onEvent?.({ type: "capacity_reached", name, workloadClass, active, queued: queue.length });
    if (queue.length >= maxQueue) {
      onEvent?.({
        type: "operation_rejected",
        name,
        workloadClass,
        reason: "queue_full",
        active,
        queued: queue.length
      });
      throw new BulkheadRejectedError(name, "queue_full");
    }
    await new Promise<void>((resolve, reject) => {
      const entry: QueueEntry = { resolve, reject, timer: null };
      if (queueTimeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          const index = queue.indexOf(entry);
          if (index !== -1) queue.splice(index, 1);
          onEvent?.({
            type: "operation_rejected",
            name,
            workloadClass,
            reason: "queue_timeout",
            active,
            queued: queue.length
          });
          reject(new BulkheadRejectedError(name, "queue_timeout"));
        }, queueTimeoutMs);
      }
      queue.push(entry);
    });
  }

  return {
    name,
    workloadClass,
    async run(fn) {
      await acquire();
      try {
        return await fn();
      } finally {
        releaseSlot();
      }
    },
    stats() {
      return { active, queued: queue.length, maxConcurrency, maxQueue };
    }
  };
}
