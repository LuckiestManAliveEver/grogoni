import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../services/api/src/app";
import {
  BREVO_TRANSACTIONAL_EMAIL_URL,
  createEmailProviderFromEnvironment,
  parseEmailSender,
  type EmailOtpInput,
  type EmailProvider
} from "../services/api/src/cp2/email-provider";
import { createCp2Store } from "../services/api/src/cp2/store";

describe("transactional email API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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

  it("sends verification codes and recovery notices through Brevo", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ messageId: "<brevo-1@smtp-relay>" }), {
          status: 201
        });
      })
    );
    const provider = createEmailProviderFromEnvironment({
      NODE_ENV: "production",
      BREVO_API_KEY: "xkeysib-mock",
      // Brevo wins when both keys are present.
      RESEND_API_KEY: "re_mock_api_key",
      GROGONI_EMAIL_FROM: "Grogoni <messages@grogoni.test>"
    });

    expect(provider.name).toBe("brevo");
    expect(provider.exposesDevOtp).toBe(false);
    await provider.sendOtp({
      challengeId: "challenge-brevo-1",
      code: "582913",
      expiresAt: "2026-11-09T15:00:00.000Z",
      to: "owner@example.test"
    });
    await expect(
      provider.sendRecoveryNotification!({
        to: "owner@example.test",
        sessionId: "session-brevo-1",
        credential: "password"
      })
    ).resolves.toBe("sent");

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(BREVO_TRANSACTIONAL_EMAIL_URL);
    expect(requests[0]?.init.headers).toMatchObject({
      "api-key": "xkeysib-mock",
      "content-type": "application/json"
    });
    const otpBody = JSON.parse(String(requests[0]?.init.body)) as Record<string, unknown>;
    expect(otpBody).toMatchObject({
      sender: { name: "Grogoni", email: "messages@grogoni.test" },
      to: [{ email: "owner@example.test" }],
      subject: "Your Grogoni verification code",
      headers: { "X-Grogoni-Message-Key": "otp-challenge-brevo-1" },
      tags: ["otp"]
    });
    expect(otpBody.textContent).toContain("582913");
    const noticeBody = JSON.parse(String(requests[1]?.init.body)) as Record<string, unknown>;
    expect(noticeBody.subject).toBe("Your Grogoni account password was reset");
    expect(noticeBody.tags).toEqual(["recovery"]);
  });

  it("surfaces a Brevo rejection as a delivery failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ code: "unauthorized" }), { status: 401 }))
    );
    const provider = createEmailProviderFromEnvironment({
      NODE_ENV: "production",
      BREVO_API_KEY: "xkeysib-revoked",
      GROGONI_EMAIL_FROM: "messages@grogoni.test"
    });

    await expect(
      provider.sendOtp({
        challengeId: "challenge-brevo-2",
        code: "111222",
        expiresAt: "2026-11-09T15:00:00.000Z",
        to: "owner@example.test"
      })
    ).rejects.toMatchObject({ statusCode: 502, code: "email_delivery_failed" });
    await expect(
      provider.sendRecoveryNotification!({
        to: "owner@example.test",
        sessionId: "session-brevo-2",
        credential: "PIN"
      })
    ).resolves.toBe("failed");
  });

  it("parses the configured sender for Brevo", () => {
    expect(parseEmailSender("Grogoni <messages@grogoni.com>")).toEqual({
      name: "Grogoni",
      email: "messages@grogoni.com"
    });
    expect(parseEmailSender('"Grogoni Support" <help@grogoni.com>')).toEqual({
      name: "Grogoni Support",
      email: "help@grogoni.com"
    });
    expect(parseEmailSender("<messages@grogoni.com>")).toEqual({ email: "messages@grogoni.com" });
    expect(parseEmailSender(" messages@grogoni.com ")).toEqual({ email: "messages@grogoni.com" });
    expect(() => parseEmailSender("Grogoni")).toThrow(/GROGONI_EMAIL_FROM/u);
  });

  it("recovers a password end to end with the code delivered through Brevo", async () => {
    vi.stubEnv("OTP_COOLDOWN_SECONDS", "0");
    const sent: Array<{ to: string; textContent: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url) !== BREVO_TRANSACTIONAL_EMAIL_URL) throw new Error(`Unexpected ${url}`);
        const body = JSON.parse(String(init?.body)) as {
          to: Array<{ email: string }>;
          textContent: string;
        };
        sent.push({ to: body.to[0]!.email, textContent: body.textContent });
        return new Response(JSON.stringify({ messageId: "<brevo@relay>" }), { status: 201 });
      })
    );
    const emailProvider = createEmailProviderFromEnvironment({
      NODE_ENV: "production",
      BREVO_API_KEY: "xkeysib-mock",
      GROGONI_EMAIL_FROM: "Grogoni <messages@grogoni.test>"
    });
    const app = buildApi({ cp2: { store: createCp2Store(), emailProvider } });
    const post = (url: string, payload: Record<string, unknown>, cookie?: string) =>
      app.inject({ method: "POST", url, payload, headers: cookie ? { cookie } : {} });
    const lastCode = () => /\b(\d{6})\b/u.exec(sent.at(-1)!.textContent)![1]!;
    const email = "brevo.recovery@example.test";

    const signup = await post("/auth/pin/signup", {
      method: "phone",
      contact: "+254700002213",
      pin: "7306"
    });
    expect(signup.statusCode).toBe(200);
    const cookie = sessionCookie(signup.headers["set-cookie"]);
    const link = await post("/auth/identity/email/start", { email }, cookie);
    expect(link.statusCode).toBe(200);
    expect(link.json()).not.toHaveProperty("developmentCode");
    expect(sent.at(-1)?.to).toBe(email);
    expect(
      (
        await post(
          "/auth/identity/email/verify",
          { challengeId: link.json<{ challengeId: string }>().challengeId, code: lastCode() },
          cookie
        )
      ).statusCode
    ).toBe(200);
    await post("/auth/logout", {}, cookie);

    // Unknown addresses get the same response and no email.
    const before = sent.length;
    const unknown = await post("/auth/recovery/start", {
      type: "email",
      identifier: "nobody@example.test"
    });
    expect(unknown.statusCode).toBe(200);
    expect(sent).toHaveLength(before);

    const recovery = await post("/auth/recovery/start", { type: "email", identifier: email });
    expect(recovery.statusCode).toBe(200);
    expect(recovery.json()).not.toHaveProperty("developmentCode");
    expect(recovery.json<{ message: string }>().message).toBe(
      unknown.json<{ message: string }>().message
    );
    expect(sent.at(-1)?.to).toBe(email);
    const transactionId = recovery.json<{ transactionId: string }>().transactionId;
    expect(
      (await post("/auth/recovery/verify", { transactionId, code: "000000" })).statusCode
    ).toBe(401);
    expect(
      (await post("/auth/recovery/verify", { transactionId, code: lastCode() })).statusCode
    ).toBe(200);
    const replacement = "brevo delivered recovery password";
    const reset = await post("/auth/recovery/reset-password", {
      transactionId,
      password: replacement,
      passwordConfirmation: replacement
    });
    expect(reset.statusCode).toBe(200);
    expect(sent.at(-1)?.textContent).toContain("was reset");
    // The recovery grant is single use.
    const replay = await post("/auth/recovery/reset-password", {
      transactionId,
      password: replacement,
      passwordConfirmation: replacement
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject({ code: "auth_transaction_invalid" });
    await app.close();
  });

  it("resets a forgotten PIN through verified backup email", async () => {
    vi.stubEnv("OTP_COOLDOWN_SECONDS", "0");
    const deliveries: EmailOtpInput[] = [];
    const notices: string[] = [];
    const emailProvider: EmailProvider = {
      name: "mock-email-pin",
      exposesDevOtp: false,
      sendOtp: async (input) => {
        deliveries.push(input);
      },
      sendRecoveryNotification: async (input) => {
        notices.push(`${input.to}:${input.credential}`);
        return "sent";
      },
      sendEncryptedMessageNotification: async () => "sent"
    };
    const app = buildApi({ cp2: { store: createCp2Store(), emailProvider } });
    const post = (url: string, payload: Record<string, unknown>, cookie?: string) =>
      app.inject({ method: "POST", url, payload, headers: cookie ? { cookie } : {} });
    const phone = "+254700002214";
    const email = "pin.recovery@example.test";

    const signup = await post("/auth/pin/signup", { method: "phone", contact: phone, pin: "7306" });
    expect(signup.statusCode).toBe(200);
    const accountId = signup.json<{ account: { id: string } }>().account.id;
    const oldCookie = sessionCookie(signup.headers["set-cookie"]);
    const link = await post("/auth/identity/email/start", { email }, oldCookie);
    expect(
      (
        await post(
          "/auth/identity/email/verify",
          {
            challengeId: link.json<{ challengeId: string }>().challengeId,
            code: deliveries.at(-1)!.code
          },
          oldCookie
        )
      ).statusCode
    ).toBe(200);

    const start = async () => {
      const recovery = await post("/auth/recovery/start", { type: "email", identifier: email });
      expect(recovery.statusCode).toBe(200);
      return recovery.json<{ transactionId: string }>().transactionId;
    };

    // Unverified transactions cannot reset the PIN.
    const unverified = await start();
    expect(
      (
        await post("/auth/recovery/reset-pin", {
          transactionId: unverified,
          pin: "5831",
          pinConfirmation: "5831"
        })
      ).statusCode
    ).toBe(400);

    const transactionId = await start();
    expect(
      (await post("/auth/recovery/verify", { transactionId, code: deliveries.at(-1)!.code }))
        .statusCode
    ).toBe(200);
    const mismatch = await post("/auth/recovery/reset-pin", {
      transactionId,
      pin: "5831",
      pinConfirmation: "5832"
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json()).toMatchObject({ code: "pin_confirmation_invalid" });
    const predictable = await post("/auth/recovery/reset-pin", {
      transactionId,
      pin: "1234",
      pinConfirmation: "1234"
    });
    expect(predictable.statusCode).toBe(400);

    const reset = await post("/auth/recovery/reset-pin", {
      transactionId,
      pin: "5831",
      pinConfirmation: "5831"
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ account: { id: accountId } });
    expect(reset.headers["set-cookie"]).toBeDefined();
    expect(notices).toEqual([`${email}:PIN`]);

    // Single use, other sessions signed out, old PIN refused, new PIN works.
    expect(
      (
        await post("/auth/recovery/reset-pin", {
          transactionId,
          pin: "5831",
          pinConfirmation: "5831"
        })
      ).statusCode
    ).toBe(400);
    expect(
      (await app.inject({ method: "GET", url: "/session", headers: { cookie: oldCookie } }))
        .statusCode
    ).toBe(401);
    expect(
      (await post("/auth/pin/login", { method: "phone", contact: phone, pin: "7306" })).statusCode
    ).toBe(401);
    const login = await post("/auth/pin/login", { method: "phone", contact: phone, pin: "5831" });
    expect([200, 202]).toContain(login.statusCode);
    await app.close();
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

  it("delivers backup email verification without exposing a code or creating a login session", async () => {
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
    const signup = await app.inject({
      method: "POST",
      url: "/auth/pin/signup",
      payload: { method: "phone", contact: "+254700002211", pin: "7306" }
    });
    expect(signup.statusCode).toBe(200);
    const cookie = sessionCookie(signup.headers["set-cookie"]);
    const requested = await app.inject({
      method: "POST",
      url: "/auth/identity/email/start",
      headers: { cookie },
      payload: { email: "mock-email-api@example.test" }
    });
    expect(requested.statusCode).toBe(200);
    expect(requested.json()).not.toHaveProperty("developmentCode");
    expect(requested.json()).not.toHaveProperty("devOtp");
    expect(deliveries).toEqual([
      expect.objectContaining({
        challengeId: requested.json<{ challengeId: string }>().challengeId,
        to: "mock-email-api@example.test"
      })
    ]);
    const verified = await app.inject({
      method: "POST",
      url: "/auth/identity/email/verify",
      headers: { cookie },
      payload: { challengeId: deliveries[0]!.challengeId, code: deliveries[0]!.code }
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.headers["set-cookie"]).toBeUndefined();
    const blocked = await app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      payload: { challengeId: deliveries[0]!.challengeId, code: deliveries[0]!.code }
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.headers["set-cookie"]).toBeUndefined();
    await app.close();
  });

  it("logs in by phone and recovers a password through verified backup email", async () => {
    vi.stubEnv("OTP_COOLDOWN_SECONDS", "0");
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
    const phone = "+254700002212";
    const email = "owner.roundtrip@example.test";
    const post = (url: string, payload: unknown, cookie?: string) =>
      app.inject({
        method: "POST",
        url,
        payload: payload as Record<string, unknown>,
        headers: cookie ? { cookie } : {}
      });
    const signup = await post("/auth/pin/signup", { method: "phone", contact: phone, pin: "7306" });
    expect(signup.statusCode).toBe(200);
    const accountId = signup.json<{ account: { id: string } }>().account.id;
    const cookie = sessionCookie(signup.headers["set-cookie"]);
    const password = "first secure recovery password";
    expect(
      (
        await post(
          "/auth/password/setup",
          { currentPin: "7306", password, passwordConfirmation: password },
          cookie
        )
      ).statusCode
    ).toBe(200);
    const link = await post("/auth/identity/email/start", { email }, cookie);
    expect(link.statusCode).toBe(200);
    const linkCode = deliveries.find(
      (item) => item.challengeId === link.json<{ challengeId: string }>().challengeId
    )!;
    expect(
      (
        await post(
          "/auth/identity/email/verify",
          { challengeId: linkCode.challengeId, code: linkCode.code },
          cookie
        )
      ).statusCode
    ).toBe(200);
    await post("/auth/logout", {}, cookie);
    const login = await post("/auth/pin/login", { method: "phone", contact: phone, pin: "7306" });
    expect(login.statusCode).toBe(202);
    expect(login.headers["set-cookie"]).toBeUndefined();
    const authenticated = await finishEmailMfa(
      app,
      login.json<{ transactionId: string }>().transactionId,
      deliveries
    );
    expect(authenticated.json()).toMatchObject({ account: { id: accountId } });
    await post("/auth/logout", {}, sessionCookie(authenticated.headers["set-cookie"]));

    const recovery = await post("/auth/recovery/start", { type: "email", identifier: email });
    expect(recovery.statusCode).toBe(200);
    expect(recovery.json()).not.toHaveProperty("developmentCode");
    const transactionId = recovery.json<{ transactionId: string }>().transactionId;
    const recoveryDelivery = deliveries.at(-1)!;
    expect(
      (await post("/auth/recovery/verify", { transactionId, code: recoveryDelivery.code }))
        .statusCode
    ).toBe(200);
    const replacement = "replacement secure recovery password";
    const reset = await post("/auth/recovery/reset-password", {
      transactionId,
      password: replacement,
      passwordConfirmation: replacement
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ account: { id: accountId } });
    expect(
      (await post("/auth/login/password", { type: "phone", identifier: phone, password }))
        .statusCode
    ).toBe(401);
    const newLogin = await post("/auth/login/password", {
      type: "phone",
      identifier: phone,
      password: replacement
    });
    expect(newLogin.statusCode).toBe(202);
    const verified = await finishEmailMfa(
      app,
      newLogin.json<{ transactionId: string }>().transactionId,
      deliveries
    );
    expect(verified.json()).toMatchObject({ account: { id: accountId } });
    expect(
      (await post("/auth/pin/login", { method: "email", contact: email, pin: "7306" })).statusCode
    ).toBe(400);
    await app.close();
  });
});

function sessionCookie(setCookie: string | string[] | undefined): string {
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (value === undefined) throw new Error("Session cookie missing.");
  return value.split(";")[0] ?? value;
}

async function finishEmailMfa(
  app: ReturnType<typeof buildApi>,
  transactionId: string,
  deliveries: EmailOtpInput[]
) {
  const challenge = await app.inject({
    method: "POST",
    url: "/auth/mfa/email/challenge",
    payload: { transactionId }
  });
  expect(challenge.statusCode).toBe(200);
  const delivery = deliveries.at(-1)!;
  const verified = await app.inject({
    method: "POST",
    url: "/auth/mfa/verify",
    payload: { transactionId, factor: "email", code: delivery.code }
  });
  expect(verified.statusCode).toBe(200);
  return verified;
}
