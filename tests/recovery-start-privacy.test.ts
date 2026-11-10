import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../services/api/src/app";
import type { EmailOtpInput, EmailProvider } from "../services/api/src/cp2/email-provider";
import { createCp2Store } from "../services/api/src/cp2/store";

describe("recovery start privacy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the same response for unknown, successful, and throttled email requests", async () => {
    const deliveries: EmailOtpInput[] = [];
    const backgroundTasks: Promise<unknown>[] = [];
    let holdRecoveryDelivery = false;
    let releaseRecoveryDelivery: () => void = () => {};
    const heldDelivery = new Promise<void>((resolve) => {
      releaseRecoveryDelivery = resolve;
    });
    const app = buildApi({
      cp2: {
        store: createCp2Store(),
        emailProvider: createEmailProvider(async (input) => {
          deliveries.push(input);
          if (holdRecoveryDelivery) await heldDelivery;
        }, true),
        waitUntil: (work) => backgroundTasks.push(work)
      }
    });
    const email = "owner.privacy@example.test";
    await addVerifiedEmail(app, email, deliveries, backgroundTasks);
    vi.stubEnv("OTP_COOLDOWN_SECONDS", "60");

    holdRecoveryDelivery = true;
    const successfulRequest = startRecovery(app, email);
    const respondedBeforeDelivery = await Promise.race([
      successfulRequest.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100))
    ]);
    releaseRecoveryDelivery();
    expect(respondedBeforeDelivery).toBe(true);
    const successful = await successfulRequest;
    await backgroundTasks.at(-1);
    const unknown = await startRecovery(app, "unknown.privacy@example.test");
    const throttled = await startRecovery(app, email);

    expect(successful.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(successful.statusCode);
    expect(throttled.statusCode).toBe(successful.statusCode);
    expect(successful.json()).not.toHaveProperty("developmentCode");
    expect(unknown.json()).toMatchObject({
      message: successful.json().message
    });
    expect(throttled.json()).toMatchObject({
      message: successful.json().message
    });
    expect(Object.keys(unknown.json()).sort()).toEqual(Object.keys(successful.json()).sort());
    expect(Object.keys(throttled.json()).sort()).toEqual(Object.keys(successful.json()).sort());
    expect(deliveries).toHaveLength(2);
    const invalidKnownTransaction = await verifyRecovery(
      app,
      successful.json().transactionId,
      "not-the-recovery-code"
    );
    const invalidUnknownTransaction = await verifyRecovery(
      app,
      unknown.json().transactionId,
      "not-the-recovery-code"
    );
    expect(invalidKnownTransaction.statusCode).toBe(401);
    expect(invalidUnknownTransaction.statusCode).toBe(invalidKnownTransaction.statusCode);
    expect(invalidUnknownTransaction.json()).toEqual(invalidKnownTransaction.json());
    const recoveryDelivery = deliveries.at(-1)!;
    const verified = await verifyRecovery(
      app,
      successful.json().transactionId,
      recoveryDelivery.code
    );
    expect(verified.statusCode).toBe(200);
    await app.close();
  });

  it("uses the same response when recovery email delivery fails", async () => {
    let sendCount = 0;
    const deliveries: EmailOtpInput[] = [];
    const backgroundTasks: Promise<unknown>[] = [];
    const app = buildApi({
      cp2: {
        store: createCp2Store(),
        emailProvider: createEmailProvider(async (input) => {
          sendCount += 1;
          if (sendCount > 1) throw new Error("private provider response");
          deliveries.push(input);
        }, true),
        waitUntil: (work) => backgroundTasks.push(work)
      }
    });
    const email = "owner.delivery@example.test";
    await addVerifiedEmail(app, email, deliveries, backgroundTasks);

    const failedDelivery = await startRecovery(app, email);
    await backgroundTasks.at(-1);
    const unknown = await startRecovery(app, "unknown.delivery@example.test");

    expect(failedDelivery.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(failedDelivery.statusCode);
    expect(Object.keys(unknown.json()).sort()).toEqual(Object.keys(failedDelivery.json()).sort());
    expect(unknown.json().message).toBe(failedDelivery.json().message);
    expect(failedDelivery.json()).not.toHaveProperty("developmentCode");
    expect(JSON.stringify(failedDelivery.json())).not.toContain("private provider response");
    await app.close();
  });
});

function createEmailProvider(
  sendOtp: (input: EmailOtpInput) => Promise<void>,
  exposesDevOtp = false
): EmailProvider {
  return {
    name: "test-email-provider",
    exposesDevOtp,
    sendOtp,
    sendEncryptedMessageNotification: async () => "sent"
  };
}

async function addVerifiedEmail(
  app: ReturnType<typeof buildApi>,
  email: string,
  deliveries: EmailOtpInput[],
  backgroundTasks: Promise<unknown>[]
): Promise<void> {
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    payload: { method: "phone", contact: "+254700002299", pin: "7306" }
  });
  expect(signup.statusCode).toBe(200);
  const cookie = sessionCookie(signup.headers["set-cookie"]);
  const started = await app.inject({
    method: "POST",
    url: "/auth/identity/email/start",
    headers: { cookie },
    payload: { email }
  });
  expect(started.statusCode).toBe(200);
  await backgroundTasks.at(-1);
  const delivery = deliveries.at(-1);
  if (!delivery) throw new Error("Email identity verification code was not delivered.");
  const verified = await app.inject({
    method: "POST",
    url: "/auth/identity/email/verify",
    headers: { cookie },
    payload: { challengeId: delivery.challengeId, code: delivery.code }
  });
  expect(verified.statusCode).toBe(200);
}

function startRecovery(app: ReturnType<typeof buildApi>, email: string) {
  return app.inject({
    method: "POST",
    url: "/auth/recovery/start",
    payload: { type: "email", identifier: email }
  });
}

function verifyRecovery(app: ReturnType<typeof buildApi>, transactionId: string, code: string) {
  return app.inject({
    method: "POST",
    url: "/auth/recovery/verify",
    payload: { transactionId, code }
  });
}

function sessionCookie(setCookie: string | string[] | undefined): string {
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (value === undefined) throw new Error("Session cookie missing.");
  return value.split(";")[0] ?? value;
}
