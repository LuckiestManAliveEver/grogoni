import { describe, expect, it } from "vitest";
import { createCp2Store } from "../services/api/src/cp2/store";
import type { Cp2Error } from "../services/api/src/cp2/store";

describe("OTP recovery purpose", () => {
  it("supersedes old recovery codes only after an accepted resend", () => {
    const store = createCp2Store();
    const destination = "resend@example.test";
    const now = new Date("2026-11-15T12:00:00Z");
    const first = store.requestOtp({ channel: "email", destination, purpose: "recovery", now });
    expect(() =>
      store.requestOtp({ channel: "email", destination, purpose: "recovery", now })
    ).toThrowError(expect.objectContaining({ code: "otp_rate_limited" }));
    expect(
      store.snapshot().otpChallenges.find((item) => item.id === first.challengeId)?.expiresAt
    ).toBe(first.expiresAt);
    const later = new Date(now.getTime() + 61_000);
    const second = store.requestOtp({
      channel: "email",
      destination,
      purpose: "recovery",
      now: later
    });
    expect(
      store.snapshot().otpChallenges.find((item) => item.id === second.challengeId)?.expiresAt
    ).toBe(second.expiresAt);
    expect(() =>
      store.verifyOtp({ challengeId: first.challengeId, code: first.devOtp, now: later })
    ).toThrow();
  });

  it("resumes an existing account and never creates one from a recovery challenge", () => {
    const store = createCp2Store();
    const email = "otp-recovery@example.test";
    const signup = store.requestOtp({
      channel: "email",
      destination: email,
      purpose: "signup"
    });
    const created = store.verifyOtp({
      challengeId: signup.challengeId,
      code: signup.devOtp
    });

    expect(created.resumed).toBe(false);

    const recovery = store.requestOtp({
      channel: "email",
      destination: email,
      purpose: "recovery"
    });
    const resumed = store.verifyOtp({
      challengeId: recovery.challengeId,
      code: recovery.devOtp
    });

    expect(resumed.resumed).toBe(true);
    expect(resumed.account.id).toBe(created.account.id);

    const unknownRecovery = store.requestOtp({
      channel: "email",
      destination: "unknown-recovery@example.test",
      purpose: "recovery"
    });

    expect(() =>
      store.verifyOtp({
        challengeId: unknownRecovery.challengeId,
        code: unknownRecovery.devOtp
      })
    ).toThrowError(
      expect.objectContaining<Partial<Cp2Error>>({
        code: "recovery_account_not_found",
        statusCode: 404
      })
    );
    expect(store.snapshot().accounts).toHaveLength(1);
  });
});
