import {
  seedLegacyEmailAccount,
  signupWithBackupEmail,
  completeEmailMfa
} from "./fixtures/account-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

interface OtpRequestResponse {
  challengeId: string;
  destination: string;
  devOtp?: string;
}

interface VerifyOtpResponse {
  account: {
    id: string;
  };
  user: {
    id: string;
    language: string;
  };
  session: {
    id: string;
  };
  resumed: boolean;
}

interface PhonePinSignupResponse {
  account: {
    id: string;
    primaryAuthChannel: string;
    primaryAuthDestination: string;
  };
  session: {
    id: string;
  };
}

interface CreateBusinessResponse {
  business: {
    id: string;
    language: string;
    grogoniId: string;
  };
  membership: {
    role: string;
  };
}

interface RoleCheckResponse {
  allowed: boolean;
  role: string;
}

interface ProductResponse {
  id: string;
  name: string;
  unit: string;
  quantity: number;
  buyingPrice: number | null;
  sellingPrice: number | null;
}

interface PublicStorefrontResponse {
  agentId: string;
  grogoniId: string;
  commerceAddress: string;
  businessName: string;
  presence: { status: "online" | "private" | "offline"; updatedAt: string };
  products: Array<{
    id: string;
    name: string;
    unit: string;
    available: boolean;
  }>;
}

