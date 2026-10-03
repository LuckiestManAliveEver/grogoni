/**
 * Resource-isolation workload classification (docs/architecture/resource-isolation.md). Every
 * bounded-concurrency call site (inference, OCR, future expensive workloads) and every
 * resource-pressure metric/log event is labeled with one of these three classes, so the classes
 * stay a shared enum rather than ad hoc string literals drifting between call sites.
 *
 * - "critical": the commerce path a merchant/buyer is blocked on right now - auth, session
 *   restoration, conversation persistence, catalogue reads, order/payment state. Grogoni has no
 *   bounded-concurrency gate on this class today (see resource-isolation.md §0/§3) because the
 *   business store is in-process/in-memory and does not contend for the resources this module
 *   protects; the class still exists so call sites and telemetry have a name for "never shed this."
 * - "important": work a user is actively waiting on but that calls an external/expensive
 *   dependency - inference (an agent turn), OCR triggered synchronously by a user action.
 * - "background": work nobody is watching in real time - scheduled runners, retention sweeps,
 *   analytics, indexing. Safe to defer, degrade, or reject under pressure before "important" work
 *   is touched, and before "critical" work is touched at all.
 */
export type WorkloadClass = "critical" | "important" | "background";

export const workloadClasses = [
  "critical",
  "important",
  "background"
] as const satisfies readonly WorkloadClass[];

export function isWorkloadClass(value: unknown): value is WorkloadClass {
  return (workloadClasses as readonly unknown[]).includes(value);
}
