import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { expect } from "vitest";
import type { Cp2Store } from "../../services/api/src/cp2/store";

export function fixturePhone(label: string): string {
  const digits = parseInt(createHash("sha256").update(label).digest("hex").slice(0, 8), 16);
  return `+2547${String(digits % 100_000_000).padStart(8, "0")}`;
}

export function sessionCookie(header: string | string[] | undefined): string {
  return (Array.isArray(header) ? header : header ? [header] : [])
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

export async function signupPhone(app: FastifyInstance, label: string, pin = "1234") {
  const phone = fixturePhone(label);
  const response = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    payload: { method: "phone", contact: phone, pin }
  });
  expect(response.statusCode, response.body).toBe(200);
  return { phone, response, cookie: sessionCookie(response.headers["set-cookie"]) };
}

export async function signupWithBackupEmail(app: FastifyInstance, email: string) {
  const account = await signupPhone(app, email);
  const started = await app.inject({
    method: "POST",
    url: "/auth/identity/email/start",
    headers: { cookie: account.cookie },
    payload: { email }
  });
  expect(started.statusCode, started.body).toBe(200);
  const challenge = started.json<{ challengeId: string; developmentCode: string }>();
  const verified = await app.inject({
    method: "POST",
    url: "/auth/identity/email/verify",
    headers: { cookie: account.cookie },
    payload: { challengeId: challenge.challengeId, code: challenge.developmentCode }
  });
  expect(verified.statusCode, verified.body).toBe(200);
  return account;
}

/** Migrated email-only accounts still exist in snapshots, but cannot sign up via HTTP OTP. */
export function seedLegacyEmailAccount(store: Cp2Store, email: string) {
  const challenge = store.requestOtp({ channel: "email", destination: email });
  return store.verifyOtp({ challengeId: challenge.challengeId, code: challenge.devOtp });
}

export async function completeEmailMfa(app: FastifyInstance, transactionId: string) {
  const challenge = await app.inject({
    method: "POST",
    url: "/auth/mfa/email/challenge",
    payload: { transactionId }
  });
  expect(challenge.statusCode, challenge.body).toBe(200);
  const verified = await app.inject({
    method: "POST",
    url: "/auth/mfa/verify",
    payload: {
      transactionId,
      factor: "email",
      code: challenge.json<{ developmentCode: string }>().developmentCode
    }
  });
  expect(verified.statusCode, verified.body).toBe(200);
  return verified;
}
