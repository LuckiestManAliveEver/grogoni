import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../services/api/src/app";
import { encryptOAuthToken } from "../services/api/src/cp2/oauth";
import { Cp2Error, createCp2Store } from "../services/api/src/cp2/store";

describe("security hardening", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stores new PINs with salted scrypt hashes", () => {
    const store = createCp2Store();
    const signup = store.signupWithPhonePin({
      destination: "+254700000201",
      pin: "2468"
    });
    const pinHash = store.snapshot().accountPinHashes[0]?.pinHash;

    expect(pinHash).toMatch(/^scrypt\$v2\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/u);
    expect(pinHash).not.toContain(signup.account.id);
    expect(pinHash).not.toContain("2468");
  });

  it("upgrades legacy SHA-256 PIN hashes after successful authentication", () => {
    const phone = "+254700000202";
    const original = createCp2Store();
    const signup = original.signupWithPhonePin({ destination: phone, pin: "1357" });
    const snapshot = original.snapshot();
    const legacyHash = createHash("sha256").update(`${signup.account.id}:1357`).digest("hex");
    const record = snapshot.accountPinHashes.find(
      (candidate) => candidate.accountId === signup.account.id
    );
    if (record === undefined) throw new Error("PIN hash fixture was not created.");
    record.pinHash = legacyHash;

    const restored = createCp2Store();
    restored.hydrateSnapshot(snapshot);
    restored.loginWithAccountPin({
      channel: "phone",
      destination: phone,
      pin: "1357"
    });

    expect(restored.snapshot().accountPinHashes[0]?.pinHash).toMatch(/^scrypt\$v2\$/u);
    expect(restored.snapshot().accountPinHashes[0]?.pinHash).not.toBe(legacyHash);
  });

  it("does not reveal whether a PIN login account exists", () => {
    const store = createCp2Store();
    const phone = "+254700000203";
    store.signupWithPhonePin({ destination: phone, pin: "8642" });

    const capture = (destination: string) => {
      try {
        store.loginWithAccountPin({
          channel: "phone",
          destination,
          pin: "0000"
        });
        throw new Error("Expected authentication to fail.");
      } catch (error) {
        expect(error).toBeInstanceOf(Cp2Error);
        const authError = error as Cp2Error;
        return {
          statusCode: authError.statusCode,
          code: authError.code,
          message: authError.message
        };
      }
    };

    expect(capture(phone)).toEqual(capture("+254700000204"));
    expect(capture(phone)).toEqual({
      statusCode: 401,
      code: "auth_credentials_invalid",
      message: "The account credentials are invalid."
    });
  });

  it("rate limits repeated PIN failures and releases the key after the window", () => {
    const store = createCp2Store();
    const phone = "+254700000205";
    const startedAt = new Date("2026-01-01T00:00:00.000Z");
    store.signupWithPhonePin({ destination: phone, pin: "4826", now: startedAt });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(() =>
        store.loginWithAccountPin({
          channel: "phone",
          destination: phone,
          pin: "0000",
          now: new Date(startedAt.getTime() + attempt)
        })
      ).toThrowError(expect.objectContaining({ statusCode: 401 }));
    }

    expect(() =>
      store.loginWithAccountPin({
        channel: "phone",
        destination: phone,
        pin: "4826",
        now: new Date(startedAt.getTime() + 5)
      })
    ).toThrowError(expect.objectContaining({ statusCode: 429, code: "pin_rate_limited" }));

    expect(
      store.loginWithAccountPin({
        channel: "phone",
        destination: phone,
        pin: "4826",
        now: new Date(startedAt.getTime() + 16 * 60 * 1000)
      }).account.primaryAuthDestination
    ).toBe(phone);
  });

  it("protects OTP hashes with a server secret and throttles repeated delivery", () => {
    vi.stubEnv("OTP_HMAC_SECRET", "test-otp-secret-that-is-at-least-32-characters");
    const store = createCp2Store();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const otp = store.requestOtp({
      channel: "email",
      destination: "otp-security@example.test",
      now
    });
    const challenge = store
      .snapshot()
      .otpChallenges.find((candidate) => candidate.id === otp.challengeId);
    const legacyHash = createHash("sha256")
      .update(`${otp.challengeId}:${otp.devOtp}`)
      .digest("hex");

    expect(challenge?.codeHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(challenge?.codeHash).not.toBe(legacyHash);
    expect(() =>
      store.requestOtp({
        channel: "email",
        destination: "otp-security@example.test",
        now: new Date(now.getTime() + 59_000)
      })
    ).toThrowError(expect.objectContaining({ statusCode: 429, code: "otp_rate_limited" }));
    expect(
      store.requestOtp({
        channel: "email",
        destination: "otp-security@example.test",
        now: new Date(now.getTime() + 60_000)
      }).challengeId
    ).toBeTruthy();
  });

  it("fails closed when production authentication encryption secrets are missing", () => {
    const existingPinStore = createCp2Store();
    existingPinStore.signupWithPhonePin({
      destination: "+254700000298",
      pin: "4321"
    });
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OTP_HMAC_SECRET", "");
    vi.stubEnv("PIN_HASH_SECRET", "");
    vi.stubEnv("AUTH_TOKEN_ENCRYPTION_KEY", "");
    vi.stubEnv("OAUTH_TOKEN_ENCRYPTION_KEY", "");

    expect(() =>
      createCp2Store().requestOtp({
        channel: "email",
        destination: "missing-secret@example.test"
      })
    ).toThrowError(expect.objectContaining({ statusCode: 503, code: "otp_secret_unconfigured" }));
    const failedSignupStore = createCp2Store();
    expect(() =>
      failedSignupStore.signupWithPhonePin({
        destination: "+254700000299",
        pin: "1234"
      })
    ).toThrowError(
      expect.objectContaining({ statusCode: 503, code: "pin_hash_secret_unconfigured" })
    );
    expect(failedSignupStore.snapshot().accounts).toHaveLength(0);
    expect(() =>
      existingPinStore.loginWithAccountPin({
        channel: "phone",
        destination: "+254700000298",
        pin: "4321"
      })
    ).toThrowError(
      expect.objectContaining({ statusCode: 503, code: "pin_hash_secret_unconfigured" })
    );
    expect(() => encryptOAuthToken("provider-token")).toThrowError(
      expect.objectContaining({
        statusCode: 503,
        code: "oauth_token_encryption_unconfigured"
      })
    );
  });

  it("blocks partially authenticated sessions from durable credentials and account data", async () => {
    vi.stubEnv("OTP_HMAC_SECRET", "test-otp-secret-that-is-at-least-32-characters");
    const store = createCp2Store();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const signupOtp = store.requestOtp({
      channel: "email",
      destination: "pin-gated@example.test",
      purpose: "signup",
      now
    });
    const signup = store.verifyOtp({
      challengeId: signupOtp.challengeId,
      code: signupOtp.devOtp,
      now
    });
    store.setAccountPin({ sessionId: signup.session.id, pin: "7531", now });
    store.createBusiness({
      sessionId: signup.session.id,
      name: "PIN-gated shop",
      language: "en",
      phoneNumber: "0712345678",
      phoneCountry: "KE",
      now
    });

    const recoveryOtp = store.requestOtp({
      channel: "email",
      destination: "pin-gated@example.test",
      purpose: "recovery",
      now: new Date(now.getTime() + 1_000)
    });
    const partial = store.verifyOtp({
      challengeId: recoveryOtp.challengeId,
      code: recoveryOtp.devOtp,
      now: new Date(now.getTime() + 1_000)
    });
    const requiresPin = expect.objectContaining({ statusCode: 401, code: "pin_required" });

    expect(() =>
      store.pullSyncChanges({
        sessionId: partial.session.id,
        cursor: null,
        now: new Date(now.getTime() + 1_000)
      })
    ).toThrowError(requiresPin);
    expect(() =>
      store.createMcpAccessToken({
        sessionId: partial.session.id,
        name: "Read integration",
        scopes: ["mcp:read"],
        now: new Date(now.getTime() + 1_000)
      })
    ).toThrowError(requiresPin);
    await expect(
      store.beginPasskeyRegistration({
        sessionId: partial.session.id,
        rpId: "localhost",
        now: new Date(now.getTime() + 1_000)
      })
    ).rejects.toMatchObject({ statusCode: 401, code: "pin_required" });
  });

  it("sets defensive headers and prevents authentication responses from being cached", async () => {
    const app = buildApi();
    const health = await app.inject({ method: "GET", url: "/health" });
    const session = await app.inject({ method: "GET", url: "/session" });

    expect(health.headers).toMatchObject({
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "permissions-policy": "camera=(), microphone=(), geolocation=()"
    });
    expect(session.headers["cache-control"]).toBe("no-store");

    await app.close();
  });

  it("does not accept caller-supplied OAuth tokens or identity profiles", async () => {
    vi.stubEnv("OAUTH_GOOGLE_ENABLED", "true");
    vi.stubEnv("OAUTH_GOOGLE_CLIENT_ID", "google-client-id");
    vi.stubEnv("OAUTH_GOOGLE_CLIENT_SECRET", "google-client-secret");
    const app = buildApi();
    const start = await app.inject({
      method: "POST",
      url: "/auth/oauth/start",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        provider: "google",
        redirectUri: "http://127.0.0.1:5173/auth/oauth/callback"
      })
    });
    const started = start.json<{ state: string; csrfToken: string }>();
    const callback = await app.inject({
      method: "POST",
      url: "/auth/oauth/callback",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        provider: "google",
        state: started.state,
        csrfToken: started.csrfToken,
        tokens: { accessToken: "attacker-controlled-token" },
        profile: {
          providerSubject: "attacker-controlled-subject",
          email: "victim@example.test",
          emailVerified: true
        }
      })
    });

    expect(start.statusCode).toBe(200);
    expect(callback.statusCode).toBe(400);
    expect(callback.json()).toMatchObject({ code: "code_required" });
    expect(callback.headers["set-cookie"]).toBeUndefined();

    await app.close();
  });

  it("renders bundled legal content without an arbitrary HTML injection sink", async () => {
    const [terms, privacy] = await Promise.all([
      readFile("apps/web/src/legal/TermsOfServicePage.tsx", "utf8"),
      readFile("apps/web/src/legal/PrivacyPolicyPage.tsx", "utf8")
    ]);

    expect(terms).not.toContain("dangerouslySetInnerHTML");
    expect(privacy).not.toContain("dangerouslySetInnerHTML");
    expect(terms).not.toContain("/legal/terms");
    expect(privacy).not.toContain("/legal/privacy");
  });
});
