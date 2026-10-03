import { describe, expect, it } from "vitest";

import type { InvoiceSummary } from "../apps/web/src/grogoni-application-shared";
import {
  catalogueForDashboard,
  catalogueStockLabel,
  catalogueStockStatus,
  isSameLocalDay,
  ordersToday,
  pendingOrderCount,
  recentOrders,
  revenueToday
} from "../apps/web/src/merchant-workspace-dashboard";

// Regression coverage for audit A27 ("Merchant workspace",
// docs/audits/grogoni-home-2026-09-17/audit.md): the reference's single-screen dashboard shows
// "Orders today"/"Revenue today"/"Pending"/recent orders/catalogue, but no backend aggregate is
// scoped to "today" - only all-time totals exist (BusinessReportSummary). These pure functions
// derive "today" from real per-invoice timestamps instead of a fabricated number, so they are the
// part worth testing in isolation from the component that renders them.
function invoice(overrides: Partial<InvoiceSummary> = {}): InvoiceSummary {
  return {
    id: "invoice-1",
    businessId: "business-1",
    invoiceNumber: "SK-0001",
    status: "confirmed",
    customerId: "customer-1",
    customerName: "Grace W.",
    items: [
      {
        id: "item-1",
        invoiceId: "invoice-1",
        productId: "p1",
        productName: "beans",
        quantity: 1,
        unitPrice: 100,
        lineTotal: 100
      }
    ],
    confirmedAt: "2026-09-17T09:00:00.000Z",
    createdAt: "2026-09-17T09:00:00.000Z",
    updatedAt: "2026-09-17T09:00:00.000Z",
    subtotal: 100,
    taxRate: 0,
    taxTotal: 0,
    total: 100,
    ...overrides
  };
}

const today = new Date("2026-09-17T18:00:00.000Z");
const yesterday = "2026-09-16T09:00:00.000Z";

describe("isSameLocalDay", () => {
  it("is true for the same calendar day and false for a different one", () => {
    expect(isSameLocalDay("2026-09-17T09:00:00.000Z", today)).toBe(true);
    expect(isSameLocalDay(yesterday, today)).toBe(false);
  });
});

describe("ordersToday (audit A27)", () => {
  it("counts only invoices created today, regardless of status", () => {
    const invoices = [
      invoice({ id: "1", createdAt: "2026-09-17T08:00:00.000Z" }),
      invoice({ id: "2", createdAt: "2026-09-17T20:00:00.000Z", status: "draft" }),
      invoice({ id: "3", createdAt: yesterday })
    ];
    expect(ordersToday(invoices, today)).toBe(2);
  });
});

describe("revenueToday (audit A27)", () => {
  it("only counts confirmed invoices confirmed today, excluding drafts and other days", () => {
    const invoices = [
      invoice({
        id: "1",
        status: "confirmed",
        confirmedAt: "2026-09-17T08:00:00.000Z",
        total: 4200
      }),
      invoice({
        id: "2",
        status: "draft",
        createdAt: "2026-09-17T09:00:00.000Z",
        confirmedAt: null,
        total: 1650
      }),
      invoice({ id: "3", status: "confirmed", confirmedAt: yesterday, total: 9999 })
    ];
    expect(revenueToday(invoices, today)).toBe(4200);
  });

  it("falls back to createdAt when confirmedAt is missing but the invoice is confirmed", () => {
    const invoices = [
      invoice({
        id: "1",
        status: "confirmed",
        confirmedAt: null,
        createdAt: "2026-09-17T08:00:00.000Z",
        total: 500
      })
    ];
    expect(revenueToday(invoices, today)).toBe(500);
  });
});

describe("pendingOrderCount (audit A27)", () => {
  it("counts draft invoices as pending, confirmed ones as not pending", () => {
    const invoices = [
      invoice({ id: "1", status: "draft" }),
      invoice({ id: "2", status: "draft" }),
      invoice({ id: "3", status: "confirmed" })
    ];
    expect(pendingOrderCount(invoices)).toBe(2);
  });
});

