import { describe, expect, it } from "vitest";
import { parseInventoryTaskObjective } from "./inventory-task-objective.js";

describe("bounded inventory task objective", () => {
  it("compiles the acceptance request without inventing constraints", () => {
    expect(
      parseInventoryTaskObjective(
        "Check my inventory, identify products likely to run out within three days, compare available suppliers, and prepare purchase orders within a KES 15,000 budget."
      )
    ).toEqual({ kind: "PREPARE", budgetMinor: 1500000, currency: "KES", horizonDays: 3 });
  });
  it("preserves exact minor-unit arithmetic", () => {
    expect(parseInventoryTaskObjective("Reorder inventory for 3 days with KES 100.25")).toEqual({
      kind: "PREPARE",
      budgetMinor: 10025,
      currency: "KES",
      horizonDays: 3
    });
  });
  it.each([
    "Reorder inventory",
    "Reorder inventory within three days",
    "Reorder inventory with KES 15,000",
    "Reorder inventory for 3 days with KES 1,23",
    "Reorder inventory for 3 days with KES 10.123",
    "Reorder inventory for 0 days with KES 10",
    "Reorder inventory for 366 days with KES 10",
    "Reorder inventory for 3 days with KES 0",
    "Reorder inventory for 3 days with KES 9999999999999999999",
    "Reorder inventory for 3 days with KES 10 or KES 20",
    "Reorder inventory for 3 days or within 4 days with KES 10",
    "Prepare and submit purchase orders for inventory within three days for KES 15,000",
    "Don't reorder inventory for 3 days with KES 10",
    "Reorder inventory for 3 days with KES 10e3",
    "Reorder inventory for 3 days with KES 10 or USD 20"
  ])("asks rather than assuming unsupported or ambiguous intent: %s", (text) => {
    expect(parseInventoryTaskObjective(text).kind).toBe("CLARIFY");
  });
  it("leaves unrelated chat to the existing runtime", () => {
    expect(parseInventoryTaskObjective("Show my invoices")).toEqual({ kind: "OTHER" });
  });
});
