/**
 * The resource-exhaustion acceptance test required by
 * docs/architecture/resource-isolation.md §23: a BACKGROUND workload consumes its entire
 * permitted budget, and a CRITICAL/IMPORTANT operation must still succeed using its own
 * protected capacity. This is the test that proves the bulkhead architecture actually works -
 * not a toy example, but the real `createBulkhead` primitive and the real, production
 * resource-control primitives directly.
 */
import { describe, expect, it } from "vitest";
import {
  BulkheadRejectedError,
  createBulkhead
} from "@grogoni/resource-control";

describe("resource exhaustion acceptance", () => {
  it("a saturated background bulkhead rejects new work while an independent critical bulkhead is unaffected", async () => {
    const backgroundBulkhead = createBulkhead({
      name: "background-workload",
      workloadClass: "background",
      maxConcurrency: 1,
      maxQueue: 0
    });
    const criticalBulkhead = createBulkhead({
      name: "critical-workload",
      workloadClass: "critical",
      maxConcurrency: 2,
      maxQueue: 2
    });

    // BACKGROUND consumes its entire permitted budget (its one concurrency slot, no queue).
    let releaseBackground!: () => void;
    const backgroundHold = backgroundBulkhead.run(
      () => new Promise<void>((resolve) => (releaseBackground = resolve))
    );
    await Promise.resolve();
    expect(backgroundBulkhead.stats()).toMatchObject({ active: 1, maxConcurrency: 1 });

    // A further BACKGROUND operation now hits capacity and is rejected immediately - it does not
    // hang, and it does not silently steal capacity from anything else.
    await expect(backgroundBulkhead.run(async () => "rejected")).rejects.toBeInstanceOf(
      BulkheadRejectedError
    );

    // CRITICAL still executes successfully, using its own protected capacity - BACKGROUND being
    // fully saturated has zero effect on it, because they are separate bulkheads with separate
    // budgets, exactly as docs/architecture/resource-isolation.md §13's bulkhead diagram requires.
    const criticalResult = await criticalBulkhead.run(async () => "critical operation completed");
    expect(criticalResult).toBe("critical operation completed");
    expect(criticalBulkhead.stats()).toMatchObject({ active: 0 });

    releaseBackground();
    await backgroundHold;
  });
});
