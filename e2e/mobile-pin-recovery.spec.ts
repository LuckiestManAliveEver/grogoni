import { generateKeyPairSync } from "node:crypto";
import { expect, test } from "@playwright/test";

for (const hasPin of [true, false]) {
  test(`recovers an account with a passkey ${hasPin ? "with" : "without"} an existing PIN`, async ({
    page
  }) => {
    const phone = "+254712345678";
    const mutations: string[] = [];
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true
      }
    });
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    await cdp.send("WebAuthn.addCredential", {
      authenticatorId,
      credential: {
        credentialId: Buffer.from("browser-recovery").toString("base64"),
        isResidentCredential: true,
        rpId: "localhost",
        privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
        userHandle: Buffer.from("recovery-user").toString("base64"),
        signCount: 0
      }
    });
    await page.addInitScript(() => {
      localStorage.setItem("grogoni.marketplace-intro.completed.v1", "true");
    });
    await page.route("http://127.0.0.1:4000/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const json = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (path === "/auth/login/methods")
        return json({
          preferred: "pin",
          deviceAvailable: true,
          passwordFallback: true,
          recoveryAvailable: true,
          smsLogin: false
        });
      if (path === "/auth/pin/login")
        return json({ mfaRequired: true, transactionId: "mfa-test", factors: ["totp"] });
      if (path === "/auth/device/recover")
        throw new Error("Browser recovery must require WebAuthn user verification");
      if (path === "/auth/passkeys/login/options") {
        expect(route.request().postDataJSON()).toEqual({
          purpose: "pin_recovery",
          identifier: phone
        });
        return json({
          ceremonyId: "recovery-ceremony",
          options: {
            challenge: Buffer.from("server-generated-recovery-challenge").toString("base64url"),
            rpId: "localhost",
            userVerification: "required",
            timeout: 60_000
          }
        });
      }
      if (path === "/auth/passkeys/login/verify") {
        const body = route.request().postDataJSON();
        expect(body.ceremonyId).toBe("recovery-ceremony");
        const data = JSON.parse(
          Buffer.from(body.response.response.clientDataJSON, "base64url").toString()
        );
        expect(data.origin).toBe("http://localhost:5173");
        const authenticatorData = Buffer.from(
          body.response.response.authenticatorData,
          "base64url"
        );
        expect(authenticatorData[32]! & 4).toBe(4); // Authenticator must actually verify the user.
        return json({ account: { primaryAuthDestination: phone } });
      }
      if (path === "/auth/credentials/status") return json({ hasPin, hasPassword: true });
      if (path === "/auth/pin/setup" || path === "/auth/pin/recover/device") {
        mutations.push(path);
        expect(route.request().postDataJSON()).toEqual({ pin: "3140", pinConfirmation: "3140" });
        return json({ code: "device_credential_recovery_required", message: "Verify again." }, 403);
      }
      if (path === "/auth/oauth/providers") return json({ providers: [] });
      return json({ code: "auth_session_expired", message: "Authentication is required." }, 401);
    });
    await page.goto("http://localhost:5173/login");
    await page.getByLabel("Phone number", { exact: true }).fill("712345678");
    await page.getByRole("button", { name: "Trouble logging in?", exact: true }).click();
    await expect(page.getByLabel("Recover with")).toBeVisible();
    await page.getByRole("button", { name: "Use account PIN", exact: true }).click();
    await page.getByLabel("4-digit PIN", { exact: true }).fill("3927");
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Security check" })).toBeVisible();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Use your account PIN" })).toBeVisible();
    await page.getByRole("button", { name: "Trouble logging in?", exact: true }).click();
    await page.getByLabel("Recover with").selectOption("email");
    await expect(page.getByLabel("Backup email", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Send email recovery code", exact: true })
    ).toBeDisabled();
    await page.getByLabel("Recover with").selectOption("passkey");
    await expect(page.getByRole("option", { name: "Device security" })).toHaveCount(0);
    await page.getByRole("button", { name: "Recover with passkey", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: hasPin ? "Choose a new PIN" : "Create a PIN", exact: true })
    ).toBeVisible();
    const submit = page.getByRole("button", {
      name: hasPin ? "Save new PIN" : "Create PIN",
      exact: true
    });
    await page.getByLabel("New 4-digit PIN", { exact: true }).fill("3140");
    await page.getByLabel("Confirm new PIN", { exact: true }).fill("6780");
    await expect(submit).toBeDisabled();
    await page.getByLabel("Confirm new PIN", { exact: true }).fill("3140");
    await expect(submit).toBeEnabled();
    if (hasPin) await submit.click();
    else await page.getByLabel("Confirm new PIN", { exact: true }).press("Enter");
    await expect(
      page.getByText("Verify your passkey again before changing your PIN.")
    ).toBeVisible();
    expect(mutations).toEqual([hasPin ? "/auth/pin/recover/device" : "/auth/pin/setup"]);
  });
}
