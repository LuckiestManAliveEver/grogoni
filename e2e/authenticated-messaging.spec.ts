import { expect, test } from "@playwright/test";

test("messaging is locked until the visitor chooses signup or login", async ({ page }) => {
  await page.route("http://127.0.0.1:4000/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body =
      path === "/auth/oauth/providers"
        ? { providers: [] }
        : path === "/v1/marketplace-intro"
          ? { completedAt: null }
          : { code: "auth_session_expired", message: "No active session." };
    const status =
      path === "/auth/bootstrap" || path === "/session"
        ? 401
        : path === "/auth/oauth/providers" || path === "/v1/marketplace-intro"
          ? 200
          : 404;
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body)
    });
  });
  await page.addInitScript(() => {
    localStorage.setItem("grogoni.marketplace-intro.completed.v1", "true");
  });
  // Zero-form entry (docs/authentication/progressive-identity.md): a non-deliberate cold boot at
  // /marketplace lands straight on the chat shell, not behind a "choose guest/signup/login"
  // screen. The home has no auth buttons in the header or welcome; signing in starts from the
  // shop icon (a shop needs an account) or the hamburger menu.
  await page.goto("/marketplace");

  const homeWelcome = page.getByTestId("home-welcome");
  await expect(homeWelcome).toBeVisible();
  await expect(page.getByTestId("header-login-button")).toHaveCount(0);

  await page.getByTestId("shop-entry-button").click();
  await expect(page).toHaveURL(/\/signup$/u);
  await expect(page.getByRole("heading", { name: "Connect with your market" })).toBeVisible();
  await expect(page.locator('input[autocomplete="one-time-code"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Continue to marketplace as guest" }).click();
  await expect(homeWelcome).toBeVisible();

  await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Menu" })
    .getByRole("button", { name: "Log in", exact: true })
    .click();
  await expect(page).toHaveURL(/\/login$/u);
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
});
