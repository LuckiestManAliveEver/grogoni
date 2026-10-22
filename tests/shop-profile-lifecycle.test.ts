import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

interface OtpRequestResponse {
  challengeId: string;
  devOtp: string;
}

interface SessionResponse {
  account: {
    id: string;
  };
  session: {
    id: string;
  };
}

interface BusinessResponse {
  business: {
    id: string;
    grogoniId: string;
  };
}

interface ProductResponse {
  id: string;
}

interface ShopDeletionRequestResponse {
  request: {
    id: string;
    status: string;
  };
  preview: {
    counts: {
      products: number;
    };
  };
}

describe("Shop profile lifecycle", () => {
  it("rejects phone OTP verification and keeps shop deletion PIN-only", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const phone = "+254700000709";

    const rejectedSignup = await app.inject({
      method: "POST",
      url: "/auth/otp/request",
      headers: jsonHeaders(),
      payload: JSON.stringify({
        method: "phone",
        contact: phone,
        deliveryChannel: "sms",
        purpose: "signup"
      })
    });
    expect(rejectedSignup.statusCode).toBe(403);
    expect(rejectedSignup.json()).toMatchObject({ code: "phone_pin_only" });

    const rejectedRecovery = await app.inject({
      method: "POST",
      url: "/auth/otp/request",
      headers: jsonHeaders(),
      payload: JSON.stringify({
        method: "phone",
        contact: phone,
        deliveryChannel: "sms",
        purpose: "recovery"
      })
    });
    expect(rejectedRecovery.statusCode).toBe(403);
    expect(rejectedRecovery.json()).toMatchObject({ code: "phone_pin_only" });

    const rejectedVerification = await app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      headers: jsonHeaders(),
      payload: JSON.stringify({
        method: "phone",
        contact: phone,
        challengeId: "obsolete-phone-challenge",
        code: "123456"
      })
    });
    expect(rejectedVerification.statusCode).toBe(403);
    expect(rejectedVerification.json()).toMatchObject({ code: "phone_login_required" });

    const owner = await app.inject({
      method: "POST",
      url: "/auth/pin/signup",
      headers: jsonHeaders(),
      payload: JSON.stringify({
        method: "phone",
        contact: phone,
        pin: "1234"
      })
    });
    expect(owner.statusCode).toBe(200);
    const ownerCookie = extractSessionCookie(owner.headers["set-cookie"]);
    const shop = await postJson<BusinessResponse>(
      app,
      "/businesses",
      { name: "PIN Delete", language: "en" },
      ownerCookie
    );

    const deletion = await postJson<ShopDeletionRequestResponse>(
      app,
      `/businesses/${shop.business.id}/shop-deletion/request`,
      { shopId: shop.business.grogoniId },
      ownerCookie
    );
    const quarantined = await postJson<{ status: string }>(
      app,
      `/businesses/${shop.business.id}/shop-deletion/${deletion.request.id}/finalize`,
      {
        pin: "1234",
        acknowledgement: true,
        idempotencyKey: "pin-delete-shop"
      },
      ownerCookie
    );
    expect(quarantined.status).toBe("QUARANTINED");
    expect(store.snapshot().businesses).toHaveLength(1);

    expect(store.purgeExpiredShopDeletions(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000))).toBe(
      1
    );
    expect(store.snapshot().businesses).toHaveLength(0);
    expect(store.snapshot().accountDeletionRequests[0]?.status).toBe("PURGED");

    await app.close();
  });

  it("requires owner, exact shop ID and PIN, then supports restore", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const owner = await verifyOtp(app, "phone", "254700000701");
    const ownerCookie = extractSessionCookie(owner.setCookie);

    const firstShop = await postJson<BusinessResponse>(
      app,
      "/businesses",
      { name: "Delete Me", language: "en" },
      ownerCookie
    );
    const secondOwner = await verifyOtp(app, "phone", "254700000703");
    const secondOwnerCookie = extractSessionCookie(secondOwner.setCookie);
    const secondShop = await postJson<BusinessResponse>(
      app,
      "/businesses",
      { name: "Keep Me", language: "en" },
      secondOwnerCookie
    );
    await postJson<ProductResponse>(
      app,
      `/businesses/${firstShop.business.id}/products`,
      { name: "Sugar", unit: "kg", quantity: 3 },
      ownerCookie
    );
    await postJson<ProductResponse>(
      app,
      `/businesses/${secondShop.business.id}/products`,
      { name: "Rice", unit: "kg", quantity: 2 },
      secondOwnerCookie
    );

    const nonOwner = await verifyOtp(app, "phone", "254700000702");
    const nonOwnerRequest = await app.inject({
      method: "POST",
      url: `/businesses/${firstShop.business.id}/shop-deletion/request`,
      headers: {
        ...jsonHeaders(),
        cookie: extractSessionCookie(nonOwner.setCookie)
      },
      payload: JSON.stringify({ shopId: firstShop.business.grogoniId })
    });
    expect(nonOwnerRequest.statusCode).toBe(403);

    const wrongShopId = await app.inject({
      method: "POST",
      url: `/businesses/${firstShop.business.id}/shop-deletion/request`,
      headers: {
        ...jsonHeaders(),
        cookie: ownerCookie
      },
      payload: JSON.stringify({ shopId: "DELETE" })
    });
    expect(wrongShopId.statusCode).toBe(400);
    expect(wrongShopId.json()).toMatchObject({ code: "shop_id_mismatch" });

    const deletion = await postJson<ShopDeletionRequestResponse>(
      app,
      `/businesses/${firstShop.business.id}/shop-deletion/request`,
      { shopId: firstShop.business.grogoniId },
      ownerCookie
    );
    expect(deletion.request.status).toBe("PENDING_VERIFICATION");
    expect(deletion.preview.counts.products).toBe(1);

    const badPin = await app.inject({
      method: "POST",
      url: `/businesses/${firstShop.business.id}/shop-deletion/${deletion.request.id}/finalize`,
      headers: {
        ...jsonHeaders(),
        cookie: ownerCookie
      },
      payload: JSON.stringify({
        pin: "9999",
        acknowledgement: true,
        idempotencyKey: "delete-first-shop"
      })
    });
    expect(badPin.statusCode).toBe(401);

    const quarantined = await postJson<{ status: string; anonymizeAfter: string }>(
      app,
      `/businesses/${firstShop.business.id}/shop-deletion/${deletion.request.id}/finalize`,
      {
        pin: "1234",
        acknowledgement: true,
        idempotencyKey: "delete-first-shop"
      },
      ownerCookie
    );
    expect(quarantined.status).toBe("QUARANTINED");
    expect(new Date(quarantined.anonymizeAfter).getTime()).toBeGreaterThan(Date.now());

    const snapshot = store.snapshot();
    expect(snapshot.businesses.map((business) => business.id)).toContain(firstShop.business.id);
    expect(snapshot.businesses.map((business) => business.id)).toContain(secondShop.business.id);
    expect(snapshot.products.map((product) => product.name).sort()).toEqual(["Rice", "Sugar"]);
    expect(snapshot.auditEvents.some((event) => event.type === "shop_deletion.quarantined")).toBe(
      true
    );
    const shopsWhileQuarantined = await getJson<{ shops: Array<{ business: { id: string } }> }>(
      app,
      "/v1/shops",
      ownerCookie
    );
    expect(shopsWhileQuarantined.shops).toEqual([]);
    const secondOwnerShops = await getJson<{ shops: Array<{ business: { id: string } }> }>(
      app,
      "/v1/shops",
      secondOwnerCookie
    );
    expect(secondOwnerShops.shops.map((shop) => shop.business.id)).toEqual([
      secondShop.business.id
    ]);

    const restored = await postJson<{ status: string }>(
      app,
      `/businesses/${firstShop.business.id}/shop-deletion/${deletion.request.id}/restore`,
      {},
      ownerCookie
    );
    expect(restored.status).toBe("RESTORED");
    const shopsAfterRestore = await getJson<{ shops: Array<{ business: { id: string } }> }>(
      app,
      "/v1/shops",
      ownerCookie
    );
    expect(shopsAfterRestore.shops.map((shop) => shop.business.id)).toEqual([
      firstShop.business.id
    ]);

    await app.close();
  });

  it("does not allow a social identity to create a shop session", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const response = await app.inject({
      method: "POST",
      url: "/auth/social/login",
      headers: jsonHeaders(),
      payload: JSON.stringify({ provider: "google", email: "social-owner@example.com" })
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "social_login_disabled" });
    expect(response.headers["set-cookie"]).toBeUndefined();

    await app.close();
  });
});

