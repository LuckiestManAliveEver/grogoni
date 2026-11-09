import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

interface VerifyOtpResponse {
  session: {
    id: string;
  };
}

interface CreateBusinessResponse {
  business: {
    id: string;
  };
}

interface ProductResponse {
  id: string;
  quantity: number;
}

interface CustomerResponse {
  id: string;
  name: string;
}

interface InvoiceResponse {
  id: string;
  invoiceNumber: string;
  status: "draft" | "confirmed";
  total: number;
}

interface ConfirmInvoiceResponse {
  invoice: InvoiceResponse;
}

interface PaymentResponse {
  payment: {
    id: string;
    invoiceId: string;
    amount: number;
    method: string;
  };
  invoicePayment: {
    invoiceId: string;
    paidTotal: number;
    balanceDue: number;
    status: "unpaid" | "partially_paid" | "paid";
  };
}

interface InvoicePaymentSummaryResponse {
  invoiceId: string;
  paidTotal: number;
  balanceDue: number;
  status: "unpaid" | "partially_paid" | "paid";
}

interface CustomerDebtResponse {
  customerId: string;
  customerName: string;
  invoiceCount: number;
  totalPaid: number;
  balanceDue: number;
}

interface OfflineCacheResponse {
  payments: Array<{ id: string; invoiceId: string }>;
  invoicePaymentSummaries: InvoicePaymentSummaryResponse[];
  customerDebts: CustomerDebtResponse[];
}

interface SyncQueueItemResponse {
  id: string;
  mutationType: string;
  status: "pending" | "processing" | "synced" | "failed" | "conflict";
  result: unknown | null;
  conflict: {
    code: string;
  } | null;
}

interface SyncReplayItemResponse {
  replayed: boolean;
  item: SyncQueueItemResponse;
}

describe("CP8 payments and customer debt", () => {
  it("records partial and full payments without mutating inventory", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);
    const customer = await postJson<CustomerResponse>(
      app,
      `/businesses/${businessId}/customers`,
      {
        name: "Amina"
      },
      sessionCookie
    );
    const product = await postJson<ProductResponse>(
      app,
      `/businesses/${businessId}/products`,
      {
        name: "Rice",
        quantity: 5
      },
      sessionCookie
    );
    const draft = await postJson<InvoiceResponse>(
      app,
      `/businesses/${businessId}/invoices`,
      {
        customerId: customer.id,
        items: [
          {
            productId: product.id,
            quantity: 2,
            unitPrice: 100
          }
        ]
      },
      sessionCookie
    );

    const draftPayment = await app.inject({
      method: "POST",
      url: `/businesses/${businessId}/payments`,
      headers: {
        ...jsonHeaders(),
        cookie: sessionCookie
      },
      payload: JSON.stringify({
        invoiceId: draft.id,
        amount: 50,
        method: "cash"
      })
    });
    expect(draftPayment.statusCode).toBe(409);
    expect(draftPayment.json()).toMatchObject({
      code: "invoice_not_confirmed"
    });

    const confirmed = await postJson<ConfirmInvoiceResponse>(
      app,
      `/businesses/${businessId}/invoices/${draft.id}/confirm`,
      {},
      sessionCookie
    );
    const movementCountAfterConfirm = store.snapshot().inventoryMovements.length;
    expect(confirmed.invoice.status).toBe("confirmed");
    expect(store.snapshot().products.find((item) => item.id === product.id)?.quantity).toBe(3);

    const partial = await postJson<PaymentResponse>(
      app,
      `/businesses/${businessId}/payments`,
      {
        invoiceId: confirmed.invoice.id,
        amount: 80,
        method: "cash",
        reference: "cashbox-1"
      },
      sessionCookie
    );

    expect(partial.invoicePayment).toMatchObject({
      paidTotal: 80,
      balanceDue: 120,
      status: "partially_paid"
    });
    expect(store.snapshot().inventoryMovements).toHaveLength(movementCountAfterConfirm);
    expect(store.snapshot().products.find((item) => item.id === product.id)?.quantity).toBe(3);

    const overpayment = await app.inject({
      method: "POST",
      url: `/businesses/${businessId}/payments`,
      headers: {
        ...jsonHeaders(),
        cookie: sessionCookie
      },
      payload: JSON.stringify({
        invoiceId: confirmed.invoice.id,
        amount: 121,
        method: "cash"
      })
    });
    expect(overpayment.statusCode).toBe(409);
    expect(overpayment.json()).toMatchObject({
      code: "payment_exceeds_balance"
    });

    const debts = await getJson<CustomerDebtResponse[]>(
      app,
      `/businesses/${businessId}/customer-debts`,
      sessionCookie
    );
    expect(debts).toEqual([
      {
        customerId: customer.id,
        customerName: customer.name,
        invoiceCount: 1,
        totalInvoiced: 200,
        totalPaid: 80,
        balanceDue: 120
      }
    ]);

    const settled = await postJson<PaymentResponse>(
      app,
      `/businesses/${businessId}/payments`,
      {
        invoiceId: confirmed.invoice.id,
        amount: 120,
        method: "bank_transfer",
        reference: "bank-001"
      },
      sessionCookie
    );
    expect(settled.invoicePayment).toMatchObject({
      paidTotal: 200,
      balanceDue: 0,
      status: "paid"
    });
    expect(
      await getJson<CustomerDebtResponse[]>(
        app,
        `/businesses/${businessId}/customer-debts`,
        sessionCookie
      )
    ).toEqual([]);

    const cache = await getJson<OfflineCacheResponse>(
      app,
      `/businesses/${businessId}/offline-cache`,
      sessionCookie
    );
    expect(cache.payments).toHaveLength(2);
    expect(cache.invoicePaymentSummaries).toContainEqual(
      expect.objectContaining({
        invoiceId: confirmed.invoice.id,
        status: "paid"
      })
    );
    expect(cache.customerDebts).toEqual([]);
    expect(store.snapshot().auditEvents.map((event) => event.type)).toContain("payment.recorded");

    await app.close();
  });

  it("replays offline payment records idempotently through the CP7 queue", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);
    const product = await postJson<ProductResponse>(
      app,
      `/businesses/${businessId}/products`,
      {
        name: "Beans",
        quantity: 2
      },
      sessionCookie
    );
    const draft = await postJson<InvoiceResponse>(
      app,
      `/businesses/${businessId}/invoices`,
      {
        items: [
          {
            productId: product.id,
            quantity: 1,
            unitPrice: 50
          }
        ]
      },
      sessionCookie
    );
    const confirmed = await postJson<ConfirmInvoiceResponse>(
      app,
      `/businesses/${businessId}/invoices/${draft.id}/confirm`,
      {},
      sessionCookie
    );
    const queueItem = await postJson<SyncQueueItemResponse>(
      app,
      `/businesses/${businessId}/sync-queue`,
      {
        idempotencyKey: "cp8-payment-record-1",
        mutationType: "payment.record",
        payload: {
          invoiceId: confirmed.invoice.id,
          amount: 50,
          method: "mobile_money_manual",
          reference: "mpesa-text"
        }
      },
      sessionCookie
    );

    const replay = await postJson<SyncReplayItemResponse>(
      app,
      `/businesses/${businessId}/sync-queue/${queueItem.id}/replay`,
      {},
      sessionCookie
    );
    expect(replay.item.status).toBe("synced");
    expect(store.snapshot().payments).toHaveLength(1);

    const replayAgain = await postJson<SyncReplayItemResponse>(
      app,
      `/businesses/${businessId}/sync-queue/${queueItem.id}/replay`,
      {},
      sessionCookie
    );
    expect(replayAgain.replayed).toBe(false);
    expect(store.snapshot().payments).toHaveLength(1);

    const summaries = await getJson<InvoicePaymentSummaryResponse[]>(
      app,
      `/businesses/${businessId}/payment-summaries`,
      sessionCookie
    );
    expect(summaries).toContainEqual(
      expect.objectContaining({
        invoiceId: confirmed.invoice.id,
        paidTotal: 50,
        balanceDue: 0,
        status: "paid"
      })
    );

    await app.close();
  });
});

