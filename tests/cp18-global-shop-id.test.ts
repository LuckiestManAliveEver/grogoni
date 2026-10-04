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
  name: string;
  unit: string;
  buyingPrice: number | null;
  sellingPrice: number | null;
}

interface PublicStorefrontResponse {
  agentId: string;
  grogoniId: string;
  commerceAddress: string;
  businessName: string;
  presence: {
    status: string;
    updatedAt: string;
  };
  products: Array<{
    id: string;
    name: string;
    unit: string;
    available: boolean;
    sellingPrice: number | null;
    image: string | null;
  }>;
}

describe("CP18 Grogoni Storefront ID", () => {
  it("creates readable unique shop IDs and resolves storefronts by Grogoni ID", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });

    const first = await createOwnerBusiness(app, "254700000018", "BigFish grogoni", "Amina Seller");
    const second = await createOwnerBusiness(
      app,
      "255700000018",
      "Dar Fish grogoni",
      "Amina Seller"
    );
    const third = await createOwnerBusiness(app, "256700000018", "Dar Fish grogoni");

    expect(first.business.grogoniId).toBe("grogoni.amina-seller");
    expect(second.business.grogoniId).toBe("grogoni.dar-fish-grogoni");
    expect(third.business.grogoniId).toBe("grogoni.dar-fish-grogoni-2");

    const stockedProduct = await postJson<ProductResponse>(
      app,
      `/businesses/${first.business.id}/products`,
      {
        name: "Tilapia pack",
        sku: "PRIVATE-FISH-001",
        unit: "box",
        quantity: 5,
        buyingPrice: 350,
        sellingPrice: 500
      },
      first.sessionCookie
    );
    await postJson<ProductResponse>(
      app,
      `/businesses/${first.business.id}/products`,
      {
        name: "Hidden empty item",
        sku: "PRIVATE-FISH-002",
        unit: "box",
        quantity: 0
      },
      first.sessionCookie
    );

    const storefront = await app.inject({
      method: "GET",
      url: `/public/storefronts/${encodeURIComponent(first.business.grogoniId)}`
    });
    const rawStorefront = await app.inject({
      method: "GET",
      url: `/public/storefronts/${first.business.grogoniId.toUpperCase()}`
    });

    expect(storefront.statusCode).toBe(200);
    expect(rawStorefront.statusCode).toBe(200);
    expect(storefront.json<PublicStorefrontResponse>()).toEqual({
      agentId: first.business.grogoniId,
      grogoniId: first.business.grogoniId,
      commerceAddress: "amina-seller@grogoni.com",
      businessName: "BigFish grogoni",
      presence: {
        status: "online",
        updatedAt: new Date(0).toISOString()
      },
      products: [
        {
          id: stockedProduct.id,
          name: "Tilapia pack",
          unit: "box",
          available: true,
          sellingPrice: 500,
          image: null
        }
      ]
    });
    expect(rawStorefront.json<PublicStorefrontResponse>().grogoniId).toBe(first.business.grogoniId);
    expect(storefront.json().products[0]).not.toHaveProperty("sku");
    expect(storefront.json().products[0]).not.toHaveProperty("buyingPrice");
    expect(store.snapshot().auditEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining(["business.storefront_id_created"])
    );

    await app.close();
  });
});

async function createOwnerBusiness(
  app: ReturnType<typeof buildApi>,
  destination: string,
  businessName: string,
  displayName?: string
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
  if (displayName !== undefined) {
    await postJson(app, "/account/display-name", { displayName }, sessionCookie, "PUT");
  }
  const business = await postJson<CreateBusinessResponse>(
    app,
    "/businesses",
    {
      name: businessName,
      language: "en"
    },
    sessionCookie
  );

  return {
    ...business,
    sessionCookie
  };
}

async function postJson<TResponse>(
  app: ReturnType<typeof buildApi>,
  url: string,
  payload: unknown,
  cookie?: string,
  method: "POST" | "PUT" = "POST"
): Promise<TResponse> {
  const response = await app.inject({
    method,
    url,
    headers: {
      ...jsonHeaders(),
      ...(cookie === undefined ? {} : { cookie })
    },
    payload: JSON.stringify(payload)
  });

  expect(response.statusCode).toBeGreaterThanOrEqual(200);
  expect(response.statusCode).toBeLessThan(300);
  return response.json<TResponse>();
}

function jsonHeaders() {
  return {
    "content-type": "application/json"
  };
}

function extractSessionCookie(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;

  if (raw === undefined) {
    throw new Error("Missing session cookie");
  }

  return raw.split(";")[0] ?? raw;
}
