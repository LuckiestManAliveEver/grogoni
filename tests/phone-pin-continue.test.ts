import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

describe("unified phone + PIN continue flow", () => {
  it("creates a new account on first use with a non-colliding default display name", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const response = await post(app, "/auth/pin/continue", {
      contact: "0712345690",
      country: "KE",
      pin: "1234"
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      isNewAccount: true,
      account: { primaryAuthDestination: "+254712345690" },
      user: { displayName: "Trader 5690" }
    });
    expect(cookies(response.headers["set-cookie"])).toContain("grogoni_refresh=");
    await app.close();
  });

  it("logs in a returning account with the correct PIN", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    await post(app, "/auth/pin/continue", { contact: "0712345691", country: "KE", pin: "4321" });
    const response = await post(app, "/auth/pin/continue", {
      contact: "0712345691",
      country: "KE",
      pin: "4321"
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      isNewAccount: false,
      account: { primaryAuthDestination: "+254712345691" }
    });
    expect(response.cookies.map((cookie) => cookie.name)).toEqual(
      expect.arrayContaining(["grogoni_session", "grogoni_refresh"])
    );
    const refreshed = await app.inject({
      method: "POST",
      url: "/auth/session/refresh",
      headers: {
        cookie: response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
      }
    });
    expect(refreshed.statusCode).toBe(200);
    await app.close();
  });

  it("rejects a wrong PIN and locks the destination out after repeated failures", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    await post(app, "/auth/pin/continue", { contact: "0712345692", country: "KE", pin: "1111" });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await post(app, "/auth/pin/continue", {
        contact: "0712345692",
        country: "KE",
        pin: "9999"
      });
      expect(failed.statusCode).toBe(401);
      expect(failed.json()).toMatchObject({ code: "auth_credentials_invalid" });
    }

    const lockedOut = await post(app, "/auth/pin/continue", {
      contact: "0712345692",
      country: "KE",
      pin: "1111"
    });
    expect(lockedOut.statusCode).toBe(429);
    expect(lockedOut.json()).toMatchObject({ code: "pin_rate_limited" });
    await app.close();
  });

  it("tells an existing passkey/password account to use its own credential instead of creating a PIN", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const start = await post(app, "/auth/signup/start", {
      type: "phone",
      identifier: "0712345693",
      country: "KE"
    });
    const { transactionId } = start.json<{ transactionId: string }>();
    await post(app, "/auth/signup/complete", {
      transactionId,
      displayName: "Password Owner",
      password: "a reasonably long password",
      passwordConfirmation: "a reasonably long password",
      termsAccepted: true,
      privacyAccepted: true
    });

    const attempt = await post(app, "/auth/pin/continue", {
      contact: "0712345693",
      country: "KE",
      pin: "1234"
    });
    expect(attempt.statusCode).toBe(401);
    expect(attempt.json()).toMatchObject({ code: "pin_not_configured" });
    await app.close();
  });

  it("throttles /auth/pin/continue per IP once too many account creations are attempted", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    for (let index = 0; index < 10; index += 1) {
      const response = await post(app, "/auth/pin/continue", {
        contact: `07123457${String(index).padStart(2, "0")}`,
        country: "KE",
        pin: "1234"
      });
      expect(response.statusCode).toBe(200);
    }
    const throttled = await post(app, "/auth/pin/continue", {
      contact: "0712345799",
      country: "KE",
      pin: "1234"
    });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json()).toMatchObject({ code: "auth_rate_limited" });
    await app.close();
  });
});

describe("unified email + PIN continue flow", () => {
  it("creates a new account by email on first use", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const response = await post(app, "/auth/pin/continue", {
      method: "email",
      contact: "New.Trader@Example.com",
      pin: "1234"
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      isNewAccount: true,
      account: { primaryAuthChannel: "email", primaryAuthDestination: "new.trader@example.com" },
      user: { displayName: "new.trader" }
    });
    expect(cookies(response.headers["set-cookie"])).toContain("grogoni_refresh=");
    await app.close();
  });

  it("directs a repeat signup attempt to log in instead of creating a duplicate account", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const first = await post(app, "/auth/pin/continue", {
      method: "email",
      contact: "owner@example.com",
      pin: "5678"
    });
    const firstAccountId = first.json<{ account: { id: string } }>().account.id;

    const second = await post(app, "/auth/pin/continue", {
      method: "email",
      contact: "Owner@Example.com",
      pin: "5678"
    });
    expect(second.statusCode).toBe(200);
    const body = second.json<{ isNewAccount: boolean; account: { id: string } }>();
    expect(body.isNewAccount).toBe(false);
    expect(body.account.id).toBe(firstAccountId);
    await app.close();
  });

  it("rejects an email account signup attempt when one already exists with the wrong PIN", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    await post(app, "/auth/pin/continue", {
      method: "email",
      contact: "owner2@example.com",
      pin: "1111"
    });
    const wrongPin = await post(app, "/auth/pin/continue", {
      method: "email",
      contact: "owner2@example.com",
      pin: "2222"
    });
    expect(wrongPin.statusCode).toBe(401);
    expect(wrongPin.json()).toMatchObject({ code: "auth_credentials_invalid" });
    await app.close();
  });
});

