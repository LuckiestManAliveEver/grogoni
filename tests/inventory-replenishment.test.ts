import { describe, expect, it } from "vitest";
import {
  planInventoryReplenishment,
  type InventoryReplenishmentObservation
} from "../packages/business-core/src/domains/inventory-replenishment";

const now = new Date("2026-01-01T12:00:00Z");
function observation(): InventoryReplenishmentObservation {
  const offer = {
    businessId: "business",
    supplierActive: true,
    currency: "KES",
    minQuantityMilli: 1000,
    incrementMilli: 1000,
    availableQuantityMilli: 100_000,
    leadTimeDays: 0,
    expiresAt: "2026-01-02T12:00:00Z",
    sourceRef: "quote:authoritative"
  };
  return {
    businessId: "business",
    observedAt: now.toISOString(),
    sourceRefs: ["inventory:committed"],
    products: [
      {
        id: "beans",
        businessId: "business",
        onHandMilli: 1000,
        dailyDemandMilli: 2000,
        demandSourceRefs: ["sales:beans:7d"]
      },
      {
        id: "rice",
        businessId: "business",
        onHandMilli: 10_000,
        dailyDemandMilli: 5000,
        demandSourceRefs: ["sales:rice:7d"]
      }
    ],
    offers: [
      {
        ...offer,
        id: "beans-expensive",
        productId: "beans",
        supplierId: "supplier-a",
        unitPriceMinor: 30_000
      },
      {
        ...offer,
        id: "beans-cheap",
        productId: "beans",
        supplierId: "supplier-b",
        unitPriceMinor: 20_000
      },
      {
        ...offer,
        id: "rice",
        productId: "rice",
        supplierId: "supplier-c",
        unitPriceMinor: 100_000,
        leadTimeDays: 1
      }
    ]
  };
}
const plan = (state = observation(), budgetMinor = 1_500_000) =>
  planInventoryReplenishment({
    businessId: "business",
    budgetMinor,
    currency: "KES",
    horizonDays: 3,
    observation: state,
    now
  });
describe("evidence-bound inventory replenishment planning", () => {
  it("compares suppliers and covers the three-day horizon within KES 15,000", () => {
    const result = plan();
    expect(result.status).toBe("READY");
    expect(result.totalMinor).toBe(600_000);
    expect(result.remainingBudgetMinor).toBe(900_000);
    expect(result.items).toMatchObject([
      {
        productId: "beans",
        quoteId: "beans-cheap",
        quantityMilli: 5000,
        totalMinor: 100_000,
        comparedQuoteIds: ["beans-cheap", "beans-expensive"]
      },
      { productId: "rice", quoteId: "rice", quantityMilli: 5000, totalMinor: 500_000 }
    ]);
  });
  it("compares actual order totals, including supplier minimums, not just unit prices", () => {
    const state = observation();
    state.offers[0]!.unitPriceMinor = 10_000;
    state.offers[0]!.minQuantityMilli = 100_000;
    expect(plan(state).items[0]!.quoteId).toBe("beans-cheap");
  });
  it("prioritizes nearer stockouts and never spends beyond the authorized budget", () => {
    const result = plan(observation(), 100_000);
    expect(result.status).toBe("PARTIAL");
    expect(result.totalMinor).toBe(100_000);
    expect(result.items.map((item) => item.productId)).toEqual(["beans"]);
    expect(result.issues).toEqual([{ productId: "rice", code: "BUDGET_INSUFFICIENT" }]);
    expect(plan(observation(), 0).status).toBe("BLOCKED");
  });
  it.each(["expired", "currency", "inactive", "late", "unavailable"])(
    "excludes a cheaper quote that is %s",
    (reason) => {
      const state = observation();
      const quote = state.offers[1]!;
      if (reason === "expired") quote.expiresAt = now.toISOString();
      if (reason === "currency") quote.currency = "USD";
      if (reason === "inactive") quote.supplierActive = false;
      if (reason === "late") quote.leadTimeDays = 1;
      if (reason === "unavailable") quote.availableQuantityMilli = 1000;
      expect(plan(state).items[0]!.quoteId).toBe("beans-expensive");
    }
  );
  it("does not invent missing demand or suppliers", () => {
    const state = observation();
    state.products[0]!.dailyDemandMilli = null;
    state.offers = state.offers.filter((offer) => offer.productId !== "rice");
    const result = plan(state);
    expect(result.status).toBe("BLOCKED");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        { productId: "beans", code: "MISSING_DEMAND" },
        { productId: "rice", code: "NO_ELIGIBLE_SUPPLIER" }
      ])
    );
    expect(result.items).toEqual([]);
  });
  it("blocks an empty inventory instead of claiming no replenishment is needed", () => {
    const state = observation();
    state.products = [];
    state.offers = [];
    expect(plan(state)).toMatchObject({
      status: "BLOCKED",
      items: [],
      issues: [{ productId: null, code: "MISSING_INVENTORY" }]
    });
  });
  it("requires a fresh authoritative observation", () => {
    const state = observation();
    state.observedAt = "2026-01-01T11:44:59Z";
    expect(plan(state)).toMatchObject({
      status: "BLOCKED",
      items: [],
      issues: [{ code: "STALE_OBSERVATION" }]
    });
    state.observedAt = "2026-01-01T12:00:01Z";
    expect(plan(state).status).toBe("BLOCKED");
  });
  it("rounds fractional-unit monetary costs up in integer minor units", () => {
    const state = observation();
    state.products = [{ ...state.products[0]!, onHandMilli: 1250, dailyDemandMilli: 500 }];
    state.offers = [
      { ...state.offers[1]!, unitPriceMinor: 101, minQuantityMilli: 1, incrementMilli: 1 }
    ];
    expect(plan(state).items[0]).toMatchObject({ quantityMilli: 250, totalMinor: 26 });
  });
  it("rejects cross-business observations, malformed prices and unsafe numeric budgets", () => {
    const state = observation();
    state.offers[0]!.businessId = "other";
    expect(() => plan(state)).toThrow("cross-business");
    const invalid = observation();
    invalid.offers[0]!.unitPriceMinor = -1;
    expect(() => plan(invalid)).toThrow("Invalid");
    expect(() => plan(observation(), 1.5)).toThrow("Invalid");
  });
  it("is deterministic across source ordering and does not mutate evidence", () => {
    const state = observation();
    const before = structuredClone(state);
    const result = plan(state);
    expect(state).toEqual(before);
    state.products.reverse();
    state.offers.reverse();
    expect(plan(state)).toEqual(result);
  });
  it("does not propose purchases when evidenced stock already covers the horizon", () => {
    const state = observation();
    for (const product of state.products) product.onHandMilli = product.dailyDemandMilli! * 3;
    expect(plan(state)).toMatchObject({ status: "NOTHING_TO_REPLENISH", items: [], totalMinor: 0 });
  });
});
