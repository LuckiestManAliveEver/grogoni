import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

interface CreateBusinessResponse {
  business: {
    id: string;
    name: string;
    language: string;
    grogoniId: string;
  };
}

interface ProductResponse {
  id: string;
  businessId: string;
  name: string;
  sku: string | null;
  unit: string;
  quantity: number;
  buyingPrice: number | null;
  sellingPrice: number | null;
  aliases?: string[];
}

interface ShareableCatalogueSummaryResponse {
  businessId: string;
  grogoniId: string;
  businessName: string;
  productCount: number;
  updatedAt: string;
}

interface ShareableCatalogueProductResponse {
  id: string;
  name: string;
  unit: string;
  sellingPrice: number | null;
  image: string | null;
}

describe("catalogue sharing", () => {
  it("only lists shops that opted their catalogue in to sharing, excluding private/unshared/self", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });

    const buyer = await createOwnerBusiness(app, "254700000101", "Buyer shop");
    const sharer = await createOwnerBusiness(app, "254700000102", "Sharer shop");
    const nonSharer = await createOwnerBusiness(app, "254700000103", "Non-sharer shop");

    await postJson(
      app,
      `/businesses/${sharer.business.id}/products`,
      { name: "Maize flour", unit: "kg", quantity: 10, buyingPrice: 80, sellingPrice: 120 },
      sharer.sessionCookie
    );
    await postJson(
      app,
      `/businesses/${nonSharer.business.id}/products`,
      { name: "Rice", unit: "kg", quantity: 10, buyingPrice: 90, sellingPrice: 140 },
      nonSharer.sessionCookie
    );

    await patchJson(
      app,
      `/businesses/${sharer.business.id}/presence`,
      { status: "online", catalogueShareable: true },
      sharer.sessionCookie
    );

    const listing = await getJson<ShareableCatalogueSummaryResponse[]>(
      app,
      `/businesses/${buyer.business.id}/catalogue-marketplace/shops`,
      buyer.sessionCookie
    );
    expect(listing).toEqual([
      {
        businessId: sharer.business.id,
        grogoniId: sharer.business.grogoniId,
        businessName: "Sharer shop",
        productCount: 1,
        updatedAt: expect.any(String)
      }
    ]);

    await app.close();
  });

  it("exposes only the narrow product projection and never a non-shareable shop's catalogue", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });

    const buyer = await createOwnerBusiness(app, "254700000201", "Buyer shop");
    const sharer = await createOwnerBusiness(app, "254700000202", "Sharer shop");

    const sourceProduct = await postJson<ProductResponse>(
      app,
      `/businesses/${sharer.business.id}/products`,
      {
        name: "Tilapia pack",
        sku: "SHARER-SKU-1",
        unit: "box",
        quantity: 5,
        buyingPrice: 350,
        sellingPrice: 500,
        aliases: ["samaki"]
      },
      sharer.sessionCookie
    );

    const beforeOptIn = await app.inject({
      method: "GET",
      url: `/businesses/${buyer.business.id}/catalogue-marketplace/shops/${sharer.business.id}/products`,
      headers: { cookie: buyer.sessionCookie }
    });
    expect(beforeOptIn.statusCode).toBe(404);

    await patchJson(
      app,
      `/businesses/${sharer.business.id}/presence`,
      { status: "online", catalogueShareable: true },
      sharer.sessionCookie
    );

    const products = await getJson<ShareableCatalogueProductResponse[]>(
      app,
      `/businesses/${buyer.business.id}/catalogue-marketplace/shops/${sharer.business.id}/products`,
      buyer.sessionCookie
    );
    expect(products).toEqual([
      {
        id: sourceProduct.id,
        name: "Tilapia pack",
        unit: "box",
        sellingPrice: 500,
        image: null
      }
    ]);
    expect(products[0]).not.toHaveProperty("sku");
    expect(products[0]).not.toHaveProperty("buyingPrice");
    expect(products[0]).not.toHaveProperty("aliases");

    await app.close();
  });

  it("duplicates selected products into the caller's own catalogue without touching the source", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });

    const buyer = await createOwnerBusiness(app, "254700000301", "Buyer shop");
    const sharer = await createOwnerBusiness(app, "254700000302", "Sharer shop");

    const sourceProduct = await postJson<ProductResponse>(
      app,
      `/businesses/${sharer.business.id}/products`,
      {
        name: "Cooking oil 5L",
        unit: "bottle",
        quantity: 20,
        buyingPrice: 900,
        sellingPrice: 1200,
        aliases: ["mafuta"]
      },
      sharer.sessionCookie
    );
    await patchJson(
      app,
      `/businesses/${sharer.business.id}/presence`,
      { status: "online", catalogueShareable: true },
      sharer.sessionCookie
    );

    const duplicated = await postJson<ProductResponse[]>(
      app,
      `/businesses/${buyer.business.id}/catalogue-marketplace/shops/${sharer.business.id}/duplicate`,
      { productIds: [sourceProduct.id] },
      buyer.sessionCookie
    );

    expect(duplicated).toHaveLength(1);
    expect(duplicated[0]).toMatchObject({
      businessId: buyer.business.id,
      name: "Cooking oil 5L",
      unit: "bottle",
      quantity: 0,
      buyingPrice: null,
      sellingPrice: 1200,
      aliases: ["mafuta"]
    });
    expect(duplicated[0]!.id).not.toBe(sourceProduct.id);

    const buyerProducts = await getJson<ProductResponse[]>(
      app,
      `/businesses/${buyer.business.id}/products`,
      buyer.sessionCookie
    );
    expect(buyerProducts).toHaveLength(1);

    const sourceStillIntact = await getJson<ProductResponse[]>(
      app,
      `/businesses/${sharer.business.id}/products`,
      sharer.sessionCookie
    );
    expect(sourceStillIntact).toEqual([
      expect.objectContaining({
        id: sourceProduct.id,
        buyingPrice: 900,
        sellingPrice: 1200,
        quantity: 20
      })
    ]);

    await app.close();
  });

  it("rejects duplication from a shop that has not opted in, and requires product:write on the target", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });

    const buyer = await createOwnerBusiness(app, "254700000401", "Buyer shop");
    const nonSharer = await createOwnerBusiness(app, "254700000402", "Non-sharer shop");

    const sourceProduct = await postJson<ProductResponse>(
      app,
      `/businesses/${nonSharer.business.id}/products`,
      { name: "Sugar", unit: "kg", quantity: 10, sellingPrice: 150 },
      nonSharer.sessionCookie
    );

    const rejected = await app.inject({
      method: "POST",
      url: `/businesses/${buyer.business.id}/catalogue-marketplace/shops/${nonSharer.business.id}/duplicate`,
      headers: { "content-type": "application/json", cookie: buyer.sessionCookie },
      payload: JSON.stringify({ productIds: [sourceProduct.id] })
    });
    expect(rejected.statusCode).toBe(404);

    await patchJson(
      app,
      `/businesses/${nonSharer.business.id}/presence`,
      { status: "online", catalogueShareable: true },
      nonSharer.sessionCookie
    );

    const unauthorized = await app.inject({
      method: "POST",
      url: `/businesses/${buyer.business.id}/catalogue-marketplace/shops/${nonSharer.business.id}/duplicate`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ productIds: [sourceProduct.id] })
    });
    expect(unauthorized.statusCode).toBe(401);

    await app.close();
  });

  it("backfills catalogueShareable to false when restoring a snapshot taken before the field existed", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });

    const owner = await createOwnerBusiness(app, "254700000601", "Legacy shop");
    // Simulate a Postgres row persisted before catalogueShareable existed: a status toggle
    // (setShopPresence) always wrote the field going forward, so strip it back off to reproduce
    // the pre-migration shape the jsonb column actually held.
    await patchJson(
      app,
      `/businesses/${owner.business.id}/presence`,
      { status: "online" },
      owner.sessionCookie
    );
    const legacySnapshot = store.snapshot();
    const legacyPresence = legacySnapshot.shopPresences?.find(
      (presence) => presence.businessId === owner.business.id
    );
    expect(legacyPresence).toBeDefined();
    delete (legacyPresence as { catalogueShareable?: boolean }).catalogueShareable;

    store.hydrateSnapshot(legacySnapshot);

    const restored = await getJson<{ status: string; catalogueShareable: boolean }>(
      app,
      `/businesses/${owner.business.id}/presence`,
      owner.sessionCookie
    );
    expect(restored.catalogueShareable).toBe(false);

    await app.close();
  });

  it("rejects toggling catalogue sharing for a caller with no membership on that shop", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });

    const owner = await createOwnerBusiness(app, "254700000501", "Owner shop");
    const outsider = await createOwnerBusiness(app, "254700000502", "Outsider shop");

    const forbidden = await app.inject({
      method: "PATCH",
      url: `/businesses/${owner.business.id}/presence`,
      headers: { "content-type": "application/json", cookie: outsider.sessionCookie },
      payload: JSON.stringify({ status: "online", catalogueShareable: true })
    });
    expect(forbidden.statusCode).toBe(403);

    const unaffected = await getJson<{ status: string; catalogueShareable: boolean }>(
      app,
      `/businesses/${owner.business.id}/presence`,
      owner.sessionCookie
    );
    expect(unaffected.catalogueShareable).toBe(false);

    await app.close();
  });
});