describe("store ID + PIN login", () => {
  it("logs the owner in using their store's Grogoni ID and PIN", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const signup = await post(app, "/auth/pin/continue", {
      contact: "0712345700",
      country: "KE",
      pin: "9012"
    });
    const ownerCookie = cookies(signup.headers["set-cookie"]);
    const ownerAccountId = signup.json<{ account: { id: string } }>().account.id;

    const business = await app.inject({
      method: "POST",
      url: "/businesses",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: { name: "Grogoni ID Login Shop", language: "en" }
    });
    const { grogoniId } = business.json<{ business: { grogoniId: string } }>().business;

    const storeLogin = await post(app, "/auth/pin/store-login", { grogoniId, pin: "9012" });
    expect(storeLogin.statusCode).toBe(200);
    expect(storeLogin.json()).toMatchObject({ account: { id: ownerAccountId } });
    expect(cookies(storeLogin.headers["set-cookie"])).toContain("grogoni_refresh=");

    const storeLoginLowercase = await post(app, "/auth/pin/store-login", {
      grogoniId: grogoniId.toLowerCase(),
      pin: "9012"
    });
    expect(storeLoginLowercase.statusCode).toBe(200);
    expect(storeLoginLowercase.json()).toMatchObject({ account: { id: ownerAccountId } });
    await app.close();
  });

  it("rejects an unknown store ID and a wrong PIN with the same generic error", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const unknown = await post(app, "/auth/pin/store-login", {
      grogoniId: "grogoni.unknown-store",
      pin: "9012"
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toMatchObject({ code: "auth_credentials_invalid" });

    const signup = await post(app, "/auth/pin/continue", {
      contact: "0712345701",
      country: "KE",
      pin: "3456"
    });
    const ownerCookie = cookies(signup.headers["set-cookie"]);
    const business = await app.inject({
      method: "POST",
      url: "/businesses",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: { name: "Wrong PIN Shop", language: "en" }
    });
    const { grogoniId } = business.json<{ business: { grogoniId: string } }>().business;

    const wrongPin = await post(app, "/auth/pin/store-login", { grogoniId, pin: "0000" });
    expect(wrongPin.statusCode).toBe(401);
    expect(wrongPin.json()).toMatchObject({ code: "auth_credentials_invalid" });
    await app.close();
  });

  it("tells a store owner without a PIN to use their account credential instead", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const start = await post(app, "/auth/signup/start", {
      type: "phone",
      identifier: "0712345702",
      country: "KE"
    });
    const { transactionId } = start.json<{ transactionId: string }>();
    const signup = await post(app, "/auth/signup/complete", {
      transactionId,
      displayName: "Password Owner",
      password: "a reasonably long password",
      passwordConfirmation: "a reasonably long password",
      termsAccepted: true,
      privacyAccepted: true
    });
    const ownerCookie = cookies(signup.headers["set-cookie"]);
    const business = await app.inject({
      method: "POST",
      url: "/businesses",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: { name: "No PIN Shop", language: "en" }
    });
    const { grogoniId } = business.json<{ business: { grogoniId: string } }>().business;

    const attempt = await post(app, "/auth/pin/store-login", { grogoniId, pin: "1234" });
    expect(attempt.statusCode).toBe(401);
    expect(attempt.json()).toMatchObject({ code: "pin_not_configured" });
    await app.close();
  });
});

describe("display name updates", () => {
  it("lets an authenticated user set their display name", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const signup = await post(app, "/auth/pin/continue", {
      contact: "0712345694",
      country: "KE",
      pin: "1234"
    });
    const cookie = cookies(signup.headers["set-cookie"]);

    const updated = await app.inject({
      method: "PUT",
      url: "/account/display-name",
      headers: { cookie, "content-type": "application/json" },
      payload: { displayName: "Jane Trader" }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ user: { displayName: "Jane Trader" } });
    await app.close();
  });

  it("rejects names that are too short or too long", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const signup = await post(app, "/auth/pin/continue", {
      contact: "0712345695",
      country: "KE",
      pin: "1234"
    });
    const cookie = cookies(signup.headers["set-cookie"]);

    const tooShort = await app.inject({
      method: "PUT",
      url: "/account/display-name",
      headers: { cookie, "content-type": "application/json" },
      payload: { displayName: "J" }
    });
    expect(tooShort.statusCode).toBe(400);
    expect(tooShort.json()).toMatchObject({ code: "display_name_invalid" });

    const tooLong = await app.inject({
      method: "PUT",
      url: "/account/display-name",
      headers: { cookie, "content-type": "application/json" },
      payload: { displayName: "x".repeat(101) }
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json()).toMatchObject({ code: "display_name_invalid" });
    await app.close();
  });

  it("requires a valid session", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const response = await app.inject({
      method: "PUT",
      url: "/account/display-name",
      headers: { "content-type": "application/json" },
      payload: { displayName: "No Session" }
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "auth_required" });
    await app.close();
  });
});

function post(app: ReturnType<typeof buildApi>, url: string, payload: unknown) {
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json" },
    payload
  });
}

function cookies(value: string | string[] | undefined): string {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values.map((item) => item.split(";", 1)[0]).join("; ");
}
