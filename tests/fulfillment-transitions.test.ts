import { describe, expect, it } from "vitest";
import {
  canTransitionFulfillment,
  type FulfillmentMethod,
  type FulfillmentStatus
} from "../packages/shared-types/src";
import { validateLogisticsStatusTransition } from "../packages/business-core/src";
import { canChangeFulfillment } from "../apps/web/src/LogisticsSurface";

const statuses: FulfillmentStatus[] = [
  "pending",
  "ready",
  "out_for_delivery",
  "completed",
  "cancelled"
];
const methods: FulfillmentMethod[] = ["delivery", "pickup"];
const cases = methods.flatMap((method) =>
  statuses.flatMap((status) => statuses.map((next) => ({ method, status, next })))
);

/** The Logistics buttons' enabled rules before they read the shared table, kept verbatim. */
function previousButtonRule(item: { status: FulfillmentStatus; method: FulfillmentMethod }) {
  return {
    ready: item.status === "pending",
    out_for_delivery: item.method === "delivery" && item.status === "ready",
    completed: !(
      item.status === "completed" ||
      item.status === "cancelled" ||
      (item.method === "delivery" && item.status !== "out_for_delivery") ||
      (item.method === "pickup" && item.status !== "ready")
    ),
    cancelled: !(item.status === "completed" || item.status === "cancelled")
  };
}

describe("fulfillment lifecycle", () => {
  it("server validation accepts exactly the shared table's moves (and staying put)", () => {
    for (const { method, status, next } of cases)
      expect(
        validateLogisticsStatusTransition(status, next, method).ok,
        `${method}: ${status} → ${next}`
      ).toBe(status === next || canTransitionFulfillment(status, next, method));
  });

  it("enables the same Logistics buttons as before, on every reachable record", () => {
    for (const method of methods)
      for (const status of statuses) {
        // A pickup is never out for delivery: the server refuses that move, so skip it.
        if (method === "pickup" && status === "out_for_delivery") continue;
        const before = previousButtonRule({ status, method });
        for (const next of ["ready", "out_for_delivery", "completed", "cancelled"] as const)
          expect(
            canChangeFulfillment({ status, method }, next),
            `${method}: ${status} → ${next}`
          ).toBe(before[next]);
      }
  });

  it("never enables a button the server would refuse", () => {
    for (const { method, status, next } of cases)
      if (canChangeFulfillment({ status, method }, next))
        expect(canTransitionFulfillment(status, next, method)).toBe(true);
  });
});