async function verifyOtp(
  app: ReturnType<typeof buildApi>,
  channel: "phone" | "email",
  destination: string
): Promise<SessionResponse & { setCookie: string | string[] | undefined }> {
  if (channel === "phone") {
    const response = await app.inject({
      method: "POST",
      url: "/auth/pin/signup",
      headers: jsonHeaders(),
      payload: JSON.stringify({
        method: "phone",
        contact: destination.startsWith("+") ? destination : `+${destination}`,
        pin: "1234"
      })
    });
    expect(response.statusCode).toBe(200);
    return {
      ...response.json<SessionResponse>(),
      setCookie: response.headers["set-cookie"]
    };
  }

  const otp = await postJson<OtpRequestResponse>(app, "/auth/otp/request", {
    channel,
    destination
  });
  const response = await app.inject({
    method: "POST",
    url: "/auth/otp/verify",
    headers: jsonHeaders(),
    payload: JSON.stringify({
      challengeId: otp.challengeId,
      code: otp.devOtp
    })
  });

  expect(response.statusCode).toBe(200);
  return {
    ...response.json<SessionResponse>(),
    setCookie: response.headers["set-cookie"]
  };
}

async function postJson<T>(
  app: ReturnType<typeof buildApi>,
  url: string,
  payload: unknown,
  cookie?: string
): Promise<T> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: {
      ...jsonHeaders(),
      ...(cookie === undefined ? {} : { cookie })
    },
    payload: JSON.stringify(payload)
  });

  expect(response.statusCode).toBe(200);
  return response.json<T>();
}

async function getJson<T>(
  app: ReturnType<typeof buildApi>,
  url: string,
  cookie?: string
): Promise<T> {
  const response = await app.inject({
    method: "GET",
    url,
    headers: cookie === undefined ? {} : { cookie }
  });

  expect(response.statusCode).toBe(200);
  return response.json<T>();
}

function jsonHeaders() {
  return {
    "content-type": "application/json"
  };
}

function extractSessionCookie(setCookie: string | string[] | undefined): string {
  const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  expect(cookie).toBeTruthy();
  return cookie?.split(";")[0] ?? "";
}