describe("CP2 auth and business creation", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("creates an owner account, session, business, language preference, role, and audit events", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });

    const verifyResponse = await app.inject({
      method: "POST",
      url: "/auth/pin/signup",
      headers: jsonHeaders(),
      payload: JSON.stringify({
        method: "phone",
        contact: "+254700000001",
        pin: "1234"
      })
    });
    const sessionCookie = extractSessionCookie(verifyResponse.headers["set-cookie"]);
    const auth = verifyResponse.json<VerifyOtpResponse>();

    expect(verifyResponse.statusCode).toBe(200);
    expect(sessionCookie).toContain("grogoni_session=");

    const sessionResponse = await app.inject({
      method: "GET",
      url: "/session",
      headers: {
        cookie: sessionCookie
      }
    });

    expect(sessionResponse.statusCode).toBe(200);
    expect(sessionResponse.json<VerifyOtpResponse>().account.id).toBe(auth.account.id);

    const business = await postJson<CreateBusinessResponse>(
      app,
      "/businesses",
      {
        name: "Jane's Shop",
        language: "sw"
      },
      sessionCookie
    );

    expect(business.business.language).toBe("sw");
    expect(business.business.grogoniId).toBe("grogoni.janes-shop");
    expect(business.membership.role).toBe("owner");

    const ownerRole = await postJson<RoleCheckResponse>(
      app,
      "/roles/check",
      {
        businessId: business.business.id,
        role: "owner"
      },
      sessionCookie
    );
    const cashierRole = await postJson<RoleCheckResponse>(
      app,
      "/roles/check",
      {
        businessId: business.business.id,
        role: "cashier"
      },
      sessionCookie
    );

    expect(ownerRole).toEqual({
      allowed: true,
      role: "owner",
      permission: "business:read"
    });
    expect(cashierRole.allowed).toBe(false);

    const refreshedSession = await app.inject({
      method: "GET",
      url: "/session",
      headers: {
        cookie: sessionCookie
      }
    });

    expect(refreshedSession.json<VerifyOtpResponse>().user.language).toBe("sw");

    const auditTypes = store.snapshot().auditEvents.map((event) => event.type);
    expect(auditTypes).toEqual(
      expect.arrayContaining([
        "user.created",
        "auth.session_created",
        "auth.pin_signup",
        "account.created",
        "business.created",
        "business.storefront_id_created",
        "membership.created"
      ])
    );
    expect(Object.isFrozen(store.snapshot().auditEvents[0]?.payload)).toBe(true);

    const logoutResponse = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: {
        cookie: sessionCookie
      }
    });

    expect(logoutResponse.statusCode).toBe(200);

    const afterLogout = await app.inject({
      method: "GET",
      url: "/session",
      headers: {
        cookie: sessionCookie
      }
    });

    expect(afterLogout.statusCode).toBe(401);
    expect(store.snapshot().auditEvents.map((event) => event.type)).toContain(
      "auth.session_revoked"
    );

    await app.close();
  });

  it("allows only one store registration per account under concurrent requests", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const signup = await app.inject({
      method: "POST",
      url: "/auth/pin/signup",
      headers: jsonHeaders(),
      payload: JSON.stringify({
        method: "phone",
        contact: "+254700000099",
        pin: "1234"
      })
    });
    const sessionCookie = extractSessionCookie(signup.headers["set-cookie"]);
    const create = (name: string) =>
      app.inject({
        method: "POST",
        url: "/businesses",
        headers: { ...jsonHeaders(), cookie: sessionCookie },
        payload: JSON.stringify({ name, language: "en" })
      });

    const responses = await Promise.all([create("Only Store"), create("Blocked Store")]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(responses.find((response) => response.statusCode === 409)?.json()).toMatchObject({
      code: "store_already_registered"
    });
    expect(store.snapshot().businesses).toHaveLength(1);
    expect(store.snapshot().memberships).toEqual([expect.objectContaining({ role: "owner" })]);

    await app.close();
  });

  it("keeps a verified OAuth email on one account across providers and restarts", () => {
    const store = createCp2Store();
    const google = store.completeOAuthProfileAuthentication({
      provider: "google",
      profile: {
        providerSubject: "google-one-store-owner",
        email: "Owner@One-Store.Example",
        emailVerified: true,
        displayName: "Store Owner"
      },
      tokens: {}
    });
    const restored = createCp2Store();
    restored.hydrateSnapshot(store.snapshot());
    const microsoft = restored.completeOAuthProfileAuthentication({
      provider: "microsoft",
      profile: {
        providerSubject: "microsoft-one-store-owner",
        email: "owner@one-store.example",
        emailVerified: true,
        displayName: "Store Owner"
      },
      tokens: {}
    });
    const emailIdentities = restored
      .snapshot()
      .accountIdentities.filter((identity) => identity.type === "email");

    expect(microsoft.account.id).toBe(google.account.id);
    expect(restored.snapshot().accounts).toHaveLength(1);
    expect(emailIdentities).toEqual([
      expect.objectContaining({
        accountId: google.account.id,
        normalizedValue: "owner@one-store.example",
        verifiedAt: expect.any(String)
      })
    ]);
  });

  it("rejects retired OTP login and unauthenticated business creation", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });

    const badOtp = await app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      payload: { challengeId: "retired", code: "000000" }
    });
    expect(badOtp.statusCode).toBe(403);
    expect(badOtp.json()).toMatchObject({ code: "phone_login_required" });

    const unauthenticatedBusiness = await app.inject({
      method: "POST",
      url: "/businesses",
      headers: jsonHeaders(),
      payload: JSON.stringify({
        name: "Blocked Shop",
        language: "en"
      })
    });

    expect(unauthenticatedBusiness.statusCode).toBe(401);

    const migrated = seedLegacyEmailAccount(store, "owner@example.com");
    const sessionCookie = `grogoni_session=${migrated.session.id}`;
    const createdBusiness = await app.inject({
      method: "POST",
      url: "/businesses",
      headers: {
        ...jsonHeaders(),
        cookie: sessionCookie
      },
      payload: JSON.stringify({
        name: "Session Only Shop",
        language: "en"
      })
    });

    expect(createdBusiness.statusCode).toBe(400);
    expect(createdBusiness.json()).toMatchObject({ code: "phone_number_required" });

    const createdBusinessWithPhone = await app.inject({
      method: "POST",
      url: "/businesses",
      headers: {
        ...jsonHeaders(),
        cookie: sessionCookie
      },
      payload: JSON.stringify({
        name: "Session Only Shop",
        language: "en",
        phoneNumber: "0712345678",
        phoneCountry: "KE"
      })
    });
    expect(createdBusinessWithPhone.statusCode).toBe(200);

    const roleResponse = await app.inject({
      method: "POST",
      url: "/roles/check",
      headers: {
        ...jsonHeaders(),
        cookie: sessionCookie
      },
      payload: JSON.stringify({
        businessId: "missing-business",
        role: "admin"
      })
    });

    expect(roleResponse.statusCode).toBe(400);
    expect(roleResponse.json()).toMatchObject({
      code: "role_invalid"
    });

    await app.close();
  });

  it("links and verifies backup email without allowing email session creation", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const owner = await signupWithBackupEmail(app, "Owner@Example.com");
    expect(store.snapshot().accountIdentities).toContainEqual(
      expect.objectContaining({
        type: "email",
        normalizedValue: "owner@example.com",
        verifiedAt: expect.any(String)
      })
    );
    const blocked = await app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      payload: { method: "email", contact: "owner@example.com", otp: "000000" }
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.headers["set-cookie"]).toBeUndefined();
    expect(owner.cookie).toContain("grogoni_session=");
    await app.close();
  });

  it("rejects the legacy social login endpoint", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });

    const social = await app.inject({
      method: "POST",
      url: "/auth/social/login",
      headers: jsonHeaders(),
      payload: JSON.stringify({
        provider: "google",
        email: "Owner@Social.example",
        displayName: "Social Owner"
      })
    });

    expect(social.statusCode).toBe(403);
    expect(social.json()).toMatchObject({ code: "social_login_disabled" });
    expect(social.headers["set-cookie"]).toBeUndefined();
    expect(store.snapshot().accounts).toHaveLength(0);

    await app.close();
  });

  it("creates a phone account and session with a PIN without requesting an OTP", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const phone = "+254700000088";

    const signup = await app.inject({
      method: "POST",
      url: "/auth/pin/signup",
      headers: jsonHeaders(),
      payload: JSON.stringify({
        method: "phone",
        contact: phone,
        pin: "2468"
      })
    });
    const signupCookie = extractSessionCookie(signup.headers["set-cookie"]);
    const signupResult = signup.json<PhonePinSignupResponse>();

    expect(signup.statusCode).toBe(200);
    expect(signupResult.account).toMatchObject({
      primaryAuthChannel: "phone",
      primaryAuthDestination: phone
    });
    expect(signupResult).not.toHaveProperty("recoveryCode");
    expect(signupCookie).toContain("grogoni_session=");
    expect(store.snapshot().otpChallenges).toHaveLength(0);
    expect(store.snapshot().accountPinHashes[0]).toMatchObject({
      accountId: signupResult.account.id
    });
    expect(store.snapshot().accountPinHashes[0]).not.toHaveProperty("recoveryCodeHash");

    const pinStatus = await app.inject({
      method: "GET",
      url: "/auth/pin/status",
      headers: { cookie: signupCookie }
    });
    expect(pinStatus.json()).toMatchObject({ hasPin: true });

    const duplicate = await app.inject({
      method: "POST",
      url: "/auth/pin/signup",
      headers: jsonHeaders(),
      payload: JSON.stringify({
        method: "phone",
        contact: phone,
        pin: "2468"
      })
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: "account_exists" });

    await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: signupCookie }
    });
    const login = await app.inject({
      method: "POST",
      url: "/auth/pin/login",
      headers: jsonHeaders(),
      payload: JSON.stringify({
        method: "phone",
        contact: phone,
        pin: "2468"
      })
    });
    expect(login.statusCode).toBe(200);
    const loginCookie = extractSessionCookie(login.headers["set-cookie"]);
    expect(loginCookie).toContain("grogoni_session=");

    const retiredRecovery = await app.inject({
      method: "POST",
      url: "/auth/pin/recover/phone",
      headers: jsonHeaders(),
      payload: JSON.stringify({
        method: "phone",
        contact: phone,
        recoveryCode: "0000-0000-0000-0000-0000-0000",
        pin: "1357"
      })
    });
    expect(retiredRecovery.statusCode).toBe(404);
    expect(loginCookie).toContain("grogoni_session=");

    await app.close();
  });

  it("rejects OTP sign-in for an email already attached to another account", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });

    const start = await postJson<{ transactionId: string }>(app, "/auth/signup/start", {
      type: "phone",
      identifier: "+254700000051"
    });
    const completed = await app.inject({
      method: "POST",
      url: "/auth/signup/complete",
      headers: jsonHeaders(),
      payload: JSON.stringify({
        transactionId: start.transactionId,
        displayName: "Test User",
        email: "owner@example.com",
        password: "a reasonably long password",
        passwordConfirmation: "a reasonably long password",
        termsAccepted: true,
        privacyAccepted: true
      })
    });

    expect(completed.statusCode).toBe(200);

    const otpResponse = await postJson<OtpRequestResponse>(app, "/auth/otp/request", {
      channel: "email",
      destination: "owner@example.com",
      purpose: "recovery"
    });

    const duplicate = await app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      headers: jsonHeaders(),
      payload: JSON.stringify({
        challengeId: otpResponse.challengeId,
        code: otpResponse.devOtp
      })
    });

    expect(duplicate.statusCode).toBe(403);
    expect(duplicate.json()).toMatchObject({ code: "phone_login_required" });

    await app.close();
  });

  it("persists phone PIN hashes without a separate recovery credential", () => {
    const store = createCp2Store();
    store.signupWithPhonePin({
      destination: "+254700000089",
      pin: "2468"
    });
    const snapshot = store.snapshot();
    const restored = createCp2Store();
    restored.hydrateSnapshot(snapshot);

    expect(snapshot.accountPinHashes[0]).not.toHaveProperty("recoveryCodeHash");
    const login = restored.loginWithAccountPin({
      channel: "phone",
      destination: "+254700000089",
      pin: "2468"
    });
    expect(login.account.primaryAuthChannel).toBe("phone");
  });

  it("sets a migrated account PIN and logs in through its linked phone", async () => {
    vi.stubEnv("OTP_COOLDOWN_SECONDS", "0");
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });

    const verified = seedLegacyEmailAccount(store, "pin-owner@example.test");
    const sessionCookie = `grogoni_session=${verified.session.id}`;
    const initialPinStatus = await app.inject({
      method: "GET",
      url: "/auth/pin/status",
      headers: {
        cookie: sessionCookie
      }
    });
    const recoverBeforeSetup = await app.inject({
      method: "POST",
      url: "/auth/pin/recover",
      headers: {
        ...jsonHeaders(),
        cookie: sessionCookie
      },
      payload: JSON.stringify({
        pin: "7777"
      })
    });

    expect(initialPinStatus.json()).toMatchObject({
      hasPin: false
    });
    expect(recoverBeforeSetup.statusCode).toBe(409);
    expect(recoverBeforeSetup.json()).toMatchObject({
      code: "pin_not_set"
    });

    const pinSetup = await postJson<VerifyOtpResponse>(
      app,
      "/auth/pin/setup",
      {
        pin: "1234"
      },
      sessionCookie
    );
    const setupPinStatus = await app.inject({
      method: "GET",
      url: "/auth/pin/status",
      headers: {
        cookie: sessionCookie
      }
    });
    const business = await postJson<CreateBusinessResponse>(
      app,
      "/businesses",
      {
        name: "Pinned Shop",
        language: "en",
        phoneNumber: "0712345678",
        phoneCountry: "KE"
      },
      sessionCookie
    );

    expect(pinSetup.account.id).toBe(verified.account.id);
    expect(setupPinStatus.json()).toMatchObject({
      hasPin: true
    });
    expect(business.membership.role).toBe("owner");

    await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: {
        cookie: sessionCookie
      }
    });

    const badPinLogin = await app.inject({
      method: "POST",
      url: "/auth/pin/login",
      headers: jsonHeaders(),
      payload: JSON.stringify({
        method: "phone",
        contact: "+254712345678",
        pin: "0000"
      })
    });

    expect(badPinLogin.statusCode).toBe(401);
    expect(badPinLogin.json()).toMatchObject({
      code: "auth_credentials_invalid"
    });

    const pendingLogin = await app.inject({
      method: "POST",
      url: "/auth/pin/login",
      headers: jsonHeaders(),
      payload: JSON.stringify({
        method: "phone",
        contact: "+254712345678",
        pin: "1234"
      })
    });
    expect(pendingLogin.statusCode).toBe(202);
    expect(pendingLogin.headers["set-cookie"]).toBeUndefined();
    const login = await completeEmailMfa(
      app,
      pendingLogin.json<{ transactionId: string }>().transactionId
    );
    const loginCookie = extractSessionCookie(login.headers["set-cookie"]);

    expect(login.statusCode).toBe(200);
    expect(loginCookie).toContain("grogoni_session=");
    expect(login.json<VerifyOtpResponse>().account.id).toBe(verified.account.id);

    const allowedRole = await postJson<RoleCheckResponse>(
      app,
      "/roles/check",
      {
        businessId: business.business.id,
        role: "owner"
      },
      loginCookie
    );

    expect(allowedRole.allowed).toBe(true);

    await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: {
        cookie: loginCookie
      }
    });

    // Seed the proof held by migrated snapshots; the retired HTTP OTP login stays disabled.
    const recoveryOtp = store.requestOtp({
      channel: "email",
      destination: "pin-owner@example.test",
      purpose: "recovery"
    });
    const recovery = store.verifyOtp({
      challengeId: recoveryOtp.challengeId,
      code: recoveryOtp.devOtp
    });
    const recoveryCookie = `grogoni_session=${recovery.session.id}`;

    await postJson<VerifyOtpResponse>(
      app,
      "/auth/pin/recover",
      {
        pin: "7777"
      },
      recoveryCookie
    );

    const recoveredRole = await postJson<RoleCheckResponse>(
      app,
      "/roles/check",
      {
        businessId: business.business.id,
        role: "owner"
      },
      recoveryCookie
    );

    expect(recoveredRole.allowed).toBe(true);

    await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: {
        cookie: recoveryCookie
      }
    });

    const oldPin = await app.inject({
      method: "POST",
      url: "/auth/pin/login",
      headers: jsonHeaders(),
      payload: JSON.stringify({
        method: "phone",
        contact: "+254712345678",
        pin: "1234"
      })
    });
    const newPin = await app.inject({
      method: "POST",
      url: "/auth/pin/login",
      headers: jsonHeaders(),
      payload: JSON.stringify({
        method: "phone",
        contact: "+254712345678",
        pin: "7777"
      })
    });

    expect(oldPin.statusCode).toBe(401);
    expect(newPin.statusCode).toBe(202);
    const verifiedNewPin = await completeEmailMfa(
      app,
      newPin.json<{ transactionId: string }>().transactionId
    );
    expect(verifiedNewPin.json<VerifyOtpResponse>().account.id).toBe(verified.account.id);

    await app.close();
  });

  it("serves a public storefront product list without exposing business data", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });

    const verifyResponse = await app.inject({
      method: "POST",
      url: "/auth/pin/signup",
      headers: jsonHeaders(),
      payload: JSON.stringify({
        method: "phone",
        contact: "+254700000004",
        pin: "1234"
      })
    });
    const sessionCookie = extractSessionCookie(verifyResponse.headers["set-cookie"]);
    const businessName = "Public Shop";
    const business = await postJson<CreateBusinessResponse>(
      app,
      "/businesses",
      {
        name: businessName,
        language: "en"
      },
      sessionCookie
    );
    const stockedProduct = await postJson<ProductResponse>(
      app,
      `/businesses/${business.business.id}/products`,
      {
        name: "Grogoni Rice",
        sku: "PRIVATE-SKU",
        unit: "2 kg bag",
        quantity: 4,
        buyingPrice: 120,
        sellingPrice: 180
      },
      sessionCookie
    );

    await postJson<ProductResponse>(
      app,
      `/businesses/${business.business.id}/products`,
      {
        name: "Out of stock beans",
        sku: "HIDDEN-SKU",
        unit: "kg",
        quantity: 0
      },
      sessionCookie
    );

    const publicResponse = await app.inject({
      method: "GET",
      url: `/public/storefronts/${encodeURIComponent(business.business.grogoniId)}`
    });
    const privateProducts = await app.inject({
      method: "GET",
      url: `/businesses/${business.business.id}/products`
    });

    expect(publicResponse.statusCode).toBe(200);
    expect(privateProducts.statusCode).toBe(401);
    expect(publicResponse.json<PublicStorefrontResponse>()).toEqual({
      agentId: business.business.grogoniId,
      grogoniId: business.business.grogoniId,
      commerceAddress: "public-shop@grogoni.com",
      businessName,
      presence: { status: "online", updatedAt: "1970-01-01T00:00:00.000Z" },
      products: [
        {
          id: stockedProduct.id,
          name: "Grogoni Rice",
          unit: "2 kg bag",
          available: true,
          sellingPrice: 180,
          image: null
        }
      ]
    });
    expect(publicResponse.json().products[0]).not.toHaveProperty("businessId");
    expect(publicResponse.json().products[0]).not.toHaveProperty("sku");
    expect(publicResponse.json().products[0]).not.toHaveProperty("quantity");
    expect(publicResponse.json().products[0]).not.toHaveProperty("buyingPrice");
    expect(publicResponse.json().products[0]).toHaveProperty("sellingPrice", 180);
    expect(publicResponse.json().products[0]).not.toHaveProperty("createdAt");
    expect(publicResponse.json().products[0]).not.toHaveProperty("updatedAt");

    await app.close();
  });
});

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
