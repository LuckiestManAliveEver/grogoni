import { expect, test } from "@playwright/test";

test("signs up with a profile and later logs in from the welcome message", async ({ page }) => {
  const phone = "+254712345678";
  const password = "a secure recovery password";
  let sessionActive = false;
  let signupStartCount = 0;
  let signupCompleteCount = 0;
  let loginCount = 0;

  const session = {
    account: {
      id: "pin-browser-account",
      primaryAuthChannel: "phone",
      primaryAuthDestination: phone
    },
    user: { id: "pin-browser-user", displayName: "Trader 5678", language: "en" },
    session: {
      id: "pin-browser-session",
      absoluteExpiresAt: "2099-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z"
    }
  };

  await page.route("http://127.0.0.1:4000/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/auth/oauth/providers") return json({ providers: [] });
    if (path === "/session" || path === "/auth/bootstrap") {
      return sessionActive
        ? json(session)
        : json({ code: "auth_session_expired", message: "Authentication is required." }, 401);
    }
    if (path === "/v1/marketplace-intro") return json({ completedAt: null });
    if (path === "/auth/signup/start" && request.method() === "POST") {
      expect(request.postDataJSON()).toEqual({
        type: "phone",
        identifier: phone,
        country: "KE"
      });
      signupStartCount += 1;
      return json({
        transactionId: "signup-transaction",
        expiresAt: "2099-01-01T00:00:00.000Z",
        verificationRequired: false
      });
    }
    if (path === "/auth/signup/complete" && request.method() === "POST") {
      expect(request.postDataJSON()).toEqual({
        transactionId: "signup-transaction",
        displayName: "Jane Trader",
        email: "jane@example.com",
        password,
        passwordConfirmation: password,
        termsAccepted: true,
        privacyAccepted: true
      });
      signupCompleteCount += 1;
      sessionActive = true;
      return json(session);
    }
    if (path === "/auth/login/methods" && request.method() === "POST") {
      expect(request.postDataJSON()).toEqual({ type: "phone", identifier: phone });
      return json({
        preferred: "pin",
        passkeyAvailable: true,
        passwordFallback: true,
        recoveryAvailable: true,
        smsLogin: false
      });
    }
    if (path === "/auth/login/password" && request.method() === "POST") {
      expect(request.postDataJSON()).toEqual({
        type: "phone",
        identifier: phone,
        password
      });
      loginCount += 1;
      sessionActive = true;
      return json(session);
    }
    if (path === "/v1/e2ee/devices" && request.method() === "POST") {
      return json({ id: "pin-browser-device", accountId: session.account.id });
    }
    if (path === "/v1/conversations" && request.method() === "GET") {
      return json({ conversations: [] });
    }

    return json(
      { message: `The PIN auth test does not provide ${request.method()} ${path}.` },
      404
    );
  });

  await page.addInitScript(() => {
    localStorage.setItem("grogoni.marketplace-intro.completed.v1", "true");
  });
  // Zero-form entry (docs/authentication/progressive-identity.md): a non-deliberate cold boot at
  // /marketplace lands straight on the chat shell with its inline welcome message, not behind a
  // separate "choose guest/signup/login" screen - there is no "Continue to marketplace as guest"
  // button to click before the welcome message appears.
  await page.goto("/marketplace");

  const welcome = page.getByTestId("welcome-message");
  await expect(welcome).toBeVisible();
  await expect(page.getByTestId("welcome-signup-button")).toBeVisible();
  await expect(page.getByTestId("welcome-login-button")).toBeVisible();

  await page.getByTestId("welcome-signup-button").click();
  await expect(page).toHaveURL(/\/signup$/u);
  await expect(page.getByRole("heading", { name: "Connect with your market" })).toBeVisible();
  await page.getByLabel("Phone number", { exact: true }).fill("712345678");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect.poll(() => signupStartCount).toBe(1);
  await expect(page.getByRole("heading", { name: "Finish your profile" })).toBeVisible();
  await page.getByLabel("Display name").fill("Jane Trader");
  await page.getByLabel(/Email address/u).fill("jane@example.com");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByLabel(/I agree to the Terms of Service/u).check();
  await page.getByLabel(/I acknowledge the Privacy Policy/u).check();
  await page.getByRole("button", { name: "Create account", exact: true }).click();

  await expect.poll(() => signupCompleteCount).toBe(1);
  await expect(page.getByRole("heading", { name: "Secure your account" })).toBeVisible();
  await page.getByRole("button", { name: "Do this later" }).click();
  await expect(page.getByText("Authentication complete", { exact: true })).toBeVisible();

  sessionActive = false;
  await page.evaluate(() => localStorage.removeItem("grogoni.auth-bootstrap.v1"));
  await page.reload();

  // A non-deliberate reload never auto-navigates to /login, even once the session is invalid
  // (docs/authentication/progressive-identity.md) - it lands back on the chat shell's welcome
  // message, same as any other cold boot. The phone number is still remembered separately (in
  // grogoni.chatFirst.ownerAuth, untouched above) once the visitor deliberately taps Log in.
  await expect(welcome).toBeVisible();
  await page.getByTestId("welcome-login-button").click();
  await expect(page).toHaveURL(/\/login$/u);
  await expect(page.getByText(`Continuing as ${phone}`)).toBeVisible();
  await page.getByRole("button", { name: "Continue to log in" }).click();
  await expect(page.getByRole("heading", { name: "Choose how to log in" })).toBeVisible();
  await page.getByRole("button", { name: "Use a password" }).click();
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();

  await expect.poll(() => loginCount).toBe(1);
  await expect(page.getByText("Authentication complete", { exact: true })).toBeVisible();
});
