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

interface InvoiceResponse {
  id: string;
  status: "draft" | "confirmed";
}

interface OfflineCacheResponse {
  businessId: string;
  source: "server_cache";
  products: ProductResponse[];
  customers: Array<{ id: string }>;
  suppliers: Array<{ id: string }>;
  invoices: InvoiceResponse[];
  inventoryMovements: Array<{ type: string; productId: string }>;
}

interface SyncQueueItemResponse {
  id: string;
  idempotencyKey: string;
  businessId: string;
  mutationType: string;
  status: "pending" | "processing" | "synced" | "failed" | "conflict";
  attempts: number;
  result: unknown | null;
  conflict: {
    code: string;
    message: string;
    category: string;
  } | null;
}

interface SyncQueueResponse {
  summary: {
    pending: number;
    synced: number;
    failed: number;
    conflict: number;
    total: number;
  };
  items: SyncQueueItemResponse[];
}

interface SyncReplayResponse {
  summary: SyncQueueResponse["summary"];
  results: Array<{
    replayed: boolean;
    item: SyncQueueItemResponse;
  }>;
}

interface SyncReplayItemResponse {
  replayed: boolean;
  item: SyncQueueItemResponse;
}

describe("CP7 offline local data and sync queue", () => {
  it("serves offline cache and replays queued mutations idempotently in order", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);
    const { businessId: secondBusinessId, sessionCookie: secondSessionCookie } =
      await createOwnerBusiness(app, {
        contact: "254700000107",
        businessName: "Second Shop"
      });
    const existingProduct = await postJson<ProductResponse>(
      app,
      `/businesses/${businessId}/products`,
      {
        name: "Rice",
        quantity: 1
      },
      sessionCookie
    );

    const cache = await getJson<OfflineCacheResponse>(
      app,
      `/businesses/${businessId}/offline-cache`,
      sessionCookie
    );

    expect(cache).toMatchObject({
      businessId,
      source: "server_cache"
    });
    expect(cache.products.map((product) => product.id)).toContain(existingProduct.id);

    const productQueueItem = await postJson<SyncQueueItemResponse>(
      app,
      `/businesses/${businessId}/sync-queue`,
      {
        idempotencyKey: "cp7-product-create-1",
        mutationType: "product.create",
        clientCreatedAt: "2026-07-03T00:00:00.000Z",
        payload: {
          name: "Offline Beans",
          quantity: 3
        }
      },
      sessionCookie
    );
    const duplicateProductQueueItem = await postJson<SyncQueueItemResponse>(
      app,
      `/businesses/${businessId}/sync-queue`,
      {
        idempotencyKey: "cp7-product-create-1",
        mutationType: "product.create",
        payload: {
          name: "Should Not Replace",
          quantity: 99
        }
      },
      sessionCookie
    );
    const customerQueueItem = await postJson<SyncQueueItemResponse>(
      app,
      `/businesses/${businessId}/sync-queue`,
      {
        idempotencyKey: "cp7-customer-create-1",
        mutationType: "customer.create",
        clientCreatedAt: "2026-07-03T00:00:01.000Z",
        payload: {
          name: "Offline Customer"
        }
      },
      sessionCookie
    );

    expect(duplicateProductQueueItem.id).toBe(productQueueItem.id);
    expect(customerQueueItem.status).toBe("pending");

    const secondBusinessQueue = await getJson<SyncQueueResponse>(
      app,
      `/businesses/${secondBusinessId}/sync-queue`,
      secondSessionCookie
    );
    expect(secondBusinessQueue.items).toHaveLength(0);

    const crossBusinessReplay = await app.inject({
      method: "POST",
      url: `/businesses/${secondBusinessId}/sync-queue/${productQueueItem.id}/replay`,
      headers: {
        ...jsonHeaders(),
        cookie: secondSessionCookie
      },
      payload: JSON.stringify({})
    });
    expect(crossBusinessReplay.statusCode).toBe(404);
    expect(crossBusinessReplay.json()).toMatchObject({
      code: "sync_item_not_found"
    });

    const replay = await postJson<SyncReplayResponse>(
      app,
      `/businesses/${businessId}/sync-queue/replay`,
      {},
      sessionCookie
    );

    expect(replay.results.map((result) => result.item.mutationType)).toEqual([
      "product.create",
      "customer.create"
    ]);
    expect(replay.summary).toMatchObject({
      pending: 0,
      synced: 2,
      conflict: 0
    });

    const replayAgain = await postJson<SyncReplayItemResponse>(
      app,
      `/businesses/${businessId}/sync-queue/${productQueueItem.id}/replay`,
      {},
      sessionCookie
    );
    expect(replayAgain.replayed).toBe(false);

    const snapshot = store.snapshot();
    expect(snapshot.products.filter((product) => product.businessId === businessId)).toHaveLength(
      2
    );
    expect(snapshot.products.map((product) => product.name)).not.toContain("Should Not Replace");
    expect(
      snapshot.customers.filter((customer) => customer.businessId === businessId)
    ).toHaveLength(1);

    await app.close();
  });

  it("surfaces CP6 invoice confirmation conflicts without mutating stock", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);
    const product = await postJson<ProductResponse>(
      app,
      `/businesses/${businessId}/products`,
      {
        name: "Maize Flour",
        quantity: 1
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
            quantity: 2,
            unitPrice: 100
          }
        ]
      },
      sessionCookie
    );
    const queueItem = await postJson<SyncQueueItemResponse>(
      app,
      `/businesses/${businessId}/sync-queue`,
      {
        idempotencyKey: "cp7-confirm-oversold-1",
        mutationType: "invoice.confirm",
        payload: {
          invoiceId: draft.id
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

    expect(replay.item.status).toBe("conflict");
    expect(replay.item.conflict).toMatchObject({
      code: "stock_insufficient",
      category: "product_quantity"
    });
    expect(store.snapshot().products.find((item) => item.id === product.id)?.quantity).toBe(1);
    expect(store.snapshot().invoices.find((invoice) => invoice.id === draft.id)?.status).toBe(
      "draft"
    );
    expect(
      store.snapshot().inventoryMovements.filter((movement) => movement.type === "sale")
    ).toHaveLength(0);

    const queue = await getJson<SyncQueueResponse>(
      app,
      `/businesses/${businessId}/sync-queue`,
      sessionCookie
    );
    expect(queue.summary).toMatchObject({
      conflict: 1,
      synced: 0
    });

    const bulkReplay = await postJson<SyncReplayResponse>(
      app,
      `/businesses/${businessId}/sync-queue/replay`,
      {},
      sessionCookie
    );
    expect(bulkReplay.results).toEqual([]);
    expect(bulkReplay.summary).toMatchObject({
      conflict: 1,
      synced: 0
    });

    await app.close();
  });

  it("flags duplicate offline product, customer, and payment records instead of silently duplicating them", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);

    const existingProduct = await postJson<ProductResponse>(
      app,
      `/businesses/${businessId}/products`,
      { name: "Rice", quantity: 5 },
      sessionCookie
    );
    const duplicateProductQueueItem = await postJson<SyncQueueItemResponse>(
      app,
      `/businesses/${businessId}/sync-queue`,
      {
        idempotencyKey: "cp7-dup-product-1",
        mutationType: "product.create",
        payload: { name: "  RICE  ", quantity: 9 }
      },
      sessionCookie
    );
    const duplicateProductReplay = await postJson<SyncReplayItemResponse>(
      app,
      `/businesses/${businessId}/sync-queue/${duplicateProductQueueItem.id}/replay`,
      {},
      sessionCookie
    );

    expect(duplicateProductReplay.item.status).toBe("conflict");
    expect(duplicateProductReplay.item.conflict).toMatchObject({
      code: "duplicate_product_detected",
      category: "duplicate"
    });
    expect(
      store
        .snapshot()
        .products.filter((product) => product.businessId === businessId && product.name === "Rice")
    ).toHaveLength(1);

    const existingCustomer = await postJson<{ id: string }>(
      app,
      `/businesses/${businessId}/customers`,
      { name: "Amina Otieno", phone: "+254700000002" },
      sessionCookie
    );
    const duplicateCustomerQueueItem = await postJson<SyncQueueItemResponse>(
      app,
      `/businesses/${businessId}/sync-queue`,
      {
        idempotencyKey: "cp7-dup-customer-1",
        mutationType: "customer.create",
        payload: { name: "Amina Otieno", phone: "+254700000002" }
      },
      sessionCookie
    );
    const duplicateCustomerReplay = await postJson<SyncReplayItemResponse>(
      app,
      `/businesses/${businessId}/sync-queue/${duplicateCustomerQueueItem.id}/replay`,
      {},
      sessionCookie
    );

    expect(duplicateCustomerReplay.item.status).toBe("conflict");
    expect(duplicateCustomerReplay.item.conflict).toMatchObject({
      code: "duplicate_customer_detected",
      category: "duplicate"
    });

    const namesakeWithoutPhoneQueueItem = await postJson<SyncQueueItemResponse>(
      app,
      `/businesses/${businessId}/sync-queue`,
      {
        idempotencyKey: "cp7-namesake-customer-1",
        mutationType: "customer.create",
        payload: { name: "Amina Otieno" }
      },
      sessionCookie
    );
    const namesakeReplay = await postJson<SyncReplayItemResponse>(
      app,
      `/businesses/${businessId}/sync-queue/${namesakeWithoutPhoneQueueItem.id}/replay`,
      {},
      sessionCookie
    );

    expect(namesakeReplay.item.status).toBe("synced");
    expect(
      store
        .snapshot()
        .customers.filter(
          (customer) => customer.businessId === businessId && customer.name === "Amina Otieno"
        )
    ).toHaveLength(2);

    const invoiceProduct = await postJson<ProductResponse>(
      app,
      `/businesses/${businessId}/products`,
      { name: "Cooking Oil", quantity: 10, sellingPrice: 100 },
      sessionCookie
    );
    const draftInvoice = await postJson<InvoiceResponse>(
      app,
      `/businesses/${businessId}/invoices`,
      { items: [{ productId: invoiceProduct.id, quantity: 10, unitPrice: 100 }] },
      sessionCookie
    );
    const confirmedInvoice = await postJson<{ invoice: InvoiceResponse }>(
      app,
      `/businesses/${businessId}/invoices/${draftInvoice.id}/confirm`,
      {},
      sessionCookie
    );
    await postJson(
      app,
      `/businesses/${businessId}/payments`,
      { invoiceId: confirmedInvoice.invoice.id, amount: 400, method: "cash" },
      sessionCookie
    );
    const duplicatePaymentQueueItem = await postJson<SyncQueueItemResponse>(
      app,
      `/businesses/${businessId}/sync-queue`,
      {
        idempotencyKey: "cp7-dup-payment-1",
        mutationType: "payment.record",
        payload: { invoiceId: confirmedInvoice.invoice.id, amount: 400, method: "cash" }
      },
      sessionCookie
    );
    const duplicatePaymentReplay = await postJson<SyncReplayItemResponse>(
      app,
      `/businesses/${businessId}/sync-queue/${duplicatePaymentQueueItem.id}/replay`,
      {},
      sessionCookie
    );

    expect(duplicatePaymentReplay.item.status).toBe("conflict");
    expect(duplicatePaymentReplay.item.conflict).toMatchObject({
      code: "duplicate_payment_detected",
      category: "duplicate"
    });
    expect(
      store
        .snapshot()
        .payments.filter((payment) => payment.invoiceId === confirmedInvoice.invoice.id)
    ).toHaveLength(1);

    expect(existingProduct.id).not.toBe(invoiceProduct.id);
    expect(existingCustomer.id).toBeTruthy();

    await app.close();
  });

  it("recovers queue items interrupted while processing after store hydration", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);
    const queued = await postJson<SyncQueueItemResponse>(
      app,
      `/businesses/${businessId}/sync-queue`,
      {
        idempotencyKey: "cp7-interrupted-item-1",
        mutationType: "customer.create",
        payload: { name: "Interrupted Customer" }
      },
      sessionCookie
    );
    const snapshot = store.snapshot();
    snapshot.syncQueue = snapshot.syncQueue.map((item) =>
      item.id === queued.id
        ? {
            ...item,
            status: "processing",
            attempts: 1
          }
        : item
    );
    const restoredStore = createCp2Store();
    restoredStore.hydrateSnapshot(snapshot);
    const restoredApp = buildApi({ cp2: { store: restoredStore } });
    const restored = await getJson<SyncQueueResponse>(
      restoredApp,
      `/businesses/${businessId}/sync-queue`,
      sessionCookie
    );

    expect(restored.items[0]).toMatchObject({
      id: queued.id,
      status: "failed",
      conflict: {
        code: "sync_replay_interrupted",
        retryable: true
      }
    });

    await app.close();
    await restoredApp.close();
  });
});

async function createOwnerBusiness(
  app: ReturnType<typeof buildApi>,
  options: { contact?: string; businessName?: string } = {}
) {
  const verifyResponse = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: jsonHeaders(),
    payload: JSON.stringify({
      method: "phone",
      contact: options.contact ?? "254700000007",
      pin: "3927"
    })
  });
  const sessionCookie = extractSessionCookie(verifyResponse.headers["set-cookie"]);
  const auth = verifyResponse.json<VerifyOtpResponse>();
  const business = await postJson<CreateBusinessResponse>(
    app,
    "/businesses",
    {
      name: options.businessName ?? "Jane's Shop",
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
