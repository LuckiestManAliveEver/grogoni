// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MerchantWorkspaceDashboard } from "../apps/web/src/MerchantWorkspaceDashboard";
import type { InvoiceSummary, ProductSummary } from "../apps/web/src/grogoni-application-shared";

// Regression coverage for audit A27 ("Merchant workspace",
// docs/audits/grogoni-home-2026-09-17/audit.md): the reference is a single screen combining today's
// numbers, recent orders, and catalogue; production's workspace was a modal hub of 18 separate
// cards with no combined view. This mounts the real component end to end.
function invoice(overrides: Partial<InvoiceSummary> = {}): InvoiceSummary {
  return {
    id: "invoice-1",
    businessId: "business-1",
    invoiceNumber: "SK-2288",
    status: "confirmed",
    customerId: "customer-1",
    customerName: "Grace W.",
    items: [
      {
        id: "item-1",
        invoiceId: "invoice-1",
        productId: "p1",
        productName: "25kg beans",
        quantity: 1,
        unitPrice: 4200,
        lineTotal: 4200
      }
    ],
    confirmedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    subtotal: 4200,
    taxRate: 0,
    taxTotal: 0,
    total: 4200,
    ...overrides
  };
}

function product(overrides: Partial<ProductSummary> = {}): ProductSummary {
  return {
    id: "product-1",
    businessId: "business-1",
    name: "Rice",
    sku: null,
    unit: "10kg",
    // Real low-stock threshold (services/api/src/cp2/store.ts): quantity > 0 and <= 2.
    quantity: 2,
    buyingPrice: null,
    sellingPrice: 1650,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

describe("MerchantWorkspaceDashboard (audit A27)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("shows the shop name, today's real stats, recent orders, and catalogue", async () => {
    const invoices = [invoice()];
    const products = [product()];

    await act(async () => {
      root = createRoot(host);
      root.render(
        <MerchantWorkspaceDashboard
          businessName="Mwangaza Cereals"
          invoices={invoices}
          products={products}
          onBack={vi.fn()}
          onOpenInvoices={vi.fn()}
          onOpenCatalogue={vi.fn()}
        />
      );
    });

    expect(host.textContent).toContain("Mwangaza Cereals");
    expect(host.textContent).toContain("Business workspace");
    expect(host.querySelector(".merchant-dashboard-stats")?.textContent).toContain("Orders today");
    expect(host.textContent).toContain("SK-2288");
    expect(host.textContent).toContain("Grace W.");
    expect(host.textContent).toContain("Rice, 10kg");
    expect(host.textContent).toContain("Low stock — 2 left");
  });

  it("shows honest empty states instead of fabricating orders or products", async () => {
    await act(async () => {
      root = createRoot(host);
      root.render(
        <MerchantWorkspaceDashboard
          businessName="New Shop"
          invoices={[]}
          products={[]}
          onBack={vi.fn()}
          onOpenInvoices={vi.fn()}
          onOpenCatalogue={vi.fn()}
        />
      );
    });

    expect(host.textContent).toContain("No orders yet.");
    expect(host.textContent).toContain("No products yet.");
  });

  it("wires Back, See all (orders), and See all (catalogue) to their real callbacks", async () => {
    const onBack = vi.fn();
    const onOpenInvoices = vi.fn();
    const onOpenCatalogue = vi.fn();

    await act(async () => {
      root = createRoot(host);
      root.render(
        <MerchantWorkspaceDashboard
          businessName="Mwangaza Cereals"
          invoices={[invoice()]}
          products={[product()]}
          onBack={onBack}
          onOpenInvoices={onOpenInvoices}
          onOpenCatalogue={onOpenCatalogue}
        />
      );
    });

    act(() => {
      host.querySelector<HTMLButtonElement>(".merchant-dashboard-back")!.click();
    });
    expect(onBack).toHaveBeenCalledTimes(1);

    const seeAllButtons = host.querySelectorAll<HTMLButtonElement>(
      ".merchant-dashboard-section-heading button"
    );
    expect(seeAllButtons).toHaveLength(2);
    act(() => seeAllButtons[0]!.click());
    expect(onOpenInvoices).toHaveBeenCalledTimes(1);
    act(() => seeAllButtons[1]!.click());
    expect(onOpenCatalogue).toHaveBeenCalledTimes(1);
  });
});
