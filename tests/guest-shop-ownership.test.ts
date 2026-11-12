import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

const phone = "+254700123456";
const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const cookies = (header: string | string[] | number | undefined) =>
  (Array.isArray(header) ? header : [String(header)]).map((v) => v.split(";")[0]).join("; ");

async function fixture() {
  const store = createCp2Store();
  const app = buildApi({ cp2: { store } });
  const continued = await app.inject({
    method: "POST",
    url: "/auth/continue",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "guest-shop-ownership-key-000000000000001"
    },
    payload: JSON.stringify({ devicePublicKeyJwk: key.publicKey.export({ format: "jwk" }) })
  });
  const body = continued.json<{
    account: { id: string };
    session: { id: string };
    deviceRecoveryCredentialId: string;
  }>();
  const cookie = cookies(continued.headers["set-cookie"]);
  const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { cookie, "content-type": "application/json" },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) })
    });
  const register = () =>
    call("POST", "/businesses", {
      name: "Guest Shop",
      language: "en",
      phoneNumber: "+254 700 123 456",
      phoneCountry: "KE"
    });
  return { store, app, call, register, ...body };
}

describe("a guest becomes a shop owner", () => {
  it("registers a shop on the guest's own account and manages it", async () => {
    const { app, call, register, account } = await fixture();
    const created = await register();
    expect(created.statusCode, created.body).toBe(200);
    const { business } = created.json<{ business: { id: string } }>();
    const product = await call("POST", `/businesses/${business.id}/products`, {
      name: "Mangoes",
      unit: "kg",
      quantity: 5,
      buyingPrice: 50,
      sellingPrice: 90
    });
    expect(product.statusCode, product.body).toBe(200);
    expect((await call("GET", `/businesses/${business.id}/products`)).statusCode).toBe(200);
    const session = (await call("GET", "/auth/session")).json<{ account: { id: string } }>();
    expect(session.account.id).toBe(account.id);
    await app.close();
  });

  it("does not ask a guest with an old session to prove a credential they do not have", async () => {
    const { store, app, session, register } = await fixture();
    const snapshot = store.snapshot();
    snapshot.sessions.find((item) => item.id === session.id)!.authenticatedAt = new Date(
      0
    ).toISOString();
    store.hydrateSnapshot(snapshot);
    expect((await register()).statusCode).toBe(200);
    await app.close();
  });

  it("respects a Store setup permission the user turned off, for the agent only", async () => {
    const { store, app, call, session } = await fixture();
    const conversationId = store.getGrogoniSessionContext({
      sessionId: session.id
    }).conversationId;
    store.updateAssistantPermissions(session.id, conversationId, { store: false });
    const shop = {
      name: "Guest Shop",
      language: "en",
      phoneNumber: "+254 700 123 456",
      phoneCountry: "KE"
    };
    const viaAgent = await call("POST", "/businesses", { ...shop, viaAssistant: true });
    expect(viaAgent.statusCode).toBe(403);
    expect((await call("POST", "/businesses", shop)).statusCode).toBe(200);
    await app.close();
  });

  it("lets a guest with a PIN but no phone add a phone from an old session", async () => {
    const { store, app, call, session, register } = await fixture();
    await call("POST", "/auth/pin/setup", { pin: "4826" });
    const proven = new Date(Date.now() - 20 * 60_000).toISOString();
    const snapshot = store.snapshot();
    Object.assign(
      snapshot.sessions.find((item) => item.id === session.id)!,
      {
        authenticatedAt: proven,
        pinVerifiedAt: proven
      }
    );
    store.hydrateSnapshot(snapshot);
    expect((await register()).statusCode).toBe(200);
    await app.close();
  });

  it("keeps the 15 minute rule for accounts that have a credential", async () => {
    const store = createCp2Store();
    const signed = store.signupWithPhonePin({ destination: "+254712000009", pin: "1234" });
    const proven = new Date(Date.now() - 20 * 60_000).toISOString();
    const snapshot = store.snapshot();
    Object.assign(
      snapshot.sessions.find((item) => item.id === signed.session.id)!,
      {
        authenticatedAt: proven,
        pinVerifiedAt: proven
      }
    );
    store.hydrateSnapshot(snapshot);
    expect(() =>
      store.updateOwnerPhone({
        sessionId: signed.session.id,
        phoneNumber: "+254 700 123 456",
        country: "KE"
      })
    ).toThrowError(expect.objectContaining({ code: "recent_authentication_required" }));
  });
});

