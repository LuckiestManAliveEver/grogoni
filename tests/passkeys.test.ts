import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

const origin = "http://localhost:5173";

describe("passkey authentication", () => {
  it("creates server-bound registration and discoverable login ceremonies", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const sessionCookie = await createSessionCookie(app);

    const registration = await app.inject({
      method: "POST",
      url: "/auth/passkeys/register/options",
      headers: {
        cookie: sessionCookie,
        origin
      }
    });

    expect(registration.statusCode).toBe(200);
    expect(registration.json()).toMatchObject({
      ceremonyId: expect.any(String),
      options: {
        challenge: expect.any(String),
        rp: { name: "Grogoni" },
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required"
        }
      }
    });

    const login = await app.inject({
      method: "POST",
      url: "/auth/passkeys/login/options",
      headers: { origin }
    });

    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({
      ceremonyId: expect.any(String),
      options: {
        challenge: expect.any(String),
        userVerification: "required"
      }
    });

    const invalidPurpose = await app.inject({
      method: "POST",
      url: "/auth/passkeys/login/options",
      headers: { "content-type": "application/json", origin },
      payload: { purpose: "pin_recovery_and_login" }
    });
    expect(invalidPurpose.statusCode).toBe(400);
    expect(invalidPurpose.json()).toMatchObject({ code: "passkey_purpose_invalid" });
    expect(store.snapshot().passkeyCeremonies).toHaveLength(2);

    await app.close();
  });

  it("rejects untrusted origins and keeps passkeys account-scoped after hydration", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const sessionCookie = await createSessionCookie(app);

    const rejected = await app.inject({
      method: "POST",
      url: "/auth/passkeys/register/options",
      headers: {
        cookie: sessionCookie,
        origin: "https://attacker.example"
      }
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).toMatchObject({ code: "passkey_origin_not_allowed" });

    const snapshot = store.snapshot();
    const account = snapshot.accounts[0];
    const user = snapshot.users[0];
    expect(account).toBeDefined();
    expect(user).toBeDefined();
    snapshot.passkeys = [
      {
        id: "credential-id",
        accountId: account!.id,
        userId: user!.id,
        webauthnUserId: "user-handle",
        publicKey: "AQID",
        counter: 0,
        label: "Android passkey",
        deviceType: "multiDevice",
        backedUp: true,
        transports: ["internal", "hybrid"],
        createdAt: new Date(0).toISOString(),
        lastUsedAt: null
      }
    ];

    const restoredStore = createCp2Store();
    restoredStore.hydrateSnapshot(snapshot);
    const restoredApp = buildApi({ cp2: { store: restoredStore } });
    const listed = await restoredApp.inject({
      method: "GET",
      url: "/auth/passkeys",
      headers: { cookie: sessionCookie }
    });

    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      passkeys: [
        expect.objectContaining({
          id: "credential-id",
          label: "Android passkey",
          backedUp: true
        })
      ]
    });

    await app.close();
    await restoredApp.close();
  });

  it("uses a purpose-bound passkey grant once to reset a phone PIN", async () => {
    const sourceStore = createCp2Store();
    sourceStore.signupWithPhonePin({ destination: "+254700000099", pin: "2468" });
    const snapshot = sourceStore.snapshot();
    const account = snapshot.accounts[0]!;
    const user = snapshot.users[0]!;
    snapshot.passkeys = [
      {
        id: "phone-passkey",
        accountId: account.id,
        userId: user.id,
        webauthnUserId: "phone-user-handle",
        publicKey: "AQID",
        counter: 0,
        label: "Phone passkey",
        deviceType: "multiDevice",
        backedUp: true,
        transports: ["internal"],
        createdAt: new Date(0).toISOString(),
        lastUsedAt: null
      }
    ];
    const store = createCp2Store({
      passkeyAuthenticationVerifier: async () => ({
        verified: true,
        authenticationInfo: {
          newCounter: 1,
          credentialID: "phone-passkey",
          credentialBackedUp: true,
          credentialDeviceType: "multiDevice",
          origin,
          rpID: "localhost",
          userVerified: true
        }
      })
    });
    store.hydrateSnapshot(snapshot);
    const app = buildApi({ cp2: { store } });

    const normalAuthentication = await authenticatePasskey(app, "login");
    const normalReset = await app.inject({
      method: "POST",
      url: "/auth/pin/recover/passkey",
      headers: { "content-type": "application/json", cookie: normalAuthentication.cookie },
      payload: { pin: "1357" }
    });
    expect(normalReset.statusCode).toBe(401);
    expect(normalReset.json()).toMatchObject({ code: "passkey_pin_recovery_required" });

    const recoveryAuthentication = await authenticatePasskey(app, "pin_recovery");
    const recovered = await app.inject({
      method: "POST",
      url: "/auth/pin/recover/passkey",
      headers: { "content-type": "application/json", cookie: recoveryAuthentication.cookie },
      payload: { pin: "1357" }
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.cookies.map((cookie) => cookie.name)).toEqual(
      expect.arrayContaining(["grogoni_session", "grogoni_refresh"])
    );

    const reusedGrant = await app.inject({
      method: "POST",
      url: "/auth/pin/recover/passkey",
      headers: { "content-type": "application/json", cookie: recoveryAuthentication.cookie },
      payload: { pin: "8642" }
    });
    expect(reusedGrant.statusCode).toBe(401);
    expect(reusedGrant.json()).toMatchObject({ code: "passkey_pin_recovery_required" });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/auth/session/refresh",
          headers: { cookie: responseCookies(recovered) }
        })
      ).statusCode
    ).toBe(200);

    const oldPin = await loginWithPin(app, "2468");
    const newPin = await loginWithPin(app, "1357");
    expect(oldPin.statusCode).toBe(401);
    expect(newPin.statusCode).toBe(200);

    await app.close();
  });

  it("routes a passkey-authenticated phone account without a PIN through first-PIN setup", async () => {
    const sourceStore = createCp2Store();
    sourceStore.signupWithPhonePin({ destination: "+254700000100", pin: "2468" });
    const snapshot = sourceStore.snapshot();
    const account = snapshot.accounts[0]!;
    const user = snapshot.users[0]!;
    snapshot.accountPinHashes = [];
    snapshot.passkeys = [
      {
        id: "phone-passkey",
        accountId: account.id,
        userId: user.id,
        webauthnUserId: "phone-user-handle",
        publicKey: "AQID",
        counter: 0,
        label: "Phone passkey",
        deviceType: "multiDevice",
        backedUp: true,
        transports: ["internal"],
        createdAt: new Date(0).toISOString(),
        lastUsedAt: null
      }
    ];
    const store = createCp2Store({
      passkeyAuthenticationVerifier: async () => ({
        verified: true,
        authenticationInfo: {
          newCounter: 1,
          credentialID: "phone-passkey",
          credentialBackedUp: true,
          credentialDeviceType: "multiDevice",
          origin,
          rpID: "localhost",
          userVerified: true
        }
      })
    });
    store.hydrateSnapshot(snapshot);
    const app = buildApi({ cp2: { store } });

    const authentication = await authenticatePasskey(app, "pin_recovery");
    expect(authentication.cookieNames).toEqual(
      expect.arrayContaining(["grogoni_session", "grogoni_refresh"])
    );
    const status = await app.inject({
      method: "GET",
      url: "/auth/credentials/status",
      headers: { cookie: authentication.cookie }
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ hasPin: false, hasPassword: false });

    // A semantic recovery request remains a controlled conflict and, critically, does not burn
    // the valid grant. A second request therefore remains a 409 instead of becoming a 401.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const wrongEndpoint = await app.inject({
        method: "POST",
        url: "/auth/pin/recover/passkey",
        headers: { "content-type": "application/json", cookie: authentication.cookie },
        payload: { pin: "1357" }
      });
      expect(wrongEndpoint.statusCode).toBe(409);
      expect(wrongEndpoint.json()).toMatchObject({ code: "pin_not_set" });
    }

    const setup = await app.inject({
      method: "POST",
      url: "/auth/pin/setup",
      headers: { "content-type": "application/json", cookie: authentication.cookie },
      payload: { pin: "1357", pinConfirmation: "1357" }
    });
    expect(setup.statusCode).toBe(200);
    expect(setup.cookies.map((cookie) => cookie.name)).toEqual(
      expect.arrayContaining(["grogoni_session", "grogoni_refresh"])
    );
    const consumedGrant = await app.inject({
      method: "POST",
      url: "/auth/pin/recover/passkey",
      headers: { "content-type": "application/json", cookie: authentication.cookie },
      payload: { pin: "8642" }
    });
    expect(consumedGrant.statusCode).toBe(401);
    expect(consumedGrant.json()).toMatchObject({ code: "passkey_pin_recovery_required" });
    const refreshed = await app.inject({
      method: "POST",
      url: "/auth/session/refresh",
      headers: { cookie: responseCookies(setup) }
    });
    expect(refreshed.statusCode).toBe(200);

    expect((await loginWithPin(app, "1357", "+254700000100")).statusCode).toBe(200);
    await app.close();
  });
});

