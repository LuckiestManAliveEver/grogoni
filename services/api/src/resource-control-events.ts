import type { BulkheadEvent, CircuitBreakerEvent } from "@grogoni/resource-control";

/**
 * The one event union every bounded workload (OCR, inference - see
 * docs/architecture/resource-isolation.md) emits through the same `onEvent` callback shape, so
 * index.ts can wire all of them into structured logs and Prometheus metrics in one place instead
 * of once per workload. Mirrors the structured-event names in resource-isolation.md §18
 * (`resource.capacity_reached`, `resource.operation_rejected`, `dependency.circuit_opened`,
 * `dependency.circuit_closed`).
 */
export type ResourceControlEvent = BulkheadEvent | CircuitBreakerEvent;

export function resourceControlEventName(event: ResourceControlEvent): string {
  switch (event.type) {
    case "capacity_reached":
      return "resource.capacity_reached";
    case "operation_rejected":
      return "resource.operation_rejected";
    case "opened":
      return "dependency.circuit_opened";
    case "closed":
      return "dependency.circuit_closed";
    case "half_open_probe":
      return "dependency.circuit_half_open_probe";
  }
}
