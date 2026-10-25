import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { PhoneFirstAuthentication } from "../apps/web/src/PhoneFirstAuthentication";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

describe("mobile-only account access", () => {
  it("rejects email and storefront signup/login including legacy OTP entry points", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    for (const [url, payload] of [
      ["/auth/signup/start", { type: "email", identifier: "owner@example.com" }],
      ["/auth/login/methods", { type: "email", identifier: "owner@example.com" }],
      [
        "/auth/login/password",
        { type: "email", identifier: "owner@example.com", password: "secure account password" }
      ],
      ["/auth/pin/login", { method: "email", contact: "owner@example.com", pin: "2468" }],
      ["/auth/pin/continue", { method: "email", contact: "owner@example.com", pin: "2468" }],
      ["/auth/pin/store-login", { grogoniId: "grogoni.shop", pin: "2468" }],
      ["/auth/email/request-otp", { contact: "owner@example.com" }],
      ["/auth/otp/verify", { challengeId: "legacy", code: "123456" }]
    ] as const) {
      const response = await app.inject({ method: "POST", url, payload });
      expect(response.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(response.headers["set-cookie"], url).toBeUndefined();
    }
    expect(store.snapshot().accounts).toHaveLength(0);
    await app.close();
  });

  it("does not reuse a remembered email account or display alternate identifier controls", () => {
    const html = renderToStaticMarkup(
      createElement(PhoneFirstAuthentication, {
        remembered: { type: "email", identifier: "legacy@example.com", label: "Legacy email" },
        onAuthenticated() {},
        onSignUp() {},
        onForgetRemembered() {},
        onCancel() {}
      })
    );
    expect(html).not.toContain("legacy@example.com");
    expect(html).not.toContain("Grogoni ID");
    expect(html).not.toContain('type="email"');
    expect(html).toContain('type="tel"');
  });

  it("requires single-use verified email MFA after PIN verification", async () => {
    const source = createCp2Store();
    const session = source.signupWithPhonePin({ destination: "+254711111111", pin: "2468" });
    const snapshot = source.snapshot();
    snapshot.accountIdentities = [
      ...(snapshot.accountIdentities ?? []),
      {
        id: "backup-email",
        accountId: session.account.id,
        userId: session.user.id,
        displayValue: "backup@example.com",
        isPrimary: false,
        updatedAt: new Date().toISOString(),
        type: "email",
        normalizedValue: "backup@example.com",
        verifiedAt: new Date().toISOString(),
        createdAt: new Date().toISOString()
      }
    ];
    const store = createCp2Store();
    store.hydrateSnapshot(snapshot);
    const app = buildApi({ cp2: { store } });
    const login = await app.inject({
      method: "POST",
      url: "/auth/pin/login",
      payload: { method: "phone", contact: "+254711111111", pin: "2468" }
    });
    expect(login.statusCode).toBe(202);
    expect(login.headers["set-cookie"]).toBeUndefined();
    const { transactionId } = login.json();
    const challenge = await app.inject({
      method: "POST",
      url: "/auth/mfa/email/challenge",
      payload: { transactionId }
    });
    expect(challenge.statusCode).toBe(200);
    const payload = { transactionId, factor: "email", code: challenge.json().developmentCode };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/auth/mfa/verify",
          payload: { ...payload, code: "incorrect" }
        })
      ).statusCode
    ).toBe(401);
    const verified = await app.inject({ method: "POST", url: "/auth/mfa/verify", payload });
    expect(verified.statusCode).toBe(200);
    expect(verified.headers["set-cookie"]).toBeDefined();
    expect(
      (await app.inject({ method: "POST", url: "/auth/mfa/verify", payload })).statusCode
    ).toBe(400);
    await app.close();
  });
});