async function authenticatePasskey(
  app: ReturnType<typeof buildApi>,
  purpose: "login" | "pin_recovery"
): Promise<{ cookie: string; cookieNames: string[] }> {
  const options = await app.inject({
    method: "POST",
    url: "/auth/passkeys/login/options",
    headers: { "content-type": "application/json", origin },
    payload: { purpose }
  });
  expect(options.statusCode).toBe(200);
  const ceremonyId = options.json<{ ceremonyId: string }>().ceremonyId;
  const verified = await app.inject({
    method: "POST",
    url: "/auth/passkeys/login/verify",
    headers: { "content-type": "application/json", origin },
    payload: {
      ceremonyId,
      response: {
        id: "phone-passkey",
        rawId: "phone-passkey",
        type: "public-key",
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
        response: {
          authenticatorData: "AQID",
          clientDataJSON: "AQID",
          signature: "AQID",
          userHandle: "phone-user-handle"
        }
      }
    }
  });
  expect(verified.statusCode, JSON.stringify(verified.json())).toBe(200);
  return {
    cookie: responseCookies(verified),
    cookieNames: verified.cookies.map((cookie) => cookie.name)
  };
}

function loginWithPin(app: ReturnType<typeof buildApi>, pin: string, contact = "+254700000099") {
  return app.inject({
    method: "POST",
    url: "/auth/pin/login",
    headers: { "content-type": "application/json" },
    payload: { method: "phone", contact, pin }
  });
}

function responseCookies(response: { cookies: Array<{ name: string; value: string }> }): string {
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function createSessionCookie(app: ReturnType<typeof buildApi>): Promise<string> {
  const otpRequest = await app.inject({
    method: "POST",
    url: "/auth/otp/request",
    headers: { "content-type": "application/json" },
    payload: {
      channel: "email",
      destination: "passkey-owner@example.com"
    }
  });
  const challenge = otpRequest.json<{ challengeId: string; devOtp: string }>();
  const verified = await app.inject({
    method: "POST",
    url: "/auth/otp/verify",
    headers: { "content-type": "application/json" },
    payload: {
      challengeId: challenge.challengeId,
      code: challenge.devOtp
    }
  });
  const setCookie = verified.headers["set-cookie"];
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return String(value).split(";")[0] ?? "";
}
