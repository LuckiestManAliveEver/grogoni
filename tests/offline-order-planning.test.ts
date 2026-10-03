import { describe, expect, it } from "vitest";
import type { ProductSummary } from "@grogoni/shared-types";
import {
  matchOfflineOrderProducts,
  offlineOrderClarificationMessage,
  offlineOrderOutcomeMessage,
  parseOfflineOrderText
} from "../services/api/src/cp2/domains/agent-runtime/offline-order-planning";

function product(overrides: Partial<ProductSummary>): ProductSummary {
  return {
    id: overrides.id ?? "product-id",
    businessId: "business",
    name: overrides.name ?? "Product",
    sku: null,
    unit: "unit",
    quantity: 10,
    buyingPrice: null,
    sellingPrice: 100,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("parseOfflineOrderText", () => {
  const products = [
    product({ id: "sugar", name: "Sugar 1kg" }),
    product({ id: "soap", name: "Soap", aliases: ["bar soap"] }),
    product({ id: "soda", name: "Soda 500ml" }),
    product({ id: "soda-can", name: "Soda Can" })
  ];

  it("parses a clean multi-item order into structured items", () => {
    const result = parseOfflineOrderText("2 sugar 1kg, 1 soap", products);
    expect(result.looksLikeOrder).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.items).toEqual([
      { quantity: 2, name: "Sugar 1kg", productId: "sugar" },
      { quantity: 1, name: "Soap", productId: "soap" }
    ]);
  });

  it("matches on an alias", () => {
    const result = parseOfflineOrderText("3 bar soap", products);
    expect(result.items).toEqual([{ quantity: 3, name: "Soap", productId: "soap" }]);
  });

  it("is not an order at all when nothing is quantity-led", () => {
    const result = parseOfflineOrderText("Do you have maize?", products);
    expect(result).toEqual({ looksLikeOrder: false, items: [], problems: [] });
  });

  it("flags a missing quantity and drops the whole order rather than guessing", () => {
    const result = parseOfflineOrderText("2 sugar 1kg, soap", products);
    expect(result.looksLikeOrder).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it("flags an unrecognized product and drops the whole order rather than guessing", () => {
    const result = parseOfflineOrderText("2 sugar 1kg, 1 kerosene", products);
    expect(result.items).toEqual([]);
    expect(result.problems.some((problem) => problem.includes("kerosene"))).toBe(true);
  });

  it("flags an ambiguous product name and drops the whole order rather than guessing", () => {
    const result = parseOfflineOrderText("1 soda", products);
    expect(result.items).toEqual([]);
    expect(result.problems.some((problem) => problem.includes("more than one"))).toBe(true);
  });

  it("rejects a zero or negative quantity", () => {
    const result = parseOfflineOrderText("0 sugar 1kg", products);
    expect(result.items).toEqual([]);
    expect(result.problems.length).toBeGreaterThan(0);
  });
});

describe("matchOfflineOrderProducts", () => {
  it("prefers an exact name match over a substring match", () => {
    const products = [product({ id: "a", name: "Soda" }), product({ id: "b", name: "Soda Can" })];
    expect(matchOfflineOrderProducts(products, "soda").map((p) => p.id)).toEqual(["a"]);
  });

  it("returns every candidate when the substring match is ambiguous", () => {
    const products = [
      product({ id: "a", name: "Soda 500ml" }),
      product({ id: "b", name: "Soda Can" })
    ];
    expect(
      matchOfflineOrderProducts(products, "soda")
        .map((p) => p.id)
        .sort()
    ).toEqual(["a", "b"]);
  });

  it("returns nothing for an empty needle", () => {
    expect(matchOfflineOrderProducts([product({})], "  ")).toEqual([]);
  });
});

describe("offlineOrderClarificationMessage / offlineOrderOutcomeMessage", () => {
  it("builds a deterministic clarification reply from parse problems", () => {
    const first = offlineOrderClarificationMessage(["problem one", "problem two"]);
    const second = offlineOrderClarificationMessage(["problem one", "problem two"]);
    expect(first).toBe(second);
    expect(first).toContain("problem one");
    expect(first).toContain("2 sugar 1kg, 1 soap");
  });

  it("builds distinct deterministic replies per outcome status", () => {
    const confirmed = offlineOrderOutcomeMessage({
      id: "intent",
      status: "confirmed",
      invoiceId: "invoice-1",
      confirmedItems: [{ name: "Sugar 1kg", quantity: 2, productId: "sugar", reason: null }],
      rejectedItems: [],
      message: ""
    });
    expect(confirmed).toContain("confirmed");
    expect(confirmed).toContain("2 Sugar 1kg");

    const partial = offlineOrderOutcomeMessage({
      id: "intent",
      status: "partial",
      invoiceId: "invoice-1",
      confirmedItems: [{ name: "Sugar 1kg", quantity: 1, productId: "sugar", reason: null }],
      rejectedItems: [
        { name: "Soap", quantity: 1, productId: "soap", reason: "Only 0 unit available." }
      ],
      message: ""
    });
    expect(partial).toContain("part of your order");
    expect(partial).toContain("Soap");

    const rejected = offlineOrderOutcomeMessage({
      id: "intent",
      status: "rejected",
      invoiceId: null,
      confirmedItems: [],
      rejectedItems: [
        { name: "Soap", quantity: 1, productId: "soap", reason: "Only 0 unit available." }
      ],
      message: ""
    });
    expect(rejected).toContain("couldn't fulfil");
    expect(rejected).toContain("Soap");
  });
});