describe("recentOrders (audit A27)", () => {
  it("returns the most recent invoices first, limited, with a real item summary", () => {
    const invoices = [
      invoice({ id: "1", invoiceNumber: "SK-0001", createdAt: "2026-09-15T00:00:00.000Z" }),
      invoice({ id: "2", invoiceNumber: "SK-0002", createdAt: "2026-09-17T00:00:00.000Z" }),
      invoice({ id: "3", invoiceNumber: "SK-0003", createdAt: "2026-09-16T00:00:00.000Z" }),
      invoice({ id: "4", invoiceNumber: "SK-0004", createdAt: "2026-09-14T00:00:00.000Z" })
    ];
    const result = recentOrders(invoices, 3);
    expect(result.map((row) => row.invoiceNumber)).toEqual(["SK-0002", "SK-0003", "SK-0001"]);
  });

  it("summarizes multiple line items as the first item plus a count", () => {
    const multiItem = invoice({
      items: [
        {
          id: "i1",
          invoiceId: "invoice-1",
          productId: "p1",
          productName: "beans",
          quantity: 2,
          unitPrice: 100,
          lineTotal: 200
        },
        {
          id: "i2",
          invoiceId: "invoice-1",
          productId: "p2",
          productName: "maize",
          quantity: 1,
          unitPrice: 50,
          lineTotal: 50
        },
        {
          id: "i3",
          invoiceId: "invoice-1",
          productId: "p3",
          productName: "rice",
          quantity: 1,
          unitPrice: 60,
          lineTotal: 60
        }
      ]
    });
    expect(recentOrders([multiItem], 1)[0]!.itemSummary).toBe("2 beans +2 more");
  });

  it("falls back to a guest label when the invoice has no customer name", () => {
    const guest = invoice({ customerName: null });
    expect(recentOrders([guest], 1)[0]!.customerName).toBe("Guest customer");
  });
});

describe("catalogue stock status/label (audit A27)", () => {
  it("matches the real backend threshold for low stock (quantity > 0 and <= 2)", () => {
    // services/api/src/cp2/store.ts:9513 - not an arbitrary client-side number.
    expect(catalogueStockStatus(0)).toBe("out-of-stock");
    expect(catalogueStockStatus(1)).toBe("low-stock");
    expect(catalogueStockStatus(2)).toBe("low-stock");
    expect(catalogueStockStatus(3)).toBe("available");
  });

  it("labels each status legibly", () => {
    expect(catalogueStockLabel(0)).toBe("Out of stock");
    expect(catalogueStockLabel(2)).toBe("Low stock — 2 left");
    expect(catalogueStockLabel(10)).toBe("Available");
  });
});

describe("catalogueForDashboard (audit A27)", () => {
  it("surfaces out-of-stock and low-stock products before well-stocked ones", () => {
    const products = [
      {
        id: "1",
        businessId: "b1",
        name: "Well stocked",
        sku: null,
        unit: "kg",
        quantity: 50,
        buyingPrice: null,
        sellingPrice: 100,
        createdAt: "",
        updatedAt: ""
      },
      {
        id: "2",
        businessId: "b1",
        name: "Out of stock",
        sku: null,
        unit: "kg",
        quantity: 0,
        buyingPrice: null,
        sellingPrice: 100,
        createdAt: "",
        updatedAt: ""
      },
      {
        id: "3",
        businessId: "b1",
        name: "Low stock",
        sku: null,
        unit: "kg",
        quantity: 1,
        buyingPrice: null,
        sellingPrice: 100,
        createdAt: "",
        updatedAt: ""
      }
    ];
    const result = catalogueForDashboard(products, 3);
    expect(result.map((product) => product.name)).toEqual([
      "Out of stock",
      "Low stock",
      "Well stocked"
    ]);
  });

  it("respects the limit", () => {
    const products = Array.from({ length: 10 }, (_, index) => ({
      id: String(index),
      businessId: "b1",
      name: `Product ${index}`,
      sku: null,
      unit: "kg",
      quantity: 50,
      buyingPrice: null,
      sellingPrice: 100,
      createdAt: "",
      updatedAt: ""
    }));
    expect(catalogueForDashboard(products, 3)).toHaveLength(3);
  });
});
