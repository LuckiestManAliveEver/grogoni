import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

describe("phone-first authentication", () => {
  it.each([
    "712345678",
    "0712345678",
    "254712345678",
    "+254712345678",
    "00254712345678",
    "+254 712 345 678",
    "254254712345678",
    "+254+254712345678"
  ])("normalizes %s before creating a signup transaction", async (identifier) => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const response = await post(app, "/auth/signup/start", {
      type: "phone",
      identifier,
      country: "KE"
    });
    expect(response.statusCode).toBe(200);
    expect(store.snapshot().authTransactions?.at(-1)).toMatchObject({
      identifierType: "phone",
      identifierValue: "+254712345678"
    });
    await app.close();
  });

  it("rejects malformed phone input with INVALID_PHONE_NUMBER", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const response = await post(app, "/auth/signup/start", {
      type: "phone",
      identifier: "+254abc123",
      country: "KE"
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "INVALID_PHONE_NUMBER",
      message: "Enter a valid phone number."
    });
    await app.close();
  });

  it("accepts a foreign international paste without prepending the selected country", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const response = await post(app, "/auth/signup/start", {
      type: "phone",
      identifier: "+256772123456",
      country: "KE"
    });
    expect(response.statusCode).toBe(200);
    expect(store.snapshot().authTransactions?.at(-1)).toMatchObject({
      identifierType: "phone",
      identifierValue: "+256772123456"
    });
    await app.close();
  });

  it("uses one canonical identity for PIN signup and duplicate-prefix login", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const signup = await post(app, "/auth/pin/signup", {
      method: "phone",
      contact: "0712345678",
      country: "KE",
      pin: "1234"
    });
    expect(signup.statusCode).toBe(200);
    expect(signup.json()).toMatchObject({
      account: { primaryAuthDestination: "+254712345678" }
    });
    const login = await post(app, "/auth/pin/login", {
      method: "phone",
      contact: "+254254712345678",
      country: "KE",
      pin: "1234"
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({
      account: { primaryAuthDestination: "+254712345678" }
    });
    await app.close();
  });

  it("throttles repeated PIN signups from one IP", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });

    for (let index = 0; index < 10; index += 1) {
      const response = await post(app, "/auth/pin/signup", {
        method: "phone",
        contact: `07123458${String(index).padStart(2, "0")}`,
        country: "KE",
        pin: "1234"
      });
      expect(response.statusCode).toBe(200);
    }

    const throttled = await post(app, "/auth/pin/signup", {
      method: "phone",
      contact: "0712345899",
      country: "KE",
      pin: "1234"
    });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json()).toMatchObject({ code: "auth_rate_limited" });
    await app.close();
  });

  it("does not let a suspended account create a new session with its PIN", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const signup = await post(app, "/auth/pin/signup", {
      method: "phone",
      contact: "0712345898",
      country: "KE",
      pin: "1234"
    });
    expect(signup.statusCode).toBe(200);

    const snapshot = store.snapshot();
    snapshot.accounts[0]!.status = "suspended";
    store.hydrateSnapshot(snapshot);

    const login = await post(app, "/auth/pin/login", {
      method: "phone",
      contact: "0712345898",
      country: "KE",
      pin: "1234"
    });
    expect(login.statusCode).toBe(403);
    expect(login.json()).toMatchObject({ code: "account_suspended" });
    await app.close();
  });

  it("creates a password account with a normalized, unverified phone identifier", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const start = await post(app, "/auth/signup/start", {
      type: "phone",
      identifier: "0712 345 678",
      country: "KE"
    });
    expect(start.statusCode).toBe(200);
    const transaction = start.json<{ transactionId: string; verificationRequired: boolean }>();
    expect(transaction.verificationRequired).toBe(false);
    const signup = await post(app, "/auth/signup/complete", {
      transactionId: transaction.transactionId,
      displayName: "Jane",
      email: "Jane@Example.com",
      password: "a long password with spaces",
      passwordConfirmation: "a long password with spaces",
      termsAccepted: true,
      privacyAccepted: true
    });
    expect(signup.statusCode).toBe(200);
    expect(signup.json()).toMatchObject({
      account: { primaryAuthDestination: "+254712345678" },
      user: { displayName: "Jane", phoneVerificationStatus: "unverified" }
    });
    expect(store.snapshot().passwordCredentials?.[0]?.passwordHash).not.toContain(
      "a long password"
    );
    expect(store.snapshot().accountIdentities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "phone",
          normalizedValue: "+254712345678",
          verifiedAt: null
        }),
        expect.objectContaining({
          type: "email",
          normalizedValue: "jane@example.com",
          verifiedAt: null
        })
      ])
    );

    const replay = await post(app, "/auth/signup/complete", {
      transactionId: transaction.transactionId,
      displayName: "Jane",
      password: "another long password",
      passwordConfirmation: "another long password",
      termsAccepted: true,
      privacyAccepted: true
    });
    expect(replay.statusCode).toBe(400);
    expect(store.snapshot().accounts).toHaveLength(1);
    await app.close();
  });

  it("logs in with a password, gives generic failures, and recovers with a single-use challenge", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const credentials = { type: "phone", identifier: "+254712345679" };
    const started = await post(app, "/auth/signup/start", credentials);
    const signupChallenge = started.json<{ transactionId: string }>();
    const signup = await post(app, "/auth/signup/complete", {
      transactionId: signupChallenge.transactionId,
      displayName: "Owner",
      email: "owner-recovery@example.com",
      password: "correct horse battery staple",
      passwordConfirmation: "correct horse battery staple",
      termsAccepted: true,
      privacyAccepted: true
    });
    const signupCookie = cookies(signup.headers["set-cookie"]);
    const emailChallenge = await app.inject({
      method: "POST",
      url: "/auth/email/verification/start",
      headers: { cookie: signupCookie }
    });
    const emailChallengeData = emailChallenge.json<{
      challengeId: string;
      developmentCode: string;
    }>();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/auth/email/verification/verify",
          headers: { cookie: signupCookie, "content-type": "application/json" },
          payload: {
            challengeId: emailChallengeData.challengeId,
            code: emailChallengeData.developmentCode
          }
        })
      ).statusCode
    ).toBe(200);
    await app.inject({
      method: "POST",
      url: "/logout",
      headers: { cookie: signupCookie }
    });

    for (const identifier of [credentials.identifier, "+254700000000"]) {
      const failed = await post(app, "/auth/login/password", {
        type: "phone",
        identifier,
        password: "wrong password"
      });
      expect(failed.statusCode).toBe(401);
      expect(failed.json()).toMatchObject({
        code: "auth_credentials_invalid",
        message: "The account credentials are invalid."
      });
    }
    const login = await post(app, "/auth/login/password", {
      ...credentials,
      identifier: "+254254712345679",
      country: "KE",
      password: "correct horse battery staple"
    });
    expect(login.statusCode).toBe(202);
    expect(login.headers["set-cookie"]).toBeUndefined();
    const transactionId = login.json<{ transactionId: string }>().transactionId;
    const emailMfa = await post(app, "/auth/mfa/email/challenge", { transactionId });
    expect(emailMfa.statusCode).toBe(200);
    const wrongMfa = await post(app, "/auth/mfa/verify", {
      transactionId,
      factor: "email",
      code: "wrong"
    });
    expect(wrongMfa.statusCode).toBe(401);
    const mfaPayload = {
      transactionId,
      factor: "email",
      code: emailMfa.json<{ developmentCode: string }>().developmentCode
    };
    const verifiedLogin = await post(app, "/auth/mfa/verify", mfaPayload);
    expect(verifiedLogin.statusCode).toBe(200);
    expect(cookies(verifiedLogin.headers["set-cookie"])).toContain("grogoni_refresh=");
    expect((await post(app, "/auth/mfa/verify", mfaPayload)).statusCode).toBe(400);

    const phoneRecovery = await post(app, "/auth/recovery/start", {
      ...credentials,
      identifier: "254254712345679",
      country: "KE"
    });
    expect(phoneRecovery.statusCode).toBe(400);
    expect(phoneRecovery.json()).toMatchObject({ code: "phone_recovery_unavailable" });

    vi.stubEnv("OTP_COOLDOWN_SECONDS", "0");
    const recovery = await post(app, "/auth/recovery/start", {
      type: "email",
      identifier: "owner-recovery@example.com"
    });
    vi.unstubAllEnvs();
    expect(recovery.json()).toMatchObject({
      message: "If an account matches those details, recovery instructions have been sent."
    });
    const recoveryData = recovery.json<{ transactionId: string; developmentCode: string }>();
    expect(
      (
        await post(app, "/auth/recovery/verify", {
          transactionId: recoveryData.transactionId,
          code: recoveryData.developmentCode
        })
      ).statusCode
    ).toBe(200);
    const reset = await post(app, "/auth/recovery/reset-password", {
      transactionId: recoveryData.transactionId,
      password: "replacement password",
      passwordConfirmation: "replacement password"
    });
    expect(reset.statusCode).toBe(200);
    expect(
      (
        await post(app, "/auth/recovery/reset-password", {
          transactionId: recoveryData.transactionId,
          password: "another replacement",
          passwordConfirmation: "another replacement"
        })
      ).statusCode
    ).toBe(400);

    const resetCookie = cookies(reset.headers["set-cookie"]);
    const changed = await app.inject({
      method: "POST",
      url: "/auth/password/change",
      headers: { cookie: resetCookie, "content-type": "application/json" },
      payload: {
        currentPassword: "replacement password",
        password: "user initiated password change",
        passwordConfirmation: "user initiated password change",
        revokeOtherSessions: true
      }
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ changed: true });
    expect(
      (
        await post(app, "/auth/login/password", {
          ...credentials,
          password: "replacement password"
        })
      ).statusCode
    ).toBe(401);
    expect(
      (
        await post(app, "/auth/login/password", {
          ...credentials,
          password: "user initiated password change"
        })
      ).statusCode
    ).toBe(202);
    await app.close();
  });

  it("does not create a full session until MFA succeeds and consumes recovery codes once", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const started = await post(app, "/auth/signup/start", {
      type: "phone",
      identifier: "+254712345680"
    });
    const challenge = started.json<{ transactionId: string }>();
    const signup = await post(app, "/auth/signup/complete", {
      transactionId: challenge.transactionId,
      displayName: "MFA Owner",
      password: "password for mfa owner",
      passwordConfirmation: "password for mfa owner",
      termsAccepted: true,
      privacyAccepted: true
    });
    const cookie = cookies(signup.headers["set-cookie"]);
    const setup = await app.inject({
      method: "POST",
      url: "/auth/mfa/totp/setup",
      headers: { cookie }
    });
    const setupData = setup.json<{ factorId: string; secret: string }>();
    const confirmed = await app.inject({
      method: "POST",
      url: "/auth/mfa/totp/confirm",
      headers: { cookie, "content-type": "application/json" },
      payload: { factorId: setupData.factorId, code: totp(setupData.secret) }
    });
    expect(confirmed.statusCode).toBe(200);
    const recoveryCode = confirmed.json<{ recoveryCodes: string[] }>().recoveryCodes[0]!;
    await app.inject({ method: "POST", url: "/logout-all", headers: { cookie } });

    const password = await post(app, "/auth/login/password", {
      type: "phone",
      identifier: "+254712345680",
      password: "password for mfa owner"
    });
    expect(password.statusCode).toBe(202);
    expect(password.headers["set-cookie"]).toBeUndefined();
    const transactionId = password.json<{ transactionId: string }>().transactionId;
    const mfa = await post(app, "/auth/mfa/verify", {
      transactionId,
      factor: "recovery_code",
      code: recoveryCode
    });
    expect(mfa.statusCode).toBe(200);
    expect(cookies(mfa.headers["set-cookie"])).toContain("grogoni_session=");

    const nextLogin = await post(app, "/auth/login/password", {
      type: "phone",
      identifier: "+254712345680",
      password: "password for mfa owner"
    });
    const replay = await post(app, "/auth/mfa/verify", {
      transactionId: nextLogin.json<{ transactionId: string }>().transactionId,
      factor: "recovery_code",
      code: recoveryCode
    });
    expect(replay.statusCode).toBe(401);
    await app.close();
  });

  it("ships a reversible normalized authentication migration", () => {
    const migration = readFileSync(
      "infra/db/migrations/042_phone_first_authentication.sql",
      "utf8"
    );
    const rollback = readFileSync(
      "infra/db/rollbacks/042_phone_first_authentication.down.sql",
      "utf8"
    );
    expect(migration).toContain("create table if not exists account_identities");
    expect(migration).toContain("create table if not exists password_credentials");
    expect(migration).toContain("create table if not exists mfa_factors");
    expect(rollback).toContain("drop table if exists account_identities");
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

function totp(secret: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];
  for (const character of secret) {
    buffer = (buffer << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}
