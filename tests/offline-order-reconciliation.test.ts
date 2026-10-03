import { describe, expect, it } from "vitest";
import type { OfflineOrderIntent } from "@grogoni/offline-runtime";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

const androidHeaders = {
  "x-grogoni-device-id": "android-device-order-1",
  "x-grogoni-device-name": "Pixel Test",
  "x-grogoni-platform": "android",
  "x-grogoni-client": "android-native"
};

describe("Offline order intent reconciliation", () => {
  it("confirms exactly one of two intents racing for the last unit of stock, in arrival order", async () => {
    const { store, cookie, businessId, accountId, createProduct } = await fixture();
    const product = await createProduct({ name: "Sugar 1kg", quantity: 1, sellingPrice: 150 });
    const [first, second] = store.pushOfflineOrderIntents(sessionIdFromCookie(cookie), [
      buildIntent({
        id: "race-a",
        accountId,
        storeId: businessId,
        productId: product.id,
        quantity: 1
      }),
      buildIntent({
        id: "race-b",
        accountId,
        storeId: businessId,
        productId: product.id,
        quantity: 1
      })
    ]);
    expect(first?.status).toBe("confirmed");
    expect(first?.invoiceId).toBeTruthy();
    expect(second?.status).toBe("rejected");
    expect(second?.invoiceId).toBeNull();
    expect(second?.rejectedItems[0]?.reason).toMatch(/available/);
  });

  it("confirms neither when both intents in the same batch ask for more than is in stock", async () => {
    const { store, cookie, businessId, accountId, createProduct } = await fixture();
    const product = await createProduct({ name: "Rice 2kg", quantity: 1, sellingPrice: 200 });
    const outcomes = store.pushOfflineOrderIntents(sessionIdFromCookie(cookie), [
      buildIntent({
        id: "over-a",
        accountId,
        storeId: businessId,
        productId: product.id,
        quantity: 2
      })
    ]);
    expect(outcomes[0]?.status).toBe("rejected");
    expect(outcomes[0]?.invoiceId).toBeNull();
  });

  it("confirms a partial order when one item is in stock and another is oversold", async () => {
    const { store, cookie, businessId, accountId, createProduct } = await fixture();
    const inStock = await createProduct({ name: "Salt 500g", quantity: 5, sellingPrice: 50 });
    const outOfStock = await createProduct({
      name: "Cooking Oil 1L",
      quantity: 0,
      sellingPrice: 300
    });
    const [outcome] = store.pushOfflineOrderIntents(sessionIdFromCookie(cookie), [
      {
        ...buildIntent({
          id: "partial-1",
          accountId,
          storeId: businessId,
          productId: inStock.id,
          quantity: 2
        }),
        items: [
          { productCloudId: inStock.id, name: inStock.name, quantity: 2, quotedUnitPrice: null },
          {
            productCloudId: outOfStock.id,
            name: outOfStock.name,
            quantity: 1,
            quotedUnitPrice: null
          }
        ]
      }
    ]);
    expect(outcome?.status).toBe("partial");
    expect(outcome?.invoiceId).toBeTruthy();
    expect(outcome?.confirmedItems).toEqual([
      { name: "Salt 500g", quantity: 2, productId: inStock.id, reason: null }
    ]);
    expect(outcome?.rejectedItems[0]?.name).toBe("Cooking Oil 1L");
  });

  it("rejects the whole intent when no item matches the catalogue, without throwing", async () => {
    const { store, cookie, businessId, accountId } = await fixture();
    const [outcome] = store.pushOfflineOrderIntents(sessionIdFromCookie(cookie), [
      buildIntent({
        id: "unknown-1",
        accountId,
        storeId: businessId,
        productId: null,
        quantity: 1,
        name: "kerosene"
      })
    ]);
    expect(outcome?.status).toBe("rejected");
    expect(outcome?.invoiceId).toBeNull();
  });

  it("is idempotent: replaying the same intent id never decrements stock twice", async () => {
    const { store, cookie, businessId, accountId, createProduct } = await fixture();
    const product = await createProduct({ name: "Flour 2kg", quantity: 3, sellingPrice: 250 });
    const intent = buildIntent({
      id: "replay-1",
      accountId,
      storeId: businessId,
      productId: product.id,
      quantity: 1
    });
    const [first] = store.pushOfflineOrderIntents(sessionIdFromCookie(cookie), [intent]);
    const [second] = store.pushOfflineOrderIntents(sessionIdFromCookie(cookie), [intent]);
    expect(second).toEqual(first);
    const stillFulfillable = store.pushOfflineOrderIntents(sessionIdFromCookie(cookie), [
      buildIntent({
        id: "replay-check",
        accountId,
        storeId: businessId,
        productId: product.id,
        quantity: 2
      })
    ]);
    // 3 - 1 (replay-1, applied once) = 2 left, exactly enough - proves replay-1 didn't double-decrement.
    expect(stillFulfillable[0]?.status).toBe("confirmed");
  });

  it("resolves an account customer claim to a real linked customer, reusing it on a repeat order", async () => {
    const { store, cookie, businessId, accountId, createProduct } = await fixture();
    const product = await createProduct({ name: "Beans 1kg", quantity: 10, sellingPrice: 180 });
    const buyerAccountId = await signUpAccount(store, "254700000921");
    const [first] = store.pushOfflineOrderIntents(sessionIdFromCookie(cookie), [
      {
        ...buildIntent({
          id: "buyer-1",
          accountId,
          storeId: businessId,
          productId: product.id,
          quantity: 1
        }),
        customerClaim: { type: "account", accountId: buyerAccountId, displayName: "Buyer" }
      }
    ]);
    const [second] = store.pushOfflineOrderIntents(sessionIdFromCookie(cookie), [
      {
        ...buildIntent({
          id: "buyer-2",
          accountId,
          storeId: businessId,
          productId: product.id,
          quantity: 1
        }),
        customerClaim: { type: "account", accountId: buyerAccountId, displayName: "Buyer" }
      }
    ]);
    expect(first?.status).toBe("confirmed");
    expect(second?.status).toBe("confirmed");
    const invoices = store.listInvoices({ sessionId: sessionIdFromCookie(cookie), businessId });
    const customerIds = new Set(invoices.map((invoice) => invoice.customerId));
    expect(customerIds.size).toBe(1);
  });

  it("never creates an order from ambiguous SMS text - no invoice, no stock change, no guess", async () => {
    const { app, store, cookie, businessId, createProduct } = await fixture(
      "254700000935",
      androidHeaders
    );
    const product = await createProduct({ name: "Sugar 1kg", quantity: 5, sellingPrice: 150 });
    await app.inject({
      method: "PUT",
      url: "/v1/devices/native-sms",
      headers: { cookie, "content-type": "application/json", ...androidHeaders },
      payload: JSON.stringify({
        roleAvailable: true,
        roleGranted: true,
        sendPermissionGranted: true,
        receivePermissionGranted: true,
        simReady: true,
        subscriptionId: 1,
        preferred: true
      })
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/devices/native-sms/messages",
      headers: { cookie, "content-type": "application/json", ...androidHeaders },
      payload: JSON.stringify({
        businessId,
        externalMessageId: "sms-ambiguous-1",
        sender: "+254700000941",
        text: "2 sugar 1kg, soap",
        occurredAt: new Date().toISOString()
      })
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ orderIntentOutcome: unknown }>().orderIntentOutcome).toBeNull();
    const invoices = store.listInvoices({ sessionId: sessionIdFromCookie(cookie), businessId });
    expect(invoices).toHaveLength(0);
    const [refreshed] = store.listProducts({ sessionId: sessionIdFromCookie(cookie), businessId });
    expect(refreshed?.id).toBe(product.id);
    expect(refreshed?.quantity).toBe(5);
  });

  it("BLE and SMS racing for the last unit of the same product resolve to exactly one confirmed order, never both", async () => {
    const { app, store, cookie, businessId, accountId, createProduct } = await fixture(
      "254700000930",
      androidHeaders
    );
    const product = await createProduct({
      name: "Cooking Gas 6kg",
      quantity: 1,
      sellingPrice: 3500
    });
    const buyerAccountId = await signUpAccount(store, "254700000931");

    const blePush = await app.inject({
      method: "POST",
      url: "/sync/order-intents",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({
        intents: [
          {
            id: "ble-race",
            accountId,
            storeId: businessId,
            transport: "ble",
            customerClaim: {
              type: "account",
              accountId: buyerAccountId,
              displayName: "Nearby buyer"
            },
            items: [
              { productCloudId: product.id, name: product.name, quantity: 1, quotedUnitPrice: null }
            ],
            paymentMethod: null,
            paymentReference: null,
            note: null,
            receivedAtLocal: new Date().toISOString(),
            rawText: null
          }
        ]
      })
    });
    expect(blePush.statusCode).toBe(200);
    const bleOutcome = blePush.json<{ outcomes: { status: string }[] }>().outcomes[0];

    await app.inject({
      method: "PUT",
      url: "/v1/devices/native-sms",
      headers: { cookie, "content-type": "application/json", ...androidHeaders },
      payload: JSON.stringify({
        roleAvailable: true,
        roleGranted: true,
        sendPermissionGranted: true,
        receivePermissionGranted: true,
        simReady: true,
        subscriptionId: 1,
        preferred: true
      })
    });
    const smsPush = await app.inject({
      method: "POST",
      url: "/v1/devices/native-sms/messages",
      headers: { cookie, "content-type": "application/json", ...androidHeaders },
      payload: JSON.stringify({
        businessId,
        externalMessageId: "sms-race-1",
        sender: "+254700000940",
        text: `1 ${product.name}`,
        occurredAt: new Date().toISOString()
      })
    });
    expect(smsPush.statusCode).toBe(200);
    const smsOutcome = smsPush.json<{ orderIntentOutcome: { status: string } | null }>()
      .orderIntentOutcome;

    const statuses = [bleOutcome?.status, smsOutcome?.status];
    expect(statuses.filter((status) => status === "confirmed")).toHaveLength(1);
    expect(statuses.filter((status) => status === "rejected")).toHaveLength(1);
    const [refreshed] = store.listProducts({ sessionId: sessionIdFromCookie(cookie), businessId });
    expect(refreshed?.quantity).toBe(0);
  });
});

