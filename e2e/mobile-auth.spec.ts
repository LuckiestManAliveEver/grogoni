import { expect, test } from "@playwright/test";

// Mobile-view sign-up and login journey. Runs only under the mobile-* projects in
// playwright.config.ts (Pixel 7 / iPhone 13), so the desktop certification sweep is not repeated on
// a phone viewport. Same flow and API mocks as e2e/pin-authentication.spec.ts, but asserting the
// screens stay usable (no horizontal overflow) at phone width and capturing the whole journey.
test("signs up and later logs in from the menu in mobile view", async ({ page }) => {
  const phone = "+254712345678";
  const password = "a secure recovery password";
  let sessionActive = false;

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
      expect(request.postDataJSON()).toEqual({ type: "phone", identifier: phone, password });
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
      { message: `The mobile auth test does not provide ${request.method()} ${path}.` },
      404
    );
  });

  await page.addInitScript(() => {
    localStorage.setItem("grogoni.marketplace-intro.completed.v1", "true");
  });

  const homeWelcome = page.getByTestId("home-welcome");
  // Every auth screen must fit a phone viewport without sideways scrolling.
  const expectNoHorizontalOverflow = async () => {
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
  };
  const openMenuItem = async (name: string) => {
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Menu" })
      .getByRole("button", { name, exact: true })
      .click();
  };
  const expectSignedIn = async () => {
    await expect(page).toHaveURL(/\/marketplace$/u);
    await expect(homeWelcome).toBeVisible();
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    const menu = page.getByRole("dialog", { name: "Menu" });
    await expect(menu.getByRole("button", { name: "Log in", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  };

  // Sign up from the menu.
  await page.goto("/marketplace");
  await expect(homeWelcome).toBeVisible();
  await openMenuItem("Sign up");
  await expect(page).toHaveURL(/\/signup$/u);
  await expect(page.getByRole("heading", { name: "Connect with your market" })).toBeVisible();
  await expectNoHorizontalOverflow();

  await page.getByLabel("Phone number", { exact: true }).fill("712345678");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Finish your profile" })).toBeVisible();
  await expectNoHorizontalOverflow();

  await page.getByLabel("Display name").fill("Jane Trader");
  await page.getByPlaceholder("you@example.com").fill("jane@example.com");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByLabel(/I agree to the Terms of Service/u).check();
  await page.getByLabel(/I acknowledge the Privacy Policy/u).check();
  await page.getByRole("button", { name: "Create account", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Secure your account" })).toBeVisible();
  await expectNoHorizontalOverflow();
  await page.getByRole("button", { name: "Do this later" }).click();
  await expectSignedIn();

  // Log out (drop the session), then log back in from the menu.
  sessionActive = false;
  await page.evaluate(() => localStorage.removeItem("grogoni.auth-bootstrap.v1"));
  await page.reload();
  await expect(homeWelcome).toBeVisible();

  await openMenuItem("Log in");
  await expect(page).toHaveURL(/\/login$/u);
  await expect(page.getByText(`Continuing as ${phone}`)).toBeVisible();
  await expectNoHorizontalOverflow();
  await page.getByRole("button", { name: "Continue to log in" }).click();

  await expect(page.getByRole("heading", { name: "Choose how to log in" })).toBeVisible();
  await expectNoHorizontalOverflow();
  await page.getByRole("button", { name: "Use a password" }).click();
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();

  await expectSignedIn();
});
