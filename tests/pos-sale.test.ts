import { describe, expect, it, vi } from "vitest";
import type { InvoiceSummary } from "@grogoni/shared-types";

import {
  completePosSale,
  PosPaymentRecordingError,
  type PosSaleInput
} from "../apps/web/src/pos-sale";
import type { RecordPaymentResponse } from "../apps/web/src/grogoni-application-shared";

const draft: InvoiceSummary = {
  id: "invoice-1",
  businessId: "business-1",
  invoiceNumber: "INV-001",
  status: "draft",
  customerId: "customer-1",
  customerName: "Amina",
  items: [
    {
      id: "item-1",
      invoiceId: "invoice-1",
      productId: "product-1",
      productName: "Tea",
      quantity: 2,
      unitPrice: 100,
      lineTotal: 200
    }
  ],
  subtotal: 200,
  taxRate: 0.16,
  taxTotal: 32,
  total: 232,
  confirmedAt: null,
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z"
};

const confirmed: InvoiceSummary = {
  ...draft,
  status: "confirmed",
  confirmedAt: "2026-08-23T00:01:00.000Z",
  updatedAt: "2026-08-23T00:01:00.000Z"
};

const input: PosSaleInput = {
  businessId: "business-1",
  customerId: "customer-1",
  customerName: null,
  taxRate: 0.16,
  items: [
    {
      productId: "product-1",
      productName: "Tea",
      quantity: 2,
      unitPrice: 100
    }
  ],
  payment: {
    collectNow: true,
    method: "cash",
    reference: null
  }
};

const recordedPayment: RecordPaymentResponse = {
  payment: {
    id: "payment-1",
    businessId: "business-1",
    invoiceId: "invoice-1",
    invoiceNumber: "INV-001",
    customerId: "customer-1",
    customerName: "Amina",
    method: "cash",
    amount: 232,
    reference: null,
    note: "Recorded through the POS terminal",
    actorId: "owner-1",
    createdAt: "2026-08-23T00:02:00.000Z"
  },
  invoicePayment: {
    invoiceId: "invoice-1",
    businessId: "business-1",
    invoiceNumber: "INV-001",
    customerId: "customer-1",
    customerName: "Amina",
    invoiceTotal: 232,
    paidTotal: 232,
    balanceDue: 0,
    status: "paid"
  }
};

describe("POS sale commit", () => {
  it("creates and confirms the canonical invoice before recording payment", async () => {
    const request = vi.fn(async <TResponse>(path: string): Promise<TResponse> => {
      if (path.endsWith("/confirm")) return { invoice: confirmed } as TResponse;
      if (path.endsWith("/payments")) return recordedPayment as TResponse;
      return draft as TResponse;
    });

    await expect(completePosSale(input, request)).resolves.toEqual({
      invoice: confirmed,
      payment: recordedPayment
    });
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "/businesses/business-1/invoices",
      "/businesses/business-1/invoices/invoice-1/confirm",
      "/businesses/business-1/payments"
    ]);
    expect(request.mock.calls[0]?.[1]).toEqual({
      customerId: "customer-1",
      customerName: null,
      taxRate: 0.16,
      items: [{ productId: "product-1", quantity: 2, unitPrice: 100 }]
    });
    expect(request.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({ invoiceId: "invoice-1", amount: 232, method: "cash" })
    );
  });

  it("keeps a confirmed invoice unpaid when payment is deferred", async () => {
    const request = vi.fn(
      async <TResponse>(path: string): Promise<TResponse> =>
        (path.endsWith("/confirm") ? { invoice: confirmed } : draft) as TResponse
    );

    await expect(
      completePosSale({ ...input, payment: { ...input.payment, collectNow: false } }, request)
    ).resolves.toEqual({ invoice: confirmed, payment: null });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("reports a partial success when payment fails after stock moved", async () => {
    const request = vi.fn(async <TResponse>(path: string): Promise<TResponse> => {
      if (path.endsWith("/confirm")) return { invoice: confirmed } as TResponse;
      if (path.endsWith("/payments")) throw new Error("payment network unavailable");
      return draft as TResponse;
    });

    const failure = await completePosSale(input, request).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PosPaymentRecordingError);
    expect((failure as PosPaymentRecordingError).invoice).toEqual(confirmed);
    expect(request).toHaveBeenCalledTimes(3);
  });
});