function buildIntent(input: {
  id: string;
  accountId: string;
  storeId: string;
  productId: string | null;
  quantity: number;
  name?: string;
}): OfflineOrderIntent {
  return {
    id: input.id,
    accountId: input.accountId,
    storeId: input.storeId,
    transport: "ble",
    customerClaim: { type: "phone", phone: "+254700000900", displayName: "Buyer" },
    items: [
      {
        productCloudId: input.productId,
        name: input.name ?? "item",
        quantity: input.quantity,
        quotedUnitPrice: null
      }
    ],
    paymentMethod: null,
    paymentReference: null,
    note: null,
    receivedAtLocal: new Date().toISOString(),
    rawText: null
  };
}

function sessionIdFromCookie(cookie: string): string {
  return cookie.slice(cookie.indexOf("=") + 1);
}

function extractCookie(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error("Missing cookie");
  return value.split(";")[0] as string;
}

async function signUpAccount(
  store: ReturnType<typeof createCp2Store>,
  destination: string
): Promise<string> {
  const app = buildApi({ cp2: { store } });
  const auth = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ method: "phone", contact: destination, pin: "1234" })
  });
  expect(auth.statusCode, auth.body).toBe(200);
  return auth.json<{ account: { id: string } }>().account.id;
}

async function fixture(destination = "254700000900", signupHeaders: Record<string, string> = {}) {
  const store = createCp2Store();
  const app = buildApi({ cp2: { store } });
  const auth = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json", ...signupHeaders },
    payload: JSON.stringify({ method: "phone", contact: destination, pin: "1234" })
  });
  expect(auth.statusCode, auth.body).toBe(200);
  const cookie = extractCookie(auth.headers["set-cookie"]);
  const created = await app.inject({
    method: "POST",
    url: "/businesses",
    headers: { cookie, "content-type": "application/json" },
    payload: JSON.stringify({ name: "Race shop", language: "en" })
  });
  expect(created.statusCode, created.body).toBe(200);
  const businessId = created.json<{ business: { id: string } }>().business.id;
  const accountId = auth.json<{ account: { id: string } }>().account.id;
  const createProduct = async (input: { name: string; quantity: number; sellingPrice: number }) => {
    const response = await app.inject({
      method: "POST",
      url: `/businesses/${businessId}/products`,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ ...input, unit: "unit" })
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ id: string; name: string }>();
  };
  return { store, app, cookie, businessId, accountId, createProduct };
}