describe("a guest owner secures their shop", () => {
  it("becomes a phone account when they add a PIN, and can log back in", async () => {
    const { store, app, call, register, session, account } = await fixture();
    const { business } = (await register()).json<{ business: { id: string } }>();
    const proven = new Date(Date.now() - 20 * 60_000).toISOString();
    const snapshot = store.snapshot();
    snapshot.sessions.find((item) => item.id === session.id)!.authenticatedAt = proven;
    store.hydrateSnapshot(snapshot);
    const secured = await call("POST", "/auth/pin/setup", { pin: "4826", pinConfirmation: "4826" });
    expect(secured.statusCode, secured.body).toBe(200);
    expect(store.snapshot().accounts[0]).toMatchObject({
      id: account.id,
      primaryAuthChannel: "phone",
      primaryAuthDestination: phone,
      identityLevel: "strong"
    });
    const login = await app.inject({
      method: "POST",
      url: "/auth/pin/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ method: "phone", contact: phone, pin: "4826" })
    });
    expect(login.statusCode, login.body).toBe(200);
    expect(login.json<{ account: { id: string } }>().account.id).toBe(account.id);
    expect(
      store.snapshot().memberships.filter((item) => item.businessId === business.id)
    ).toHaveLength(1);
    await app.close();
  });

  it("stays a guest with no phone, so nothing claims a sign-in it does not have", async () => {
    const { store, app, call, account } = await fixture();
    await call("POST", "/auth/pin/setup", { pin: "4826", pinConfirmation: "4826" });
    expect(store.snapshot().accounts[0]).toMatchObject({
      id: account.id,
      primaryAuthChannel: "device"
    });
    await app.close();
  });
});

describe("PIN signup on the guest's own saved phone", () => {
  it.each(["/auth/pin/signup", "/auth/pin/continue"])("%s keeps the account", async (url) => {
    const { store, app, call, account, register } = await fixture();
    await register();
    const done = await call("POST", url, { method: "phone", contact: phone, pin: "4826" });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json<{ account: { id: string } }>().account.id).toBe(account.id);
    expect(store.snapshot().accounts).toHaveLength(1);
    await app.close();
  });
});

describe("a phone another account signs in with", () => {
  it("stops a guest becoming a phone account on it, and they can still add a PIN", async () => {
    const { store, app, call, account } = await fixture();
    const holder = store.signupWithPhonePin({ destination: phone, pin: "1234" });
    const snapshot = store.snapshot();
    snapshot.users.find((user) => user.id === holder.user.id)!.phoneNumberE164 = "+254700123457";
    Object.assign(
      snapshot.users.find((user) => user.accountId === account.id)!,
      {
        phoneNumberE164: phone
      }
    );
    store.hydrateSnapshot(snapshot);
    const secured = await call("POST", "/auth/pin/setup", { pin: "4826", pinConfirmation: "4826" });
    expect(secured.statusCode, secured.body).toBe(200);
    expect(store.snapshot().accounts.find((item) => item.id === account.id)).toMatchObject({
      primaryAuthChannel: "device"
    });
    await app.close();
  });

  it("refuses the number with a clear error", async () => {
    const { store, app, register } = await fixture();
    store.signupWithPhonePin({ destination: phone, pin: "1234" });
    const created = await register();
    expect(created.statusCode).toBe(409);
    expect(created.json<{ code: string }>().code).toBe("PHONE_ALREADY_IN_USE");
    await app.close();
  });
});

describe("a stolen guest session", () => {
  it("cannot sign up over a credential the guest already has", async () => {
    const { store, app, call, account } = await fixture();
    await call("POST", "/auth/pin/setup", { pin: "4826", pinConfirmation: "4826" });
    const done = await call("POST", "/auth/pin/signup", {
      method: "phone",
      contact: phone,
      pin: "1111"
    });
    expect(done.json<{ account: { id: string } }>().account.id).not.toBe(account.id);
    expect(store.snapshot().accounts.find((item) => item.id === account.id)).toMatchObject({
      primaryAuthChannel: "device"
    });
    await app.close();
  });

  it("cannot remove device keys after 15 minutes", async () => {
    const { store, app, session, deviceRecoveryCredentialId: credentialId } = await fixture();
    const snapshot = store.snapshot();
    snapshot.sessions.find((item) => item.id === session.id)!.authenticatedAt = new Date(
      Date.now() - 20 * 60_000
    ).toISOString();
    store.hydrateSnapshot(snapshot);
    expect(() =>
      store.revokeDeviceRecoveryCredential({ sessionId: session.id, credentialId })
    ).toThrowError(expect.objectContaining({ code: "recent_authentication_required" }));
    await app.close();
  });
});

