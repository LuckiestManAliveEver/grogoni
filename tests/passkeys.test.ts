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

  it("does not authorize PIN or password recovery with passkey proof", async () => {
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

    for (const purpose of ["login"] as const) {
      const authentication = await authenticatePasskey(app, purpose);
      for (const endpoint of ["/auth/pin/recover/device", "/auth/password/recover/device"]) {
        const response = await app.inject({
          method: "POST",
          url: endpoint,
          headers: { cookie: authentication.cookie },
          payload: {
            pin: "1357",
            password: "secure new password",
            passwordConfirmation: "secure new password"
          }
        });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({ code: "device_credential_recovery_required" });
      }
    }
    const unsupported = await app.inject({
      method: "POST",
      url: "/auth/passkeys/login/options",
      headers: { origin },
      payload: { purpose: "pin_recovery" }
    });
    expect(unsupported.statusCode).toBe(400);
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

function responseCookies(response: { cookies: Array<{ name: string; value: string }> }): string {
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function createSessionCookie(app: ReturnType<typeof buildApi>): Promise<string> {
  const verified = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    payload: { method: "phone", contact: "+254711123456", pin: "2468" }
  });
  expect(verified.statusCode).toBe(200);
  return responseCookies(verified);
}