async function createOwnerBusiness(
  app: ReturnType<typeof buildApi>,
  destination: string,
  businessName: string
): Promise<CreateBusinessResponse & { sessionCookie: string }> {
  const verifyResponse = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: jsonHeaders(),
    payload: JSON.stringify({
      method: "phone",
      contact: destination,
      pin: "1234"
    })
  });
  const sessionCookie = extractSessionCookie(verifyResponse.headers["set-cookie"]);
  const business = await postJson<CreateBusinessResponse>(
    app,
    "/businesses",
    { name: businessName, language: "en" },
    sessionCookie
  );

  return { ...business, sessionCookie };
}

async function postJson<TResponse>(
  app: ReturnType<typeof buildApi>,
  url: string,
  payload: unknown,
  cookie?: string
): Promise<TResponse> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: { ...jsonHeaders(), ...(cookie === undefined ? {} : { cookie }) },
    payload: JSON.stringify(payload)
  });

  expect(response.statusCode).toBeGreaterThanOrEqual(200);
  expect(response.statusCode).toBeLessThan(300);
  return response.json<TResponse>();
}

async function patchJson<TResponse>(
  app: ReturnType<typeof buildApi>,
  url: string,
  payload: unknown,
  cookie: string
): Promise<TResponse> {
  const response = await app.inject({
    method: "PATCH",
    url,
    headers: { ...jsonHeaders(), cookie },
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
    headers: { cookie }
  });

  expect(response.statusCode).toBeGreaterThanOrEqual(200);
  expect(response.statusCode).toBeLessThan(300);
  return response.json<TResponse>();
}

function jsonHeaders() {
  return { "content-type": "application/json" };
}

function extractSessionCookie(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;

  if (raw === undefined) {
    throw new Error("Missing session cookie");
  }

  return raw.split(";")[0] ?? raw;
}