async function createOwnerBusiness(app: ReturnType<typeof buildApi>) {
  const verifyResponse = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: jsonHeaders(),
    payload: JSON.stringify({
      method: "phone",
      contact: "254700000008",
      pin: "3927"
    })
  });
  const sessionCookie = extractSessionCookie(verifyResponse.headers["set-cookie"]);
  const auth = verifyResponse.json<VerifyOtpResponse>();
  const business = await postJson<CreateBusinessResponse>(
    app,
    "/businesses",
    {
      name: "Jane's Shop",
      language: "en"
    },
    sessionCookie
  );

  expect(auth.session.id).toBeTruthy();

  return {
    businessId: business.business.id,
    sessionCookie
  };
}

async function postJson<TResponse>(
  app: ReturnType<typeof buildApi>,
  url: string,
  payload: Record<string, unknown>,
  cookie?: string
): Promise<TResponse> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: cookie === undefined ? jsonHeaders() : { ...jsonHeaders(), cookie },
    payload: JSON.stringify(payload)
  });

  expect(response.statusCode).toBeGreaterThanOrEqual(200);
  expect(response.statusCode).toBeLessThan(300);

  return response.json<TResponse>();
}

async function getJson<TResponse>(
  app: ReturnType<typeof buildApi>,
  url: string,
  cookie: string
): Promise<TResponse> {
  const response = await app.inject({
    method: "GET",
    url,
    headers: {
      cookie
    }
  });

  expect(response.statusCode).toBe(200);

  return response.json<TResponse>();
}

function jsonHeaders(): Record<string, string> {
  return {
    "content-type": "application/json"
  };
}

function extractSessionCookie(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;

  if (value === undefined) {
    throw new Error("Expected set-cookie header.");
  }

  return value.split(";")[0] ?? value;
}
