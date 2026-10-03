import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

describe("compulsory owner phone identity", () => {
  it("normalizes, stores, reuses, and keeps the owner phone private", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const firstOwner = await createEmailOwner(app, "phone-owner-one@example.test");

    const unauthenticated = await app.inject({
      method: "PUT",
      url: "/account/phone",
      headers: jsonHeaders(),
      payload: JSON.stringify({ phoneNumber: "0712345678", country: "KE" })
    });
    expect(unauthenticated.statusCode).toBe(401);

    const saved = await app.inject({
      method: "PUT",
      url: "/account/phone",
      headers: { ...jsonHeaders(), cookie: firstOwner.cookie },
      payload: JSON.stringify({ phoneNumber: "0712345678", country: "KE" })
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().user).toMatchObject({
      phoneNumberE164: "+254712345678",
      phoneCountryCode: "KE",
      phoneNationalNumber: "712345678",
      phoneVerificationStatus: "unverified",
      phoneSource: "shop_registration",
      publicPhoneEnabled: false
    });

    const repeated = await app.inject({
      method: "PUT",
      url: "/account/phone",
      headers: { ...jsonHeaders(), cookie: firstOwner.cookie },
      payload: JSON.stringify({ phoneNumber: "+254712345678", country: "KE" })
    });
    expect(repeated.statusCode).toBe(200);
    expect(
      store.snapshot().auditEvents.filter((event) => event.type === "owner.phone_updated")
    ).toHaveLength(1);

    const firstShop = await createShop(app, firstOwner.cookie, "Private Phone Shop");
    const secondShop = await app.inject({
      method: "POST",
      url: "/businesses",
      headers: { ...jsonHeaders(), cookie: firstOwner.cookie },
      payload: JSON.stringify({ name: "Same Owner Second Shop", language: "en" })
    });
    expect(secondShop.statusCode).toBe(409);
    expect(secondShop.json()).toMatchObject({ code: "store_already_registered" });

    const publicShop = await app.inject({
      method: "GET",
      url: `/public/storefronts/${firstShop.business.grogoniId}`
    });
    expect(publicShop.statusCode).toBe(200);
    expect(JSON.stringify(publicShop.json())).not.toContain("+254712345678");
    expect(publicShop.json()).not.toHaveProperty("phoneNumberE164");
    expect(firstShop.business).not.toHaveProperty("ownerPhoneNumberE164");

    const phoneAudit = store
      .snapshot()
      .auditEvents.find((event) => event.type === "owner.phone_updated");
    expect(JSON.stringify(phoneAudit)).not.toContain("+254712345678");
    expect(phoneAudit?.payload).toMatchObject({
      previousPhone: null,
      newPhone: "+254******678",
      verificationStatus: "unverified"
    });

    await app.close();
  });

  it("rejects invalid, missing, and cross-owner phone assignments without enumeration", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const firstOwner = await createEmailOwner(app, "phone-conflict-one@example.test");
    const secondOwner = await createEmailOwner(app, "phone-conflict-two@example.test");

    const missingPhoneShop = await app.inject({
      method: "POST",
      url: "/businesses",
      headers: { ...jsonHeaders(), cookie: firstOwner.cookie },
      payload: JSON.stringify({ name: "Missing Phone", language: "en" })
    });
    expect(missingPhoneShop.statusCode).toBe(400);
    expect(missingPhoneShop.json()).toMatchObject({ code: "phone_number_required" });
    expect(store.snapshot().businesses).toHaveLength(0);

    const invalid = await app.inject({
      method: "PUT",
      url: "/account/phone",
      headers: { ...jsonHeaders(), cookie: firstOwner.cookie },
      payload: JSON.stringify({ phoneNumber: "123", country: "KE" })
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "phone_number_invalid" });

    const created = await app.inject({
      method: "POST",
      url: "/businesses",
      headers: { ...jsonHeaders(), cookie: firstOwner.cookie },
      payload: JSON.stringify({
        name: "Normalized Transaction Shop",
        language: "en",
        phoneNumber: "254712345678",
        phoneCountry: "KE"
      })
    });
    expect(created.statusCode).toBe(200);
    const createdMembership = created.json<{ membership: { userId: string } }>().membership;
    expect(
      store.snapshot().users.find((user) => user.id === createdMembership.userId)?.phoneNumberE164
    ).toBe("+254712345678");

    const conflict = await app.inject({
      method: "PUT",
      url: "/account/phone",
      headers: { ...jsonHeaders(), cookie: secondOwner.cookie },
      payload: JSON.stringify({ phoneNumber: "+254712345678", country: "KE" })
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      code: "PHONE_ALREADY_IN_USE",
      message: "This phone number is already associated with another account."
    });

    await app.close();
  });

  it("requires recent authentication before changing a phone number", () => {
    const store = createCp2Store();
    const authenticatedAt = new Date("2026-07-18T12:00:00.000Z");
    const challenge = store.requestOtp({
      channel: "email",
      destination: "stale-phone-session@example.test",
      purpose: "signup",
      now: authenticatedAt
    });
    const session = store.verifyOtp({
      challengeId: challenge.challengeId,
      code: challenge.devOtp,
      now: authenticatedAt
    });
    store.setAccountPin({ sessionId: session.session.id, pin: "1234", now: authenticatedAt });

    expect(() =>
      store.updateOwnerPhone({
        sessionId: session.session.id,
        phoneNumber: "0712345678",
        country: "KE",
        now: new Date(authenticatedAt.getTime() + 16 * 60 * 1000)
      })
    ).toThrowError(
      expect.objectContaining({
        statusCode: 401,
        code: "auth_required"
      })
    );
  });
});

async function createEmailOwner(
  app: ReturnType<typeof buildApi>,
  email: string
): Promise<{ cookie: string; userId: string }> {
  const requested = await app.inject({
    method: "POST",
    url: "/auth/otp/request",
    headers: jsonHeaders(),
    payload: JSON.stringify({
      method: "email",
      contact: email,
      deliveryChannel: "email",
      purpose: "signup"
    })
  });
  expect(requested.statusCode).toBe(200);

  const verified = await app.inject({
    method: "POST",
    url: "/auth/otp/verify",
    headers: jsonHeaders(),
    payload: JSON.stringify({
      challengeId: requested.json<{ challengeId: string }>().challengeId,
      code: requested.json<{ devOtp: string }>().devOtp
    })
  });
  expect(verified.statusCode).toBe(200);
  const cookie = extractSessionCookie(verified.headers["set-cookie"]);
  const pin = await app.inject({
    method: "POST",
    url: "/auth/pin/setup",
    headers: { ...jsonHeaders(), cookie },
    payload: JSON.stringify({ pin: "1234" })
  });
  expect(pin.statusCode).toBe(200);

  return {
    cookie,
    userId: verified.json<{ user: { id: string } }>().user.id
  };
}

async function createShop(
  app: ReturnType<typeof buildApi>,
  cookie: string,
  name: string
): Promise<{ business: { id: string; grogoniId: string } }> {
  const response = await app.inject({
    method: "POST",
    url: "/businesses",
    headers: { ...jsonHeaders(), cookie },
    payload: JSON.stringify({ name, language: "en" })
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

function extractSessionCookie(setCookie: string | string[] | undefined): string {
  const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return cookie?.split(";")[0] ?? "";
}

function jsonHeaders() {
  return {
    "content-type": "application/json"
  };
}