describe("PIN signup from a guest session", () => {
  it.each(["/auth/pin/signup", "/auth/pin/continue"])("%s keeps the account", async (url) => {
    const { store, app, call, account } = await fixture();
    const done = await call("POST", url, { method: "phone", contact: phone, pin: "4826" });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json<{ account: { id: string } }>().account.id).toBe(account.id);
    expect(store.snapshot().accounts).toHaveLength(1);
    await app.close();
  });
});

describe("signing up from a guest session", () => {
  async function signup(call: Awaited<ReturnType<typeof fixture>>["call"], identifier = phone) {
    const started = await call("POST", "/auth/signup/start", {
      type: "phone",
      identifier,
      country: "KE"
    });
    expect(started.statusCode, started.body).toBe(200);
    return call("POST", "/auth/signup/complete", {
      transactionId: started.json<{ transactionId: string }>().transactionId,
      displayName: "Jane",
      password: "secure first password",
      passwordConfirmation: "secure first password",
      termsAccepted: true,
      privacyAccepted: true
    });
  }

  it("upgrades the same account, so its shop survives", async () => {
    const { store, app, call, register, account } = await fixture();
    const { business } = (await register()).json<{ business: { id: string } }>();
    const done = await signup(call);
    expect(done.statusCode, done.body).toBe(200);
    const upgraded = done.json<{
      account: { id: string; primaryAuthChannel: string; identityLevel: string };
    }>().account;
    expect(upgraded).toMatchObject({
      id: account.id,
      primaryAuthChannel: "phone",
      primaryAuthDestination: phone,
      identityLevel: "strong"
    });
    expect(store.snapshot().accounts).toHaveLength(1);
    expect(
      store.snapshot().memberships.filter((item) => item.businessId === business.id)
    ).toHaveLength(1);

    const login = await app.inject({
      method: "POST",
      url: "/auth/login/password",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        type: "phone",
        identifier: phone,
        password: "secure first password"
      })
    });
    expect(login.statusCode, login.body).toBe(200);
    expect(login.json<{ account: { id: string } }>().account.id).toBe(account.id);
    await app.close();
  });

  it("stops the browser key restoring the upgraded account", async () => {
    const { app, call, deviceRecoveryCredentialId: credentialId } = await fixture();
    await signup(call);
    const issuedAt = Date.now();
    const nonce = "guest-shop-ownership-nonce-000000000001";
    const signature = sign(
      "sha256",
      Buffer.from(`grogoni-device-recovery:v1:${credentialId}:${issuedAt}:${nonce}`),
      { key: key.privateKey, dsaEncoding: "ieee-p1363" }
    ).toString("base64url");
    const restored = await app.inject({
      method: "POST",
      url: "/auth/device/recover",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ credentialId, nonce, issuedAt, signature })
    });
    expect(restored.statusCode).toBe(401);
    await app.close();
  });

  it("frees a saved phone when the guest signs up with a different one", async () => {
    const { store, app, call, register } = await fixture();
    await register();
    await signup(call, "+254700123457");
    const started = await app.inject({
      method: "POST",
      url: "/auth/signup/start",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ type: "phone", identifier: phone, country: "KE" })
    });
    expect(started.statusCode, started.body).toBe(200);
    expect(store.snapshot().accounts).toHaveLength(1);
    await app.close();
  });

  it("revokes the old guest session once upgraded", async () => {
    const { app, call } = await fixture();
    await signup(call);
    expect((await call("GET", "/auth/session")).statusCode).toBe(401);
    await app.close();
  });

  it("still refuses a phone that belongs to someone else", async () => {
    const { store, app, call } = await fixture();
    store.signupWithPhonePin({ destination: phone, pin: "1234" });
    const started = await call("POST", "/auth/signup/start", {
      type: "phone",
      identifier: phone,
      country: "KE"
    });
    expect(started.statusCode).toBe(409);
    await app.close();
  });
});
