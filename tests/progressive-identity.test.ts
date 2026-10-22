import { signupWithBackupEmail } from "./fixtures/account-auth";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

const deviceHeaders = {
  "idempotency-key": "progressive-identity-request-key-000000000001",
  "x-grogoni-device-id": "test-device-progressive-identity",
  "x-grogoni-device-name": "Test device",
  "x-grogoni-platform": "test",
  "x-grogoni-client": "web"
};
const deviceKeyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const devicePublicKeyJwk = deviceKeyPair.publicKey.export({ format: "jwk" });
const continuePayload = { devicePublicKeyJwk };

describe("one-tap signup and progressive identity", () => {
  it("creates one real device account/session and restores it without a second account", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });

    const [first, duplicate] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/auth/continue",
        headers: deviceHeaders,
        payload: continuePayload
      }),
      app.inject({
        method: "POST",
        url: "/auth/continue",
        headers: deviceHeaders,
        payload: continuePayload
      })
    ]);

    expect(first.statusCode).toBe(200);
    expect(duplicate.statusCode).toBe(200);
    const firstSession = first.json<ContinueResponse>();
    const duplicateSession = duplicate.json<ContinueResponse>();
    expect(firstSession.account).toMatchObject({
      primaryAuthChannel: "device",
      identityLevel: "device"
    });
    expect(firstSession.account.id).toBe(duplicateSession.account.id);
    expect(firstSession.session.id).toBe(duplicateSession.session.id);
    expect(firstSession.user.phoneNumberE164).toBeNull();
    expect(store.snapshot().accounts).toHaveLength(1);
    expect(store.snapshot().users).toHaveLength(1);
    expect(store.snapshot().sessions).toHaveLength(1);
    expect(store.snapshot().accountPinHashes).toHaveLength(0);
    expect(store.snapshot().conversations).toHaveLength(1);

    const cookie = sessionCookie(first.headers["set-cookie"]);
    const bootstrap = await app.inject({
      method: "GET",
      url: "/auth/bootstrap",
      headers: { cookie }
    });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json<ContinueResponse>().account.id).toBe(firstSession.account.id);

    const continuedAgain = await app.inject({
      method: "POST",
      url: "/auth/continue",
      headers: { ...deviceHeaders, cookie, "idempotency-key": "unused-when-session-valid-00000001" }
    });
    expect(continuedAgain.statusCode).toBe(200);
    expect(continuedAgain.json<ContinueResponse>().account.id).toBe(firstSession.account.id);
    expect(store.snapshot().accounts).toHaveLength(1);
    expect(store.snapshot().sessions).toHaveLength(1);

    const context = await app.inject({
      method: "GET",
      url: "/v1/session/context",
      headers: { cookie, "x-account-id": "00000000-0000-0000-0000-000000000000" }
    });
    expect(context.statusCode).toBe(200);
    expect(context.json<{ accountId: string }>().accountId).toBe(firstSession.account.id);

    await app.close();
  });

  it("recovers the same device account after its session cookies are erased", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const continued = await continueToGrogoni(app, "progressive-device-recovery-0000000001");
    const initial = continued.response.json<ContinueResponse>();
    const credentialId = initial.deviceRecoveryCredentialId;
    expect(credentialId).toMatch(/^[0-9a-f-]{36}$/u);

    const issuedAt = Date.now();
    const nonce = "device-recovery-nonce-0000000000000001";
    const payload = `grogoni-device-recovery:v1:${credentialId}:${issuedAt}:${nonce}`;
    const signature = sign("sha256", Buffer.from(payload), {
      key: deviceKeyPair.privateKey,
      dsaEncoding: "ieee-p1363"
    }).toString("base64url");
    const recovered = await app.inject({
      method: "POST",
      url: "/auth/device/recover",
      headers: jsonHeaders(),
      payload: JSON.stringify({ credentialId, nonce, issuedAt, signature })
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json<ContinueResponse>().account.id).toBe(initial.account.id);
    expect(store.snapshot().accounts).toHaveLength(1);

    await app.close();
  });

  it("revokes device recovery credentials during logout-all", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const continued = await continueToGrogoni(app, "progressive-device-revoke-000000000001");
    const credentialId = continued.response.json<ContinueResponse>().deviceRecoveryCredentialId;
    const logout = await app.inject({
      method: "POST",
      url: "/auth/logout-all",
      headers: { cookie: continued.cookie }
    });
    expect(logout.statusCode).toBe(200);

    const issuedAt = Date.now();
    const nonce = "device-recovery-revoked-00000000000001";
    const payload = `grogoni-device-recovery:v1:${credentialId}:${issuedAt}:${nonce}`;
    const signature = sign("sha256", Buffer.from(payload), {
      key: deviceKeyPair.privateKey,
      dsaEncoding: "ieee-p1363"
    }).toString("base64url");
    const recovered = await app.inject({
      method: "POST",
      url: "/auth/device/recover",
      headers: jsonHeaders(),
      payload: JSON.stringify({ credentialId, nonce, issuedAt, signature })
    });
    expect(recovered.statusCode).toBe(401);

    await app.close();
  });

  it("upgrades phone and PIN on the same account and preserves existing PIN login", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const continued = await continueToGrogoni(app, "progressive-phone-pin-key-000000000001");
    const initial = continued.response.json<ContinueResponse>();

    const phone = await app.inject({
      method: "PUT",
      url: "/account/phone",
      headers: jsonHeaders(continued.cookie),
      payload: JSON.stringify({ phoneNumber: "+254 700 123 456", country: "KE" })
    });
    expect(phone.statusCode).toBe(200);
    expect(phone.json<{ user: { id: string } }>().user.id).toBe(initial.user.id);

    const pin = await app.inject({
      method: "POST",
      url: "/auth/pin/setup",
      headers: jsonHeaders(continued.cookie),
      payload: JSON.stringify({ pin: "4826" })
    });
    expect(pin.statusCode).toBe(200);
    expect(pin.json<ContinueResponse>().account).toMatchObject({
      id: initial.account.id,
      identityLevel: "strong"
    });

    await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: continued.cookie }
    });
    const login = await app.inject({
      method: "POST",
      url: "/auth/pin/login",
      headers: jsonHeaders(),
      payload: JSON.stringify({
        method: "phone",
        contact: "+254700123456",
        pin: "4826"
      })
    });
    expect(login.statusCode).toBe(200);
    expect(login.json<ContinueResponse>().account.id).toBe(initial.account.id);
    expect(store.snapshot().accounts).toHaveLength(1);

    await app.close();
  });

  it("links and verifies email on the existing device account", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const continued = await continueToGrogoni(app, "progressive-email-key-0000000000000001");
    const accountId = continued.response.json<ContinueResponse>().account.id;

    const start = await app.inject({
      method: "POST",
      url: "/auth/identity/email/start",
      headers: jsonHeaders(continued.cookie),
      payload: JSON.stringify({ email: "device.owner@example.com" })
    });
    expect(start.statusCode).toBe(200);
    const challenge = start.json<{ challengeId: string; developmentCode: string }>();
    const verify = await app.inject({
      method: "POST",
      url: "/auth/identity/email/verify",
      headers: jsonHeaders(continued.cookie),
      payload: JSON.stringify({
        challengeId: challenge.challengeId,
        code: challenge.developmentCode
      })
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toMatchObject({
      verified: true,
      accountId,
      identityLevel: "verified_contact"
    });
    expect(store.snapshot().accounts).toEqual([
      expect.objectContaining({ id: accountId, identityLevel: "verified_contact" })
    ]);

    await app.close();
  });

  it("joins a device account to an existing phone account after PIN proof", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const existing = await app.inject({
      method: "POST",
      url: "/auth/pin/continue",
      headers: jsonHeaders(),
      payload: JSON.stringify({ method: "phone", contact: "+254711222333", pin: "1357" })
    });
    expect(existing.statusCode).toBe(200);
    const existingAccountId = existing.json<ContinueResponse>().account.id;
    const device = await continueToGrogoni(app, "progressive-collision-key-000000000001");
    const deviceAccountId = device.response.json<ContinueResponse>().account.id;

    const collision = await app.inject({
      method: "PUT",
      url: "/account/phone",
      headers: jsonHeaders(device.cookie),
      payload: JSON.stringify({ phoneNumber: "0711222333", country: "KE" })
    });
    expect(collision.statusCode).toBe(409);
    expect(collision.json()).toMatchObject({ code: "PHONE_ALREADY_IN_USE" });

    const merged = await app.inject({
      method: "POST",
      url: "/auth/identity/merge/pin",
      headers: jsonHeaders(device.cookie),
      payload: JSON.stringify({ method: "phone", contact: "+254711222333", pin: "1357" })
    });
    expect(merged.statusCode).toBe(200);
    expect(merged.json<ContinueResponse>().account.id).toBe(existingAccountId);
    expect(store.snapshot().accounts).toEqual([expect.objectContaining({ id: existingAccountId })]);
    expect(store.snapshot().accounts.some((account) => account.id === deviceAccountId)).toBe(false);
    expect(store.snapshot().conversations).toHaveLength(2);
    expect(
      store
        .snapshot()
        .conversations.every((conversation) => conversation.accountId === existingAccountId)
    ).toBe(true);

    await app.close();
  });

  it("joins a device account to an existing email account after OTP proof", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const existing = await signupWithBackupEmail(app, "owner@example.com");
    const existingAccountId = existing.response.json<ContinueResponse>().account.id;
    const device = await continueToGrogoni(app, "progressive-email-merge-key-0000000001");

    const start = await app.inject({
      method: "POST",
      url: "/auth/identity/email/start",
      headers: jsonHeaders(device.cookie),
      payload: JSON.stringify({ email: "owner@example.com" })
    });
    expect(start.statusCode).toBe(200);
    const challenge = start.json<{
      challengeId: string;
      developmentCode: string;
      mergeRequired: boolean;
    }>();
    expect(challenge.mergeRequired).toBe(true);
    const merged = await app.inject({
      method: "POST",
      url: "/auth/identity/email/merge/verify",
      headers: jsonHeaders(device.cookie),
      payload: JSON.stringify({
        challengeId: challenge.challengeId,
        code: challenge.developmentCode
      })
    });
    expect(merged.statusCode).toBe(200);
    expect(merged.json<ContinueResponse>().account.id).toBe(existingAccountId);
    expect(store.snapshot().accounts).toEqual([expect.objectContaining({ id: existingAccountId })]);

    await app.close();
  });

  it("requires a secure retry key when no authenticated session exists", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const response = await app.inject({ method: "POST", url: "/auth/continue" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "auth_continue_idempotency_required" });
    await app.close();
  });
});

interface ContinueResponse {
  account: {
    id: string;
    primaryAuthChannel: string;
    identityLevel: string;
  };
  user: { id: string; phoneNumberE164: string | null };
  session: { id: string };
  deviceRecoveryCredentialId: string;
}

async function continueToGrogoni(app: ReturnType<typeof buildApi>, idempotencyKey: string) {
  const response = await app.inject({
    method: "POST",
    url: "/auth/continue",
    headers: { ...deviceHeaders, "idempotency-key": idempotencyKey },
    payload: continuePayload
  });
  expect(response.statusCode).toBe(200);
  return { response, cookie: sessionCookie(response.headers["set-cookie"]) };
}

function jsonHeaders(cookie?: string) {
  return {
    "content-type": "application/json",
    ...(cookie === undefined ? {} : { cookie })
  };
}

function sessionCookie(header: string | string[] | undefined): string {
  const values = Array.isArray(header) ? header : header === undefined ? [] : [header];
  const session = values.find((value) => value.startsWith("grogoni_session="));
  if (session === undefined) throw new Error("Expected Grogoni session cookie.");
  return session.split(";")[0] ?? session;
}
