import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../services/api/src/app";
import {
  createEmailProviderFromEnvironment,
  type EmailOtpInput,
  type EmailProvider
} from "../services/api/src/cp2/email-provider";
import { createCp2Store } from "../services/api/src/cp2/store";

describe("transactional email API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends signup OTPs and privacy-preserving encrypted-message notifications through Resend", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ id: "email-test-1" }), { status: 200 });
      })
    );
    const provider = createEmailProviderFromEnvironment({
      NODE_ENV: "production",
      RESEND_API_KEY: "re_mock_api_key",
      GROGONI_EMAIL_FROM: "Grogoni <messages@grogoni.test>"
    });

    await provider.sendOtp({
      challengeId: "challenge-email-1",
      code: "483921",
      expiresAt: "2026-07-17T15:00:00.000Z",
      to: "email-user@example.test"
    });
    await expect(
      provider.sendEncryptedMessageNotification({
        conversationId: "conversation-email-1",
        messageId: "message-email-1",
        openUrl: "https://grogoni.com/?conversation=conversation-email-1",
        to: "email-user@example.test"
      })
    ).resolves.toBe("sent");

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe("https://api.resend.com/emails");
    expect(requests[0]?.init.headers).toMatchObject({
      authorization: "Bearer re_mock_api_key",
      "idempotency-key": "otp-challenge-email-1"
    });
    const otpBody = JSON.parse(String(requests[0]?.init.body)) as Record<string, unknown>;
    expect(otpBody).toMatchObject({
      from: "Grogoni <messages@grogoni.test>",
      to: ["email-user@example.test"],
      subject: "Your Grogoni verification code"
    });
    expect(otpBody.text).toContain("483921");

    const notificationBody = JSON.parse(String(requests[1]?.init.body)) as Record<string, unknown>;
    expect(notificationBody.text).toContain("end-to-end encrypted");
    expect(notificationBody.text).toContain("https://grogoni.com/?conversation=");
    expect(notificationBody.text).not.toContain("private phone to email message");
  });

  it("fails closed for production email signup when the email API is unconfigured", async () => {
    const provider = createEmailProviderFromEnvironment({ NODE_ENV: "production" });

    expect(provider.exposesDevOtp).toBe(false);
    await expect(
      provider.sendOtp({
        challengeId: "challenge-email-2",
        code: "123456",
        expiresAt: "2026-07-17T15:00:00.000Z",
        to: "email-user@example.test"
      })
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "email_api_unconfigured"
    });
  });

  it("routes email signup OTP through the email provider without exposing the code", async () => {
    const deliveries: EmailOtpInput[] = [];
    const emailProvider: EmailProvider = {
      name: "mock-email-api",
      exposesDevOtp: false,
      sendOtp: async (input) => {
        deliveries.push(input);
      },
      sendEncryptedMessageNotification: async () => "sent"
    };
    const app = buildApi({ cp2: { store: createCp2Store(), emailProvider } });
    const requested = await app.inject({
      method: "POST",
      url: "/auth/otp/request",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        method: "email",
        contact: "mock-email-api@example.test",
        deliveryChannel: "email",
        purpose: "signup"
      })
    });

    expect(requested.statusCode).toBe(200);
    expect(requested.json()).not.toHaveProperty("devOtp");
    expect(deliveries).toEqual([
      expect.objectContaining({
        challengeId: requested.json<{ challengeId: string }>().challengeId,
        to: "mock-email-api@example.test"
      })
    ]);

    const verified = await app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        challengeId: requested.json<{ challengeId: string }>().challengeId,
        code: deliveries[0]?.code
      })
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.headers["set-cookie"]).toBeDefined();
    await app.close();
  });

  it("signs up, logs out, logs in, and recovers a PIN using the same email account", async () => {
    const deliveries: EmailOtpInput[] = [];
    const emailProvider: EmailProvider = {
      name: "mock-email-roundtrip",
      exposesDevOtp: false,
      sendOtp: async (input) => {
        deliveries.push(input);
      },
      sendEncryptedMessageNotification: async () => "sent"
    };
    const app = buildApi({ cp2: { store: createCp2Store(), emailProvider } });
    const email = "owner.roundtrip@example.test";

    const signupRequest = await app.inject({
      method: "POST",
      url: "/auth/otp/request",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        method: "email",
        contact: email,
        deliveryChannel: "email",
        purpose: "signup"
      })
    });
    const signupChallengeId = signupRequest.json<{ challengeId: string }>().challengeId;
    const signupDelivery = deliveries.find(
      (delivery) => delivery.challengeId === signupChallengeId
    );
    const signupVerify = await app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        method: "email",
        contact: email,
        challengeId: signupChallengeId,
        otp: signupDelivery?.code
      })
    });
    const accountId = signupVerify.json<{ account: { id: string } }>().account.id;
    const signupCookie = sessionCookie(signupVerify.headers["set-cookie"]);

    expect(signupRequest.statusCode).toBe(200);
    expect(signupVerify.statusCode).toBe(200);
    expect(signupVerify.json()).toMatchObject({ resumed: false });

    const pinSetup = await app.inject({
      method: "POST",
      url: "/auth/pin/setup",
      headers: { "content-type": "application/json", cookie: signupCookie },
      payload: JSON.stringify({ pin: "2468" })
    });
    expect(pinSetup.statusCode).toBe(200);

    await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: signupCookie }
    });

    const pinLogin = await app.inject({
      method: "POST",
      url: "/auth/pin/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        method: "email",
        contact: "OWNER.ROUNDTRIP@EXAMPLE.TEST",
        pin: "2468"
      })
    });
    const pinLoginCookie = sessionCookie(pinLogin.headers["set-cookie"]);
    expect(pinLogin.statusCode).toBe(200);
    expect(pinLogin.json()).toMatchObject({ account: { id: accountId } });

    await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: pinLoginCookie }
    });

    const recoveryRequest = await app.inject({
      method: "POST",
      url: "/auth/otp/request",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        method: "email",
        contact: email,
        deliveryChannel: "email",
        purpose: "recovery"
      })
    });
    const recoveryChallengeId = recoveryRequest.json<{ challengeId: string }>().challengeId;
    const recoveryDelivery = deliveries.find(
      (delivery) => delivery.challengeId === recoveryChallengeId
    );
    const recoveryVerify = await app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        method: "email",
        contact: email,
        challengeId: recoveryChallengeId,
        otp: recoveryDelivery?.code
      })
    });
    const recoveryCookie = sessionCookie(recoveryVerify.headers["set-cookie"]);

    expect(recoveryRequest.statusCode).toBe(200);
    expect(recoveryVerify.statusCode).toBe(200);
    expect(recoveryVerify.json()).toMatchObject({
      account: { id: accountId },
      resumed: true
    });

    const recoverPin = await app.inject({
      method: "POST",
      url: "/auth/pin/recover",
      headers: { "content-type": "application/json", cookie: recoveryCookie },
      payload: JSON.stringify({ pin: "1357" })
    });
    expect(recoverPin.statusCode).toBe(200);

    await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: recoveryCookie }
    });

    const oldPinLogin = await app.inject({
      method: "POST",
      url: "/auth/pin/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ method: "email", contact: email, pin: "2468" })
    });
    const recoveredPinLogin = await app.inject({
      method: "POST",
      url: "/auth/pin/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ method: "email", contact: email, pin: "1357" })
    });

    expect(oldPinLogin.statusCode).toBe(401);
    expect(recoveredPinLogin.statusCode).toBe(200);
    expect(recoveredPinLogin.json()).toMatchObject({ account: { id: accountId } });
    await app.close();
  });
});

function sessionCookie(setCookie: string | string[] | undefined): string {
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (value === undefined) throw new Error("Session cookie missing.");
  return value.split(";")[0] ?? value;
}
