import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

describe("contact-synced immutable commercial history", () => {
  it("deduplicates contacts and preserves supplier, purchase-price, sale, and route history", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "254700000078", "History Shop");
    const product = await post(app, `/businesses/${owner.businessId}/products`, owner.cookie, {
      name: "Maize",
      unit: "bag",
      quantity: 100,
      buyingPrice: 3200,
      sellingPrice: 3500
    });
    const supplier = await post(app, `/businesses/${owner.businessId}/suppliers`, owner.cookie, {
      name: "Muthokinju"
    });
    const customer = await post(app, `/businesses/${owner.businessId}/customers`, owner.cookie, {
      name: "Jane Customer"
    });

    const imported = await post(
      app,
      `/businesses/${owner.businessId}/contacts/import`,
      owner.cookie,
      {
        source: "PHONEBOOK",
        contacts: [
          {
            displayName: "Kamau Agent",
            phones: ["+254 712 345 678"],
            sourceExternalId: "device-contact-1"
          }
        ]
      }
    );
    const duplicate = await post(
      app,
      `/businesses/${owner.businessId}/contacts/sync`,
      owner.cookie,
      {
        source: "PHONEBOOK",
        contacts: [
          {
            displayName: "Kamau Agent Updated",
            phones: ["+254712345678"],
            sourceExternalId: "device-contact-1"
          }
        ]
      }
    );
    expect(imported.created).toBe(1);
    expect(duplicate).toMatchObject({ created: 0, updated: 1 });
    const contactId = imported.contacts[0].id as string;

    const relationship = await post(
      app,
      `/businesses/${owner.businessId}/suppliers/${supplier.id}/contacts`,
      owner.cookie,
      { contactId, role: "SALES_AGENT", isPrimary: true }
    );
    const route = await post(app, `/businesses/${owner.businessId}/routes`, owner.cookie, {
      origin: { label: "Supplier depot", region: "Nairobi" },
      destination: { label: "History Shop", region: "Nairobi" },
      provider: "manual",
      externalSourceId: "route-import-1"
    });

    const purchase = await post(app, `/businesses/${owner.businessId}/purchases`, owner.cookie, {
      supplierId: supplier.id,
      supplierContactId: contactId,
      productId: product.id,
      quantity: 20,
      buyingPrice: 3350,
      currency: "KES",
      deliveredAt: "2026-08-31T12:00:00.000Z",
      routeId: route.id,
      externalSourceId: "purchase-import-1"
    });
    const retriedPurchase = await post(
      app,
      `/businesses/${owner.businessId}/purchases`,
      owner.cookie,
      {
        supplierId: supplier.id,
        supplierContactId: contactId,
        productId: product.id,
        quantity: 20,
        buyingPrice: 3350,
        externalSourceId: "purchase-import-1"
      }
    );
    expect(retriedPurchase.id).toBe(purchase.id);

    await request(
      app,
      "DELETE",
      `/businesses/${owner.businessId}/supplier-contacts/${relationship.id}`,
      owner.cookie
    );

    // Must postdate the product-creation and purchase steps above, whose price-history entries
    // fall back to the real wall-clock "now" at the moment each ran - a fixed calendar date
    // eventually gets overtaken by that "now" and silently breaks the ordering assertion below.
    const changed = await post(
      app,
      `/businesses/${owner.businessId}/products/${product.id}/purchase-prices`,
      owner.cookie,
      { price: 3400, currency: "KES", effectiveAt: new Date(Date.now() + 60_000).toISOString() }
    );
    expect(changed.current.price).toBe(3400);
    expect(changed.previous.price).toBe(3350);

    const priceHistory = await get(
      app,
      `/businesses/${owner.businessId}/products/${product.id}/purchase-prices`,
      owner.cookie
    );
    expect(priceHistory.map((item: { price: number }) => item.price)).toEqual([3400, 3350, 3200]);
    expect(priceHistory[1]).toMatchObject({
      supplierId: supplier.id,
      supplierContactId: contactId
    });

    const purchaseHistory = await get(
      app,
      `/businesses/${owner.businessId}/purchases/history?productId=${product.id}`,
      owner.cookie
    );
    expect(purchaseHistory).toHaveLength(1);
    expect(purchaseHistory[0]).toMatchObject({
      supplierNameSnapshot: "Muthokinju",
      contactNameSnapshot: "Kamau Agent Updated",
      buyingPrice: 3350,
      routeId: route.id
    });

    const sale = await post(app, `/businesses/${owner.businessId}/sales`, owner.cookie, {
      customerId: customer.id,
      customerContactId: contactId,
      items: [{ productId: product.id, quantity: 2, unitPrice: 3500 }],
      routeId: route.id,
      externalSourceId: "sale-import-1"
    });
    expect(sale).toMatchObject({ customerNameSnapshot: "Jane Customer", total: 7000 });

    await request(
      app,
      "PATCH",
      `/businesses/${owner.businessId}/customers/${customer.id}`,
      owner.cookie,
      {
        name: "Jane Renamed"
      }
    );
    const salesHistory = await get(
      app,
      `/businesses/${owner.businessId}/sales/history?customerId=${customer.id}`,
      owner.cookie
    );
    expect(salesHistory[0].customerNameSnapshot).toBe("Jane Customer");
    expect(
      (await get(app, `/businesses/${owner.businessId}/routes/history`, owner.cookie))[0].stops
    ).toHaveLength(2);
  });

  it("rejects cross-tenant history access", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const first = await createOwnerBusiness(app, "254700000079", "First Shop");
    const second = await createOwnerBusiness(app, "254700000080", "Second Shop");
    const response = await app.inject({
      method: "GET",
      url: `/businesses/${first.businessId}/contacts`,
      headers: { cookie: second.cookie }
    });
    expect(response.statusCode).toBe(403);
  });
});

async function createOwnerBusiness(
  app: ReturnType<typeof buildApi>,
  contact: string,
  name: string
) {
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: json(),
    payload: JSON.stringify({ method: "phone", contact, pin: "3927" })
  });
  expect(signup.statusCode).toBe(200);
  const cookie = String(
    Array.isArray(signup.headers["set-cookie"])
      ? signup.headers["set-cookie"][0]
      : signup.headers["set-cookie"]
  ).split(";")[0];
  const result = await post(app, "/businesses", cookie, { name, language: "en" });
  return { businessId: result.business.id as string, cookie };
}

async function post(
  app: ReturnType<typeof buildApi>,
  url: string,
  cookie: string,
  payload: Record<string, unknown>
) {
  return request(app, "POST", url, cookie, payload);
}
async function get(app: ReturnType<typeof buildApi>, url: string, cookie: string) {
  return request(app, "GET", url, cookie);
}
async function request(
  app: ReturnType<typeof buildApi>,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  cookie: string,
  payload?: Record<string, unknown>
) {
  const response = await app.inject({
    method,
    url,
    headers: payload === undefined ? { cookie } : { ...json(), cookie },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) })
  });
  expect(response.statusCode, response.body).toBe(200);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper exercises heterogeneous API payloads
  return response.json<any>();
}
function json() {
  return { "content-type": "application/json" };
}
