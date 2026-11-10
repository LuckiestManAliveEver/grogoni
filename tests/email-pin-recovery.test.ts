import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import { totpCode } from "../supabase/functions/api/credentials";

const phone = "+254700008291";
const email = "pin-recovery@example.test";
function fixture() {
  const store = createCp2Store();
  const owner = store.signupWithPhonePin({ destination: phone, pin: "7392" });
  store.beginEmailIdentityUpgrade({ sessionId: owner.session.id, email });
  const enrollment = store.requestOtp({ channel: "email", destination: email, purpose: "signup" });
  store.verifyPendingEmail({
    sessionId: owner.session.id,
    challengeId: enrollment.challengeId,
    code: enrollment.devOtp
  });
  const otp = store.requestOtp({ channel: "email", destination: email, purpose: "recovery" });
  const transaction = store.beginRecovery({
    channel: "email",
    identifier: email,
    providerChallengeId: otp.challengeId,
    expiresAt: otp.expiresAt
  });
  const verify = () =>
    store.verifyEmailRecovery({
      transactionId: transaction.transactionId,
      challengeId: otp.challengeId,
      code: otp.devOtp
    });
  return { store, owner, otp, transactionId: transaction.transactionId, verify };
}
afterEach(() => vi.unstubAllEnvs());

describe("email PIN recovery", () => {
  it("requires email proof, resets through HTTP, revokes old sessions, and consumes proof once", async () => {
    const { store, owner, otp, transactionId } = fixture();
    const notify = vi.fn(async () => "sent" as const);
    const app = buildApi({
      cp2: {
        store,
        emailProvider: {
          name: "test",
          exposesDevOtp: false,
          sendOtp: async () => {},
          sendRecoveryNotification: notify,
          sendEncryptedMessageNotification: async () => "sent"
        }
      }
    });
    const post = (url: string, payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url, payload });
    const reset = (pin = "8246", confirmation = pin) =>
      post("/auth/recovery/reset-pin", { transactionId, pin, pinConfirmation: confirmation });
    try {
      expect((await reset()).statusCode).toBe(400);
      expect(
        (await post("/auth/recovery/verify", { transactionId, code: otp.devOtp })).statusCode
      ).toBe(200);
      expect((await reset("8246", "7392")).json()).toMatchObject({
        code: "pin_confirmation_invalid"
      });
      expect((await reset("1234")).json()).toMatchObject({ code: "pin_weak" });
      expect((await reset("824")).json()).toMatchObject({ code: "pin_invalid" });
      const result = await reset();
      expect(result.statusCode).toBe(200);
      expect(result.json().account.id).toBe(owner.account.id);
      expect(result.cookies.some((c) => c.name === "grogoni_session" && c.httpOnly)).toBe(true);
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ credential: "PIN" }));
      expect(store.snapshot().passwordCredentials).toHaveLength(0);
      expect(() => store.getAccountPinStatus({ sessionId: owner.session.id })).toThrow();
      const restored = createCp2Store();
      restored.hydrateSnapshot(store.snapshot());
      expect(() =>
        restored.loginWithAccountPin({ channel: "phone", destination: phone, pin: "7392" })
      ).toThrow();
      expect(
        restored.loginWithAccountPin({ channel: "phone", destination: phone, pin: "8246" }).account
          .id
      ).toBe(owner.account.id);
      expect((await reset()).statusCode).toBe(400);
      expect(
        (
          await post("/auth/recovery/reset-password", {
            transactionId,
            password: "unused-password-123",
            passwordConfirmation: "unused-password-123"
          })
        ).statusCode
      ).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("cannot use a verified transaction without a matching verified email OTP", () => {
    const { store, transactionId } = fixture();
    const snapshot = store.snapshot();
    snapshot.authTransactions!.find((t) => t.id === transactionId)!.verifiedAt =
      new Date().toISOString();
    store.hydrateSnapshot(snapshot);
    expect(() => store.resetRecoveredPin({ transactionId, pin: "8246" })).toThrowError(
      expect.objectContaining({ code: "recovery_verification_invalid" })
    );
  });

  it("rejects expired proof and a backup email removed after verification", () => {
    const { store, transactionId, verify } = fixture();
    verify();
    expect(() =>
      store.resetRecoveredPin({
        transactionId,
        pin: "8246",
        now: new Date(Date.now() + 60 * 60_000)
      })
    ).toThrow();
    const snapshot = store.snapshot();
    snapshot.accountIdentities = snapshot.accountIdentities!.filter((i) => i.type !== "email");
    store.hydrateSnapshot(snapshot);
    expect(() => store.resetRecoveredPin({ transactionId, pin: "8246" })).toThrowError(
      expect.objectContaining({ code: "recovery_verification_invalid" })
    );
  });

  it("retains MFA and bounds incorrect authenticator attempts", () => {
    const { store, owner, transactionId, verify } = fixture();
    const setup = store.setupTotp({ sessionId: owner.session.id });
    const snapshot = store.snapshot();
    snapshot.mfaFactors!.find((f) => f.id === setup.factorId)!.verifiedAt =
      new Date().toISOString();
    store.hydrateSnapshot(snapshot);
    verify();
    expect(() => store.resetRecoveredPin({ transactionId, pin: "8246" })).toThrowError(
      expect.objectContaining({ code: "mfa_required" })
    );
    for (let i = 0; i < 5; i++)
      expect(() =>
        store.resetRecoveredPin({ transactionId, pin: "8246", mfaCode: "invalid" })
      ).toThrowError(expect.objectContaining({ code: "mfa_code_invalid" }));
    expect(() =>
      store.resetRecoveredPin({
        transactionId,
        pin: "8246",
        mfaCode: totpCode(setup.secret, Math.floor(Date.now() / 30000))
      })
    ).toThrowError(expect.objectContaining({ code: "auth_transaction_invalid" }));
  });

  it("accepts a valid authenticator code without resetting unrelated accounts", () => {
    const { store, owner, transactionId, verify } = fixture();
    const stranger = store.signupWithPhonePin({ destination: "+254700008292", pin: "6379" });
    const setup = store.setupTotp({ sessionId: owner.session.id });
    const snapshot = store.snapshot();
    snapshot.mfaFactors!.find((f) => f.id === setup.factorId)!.verifiedAt =
      new Date().toISOString();
    store.hydrateSnapshot(snapshot);
    verify();
    const result = store.resetRecoveredPin({
      transactionId,
      pin: "8246",
      mfaCode: totpCode(setup.secret, Math.floor(Date.now() / 30000))
    });
    expect(result.account.id).toBe(owner.account.id);
    expect(store.getAccountPinStatus({ sessionId: stranger.session.id })).toEqual({ hasPin: true });
    expect(
      store.loginWithAccountPin({
        channel: "phone",
        destination: stranger.account.primaryAuthDestination,
        pin: "6379"
      }).account.id
    ).toBe(stranger.account.id);
  });
});
