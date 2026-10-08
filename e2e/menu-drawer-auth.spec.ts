import { expect, test, type Page } from "@playwright/test";

// The customer home has no header Log in / Sign up (unified-chat spec), so the hamburger menu is
// a signed-out visitor's always-reachable way in. Covers the three session states the shell
// distinguishes: none, a device-only session (real but not an account identity), and a full one,
// plus a device account that already owns a shop (a login there would replace the shop's owner).
type SessionState = "none" | "device" | "account";

async function mockApi(page: Page, sessionState: SessionState) {
  await page.route("http://127.0.0.1:4000/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/session" || path === "/auth/bootstrap") {
      if (sessionState === "none") return json({ message: "Not signed in." }, 401);
      return json({
        authenticated: true,
        account: {
          id: "menu-auth-account",
          identityLevel: sessionState === "device" ? "device" : "verified_contact"
        },
        user: { id: "menu-auth-user", displayName: "Menu Visitor", language: "en" },
        session: { expiresAt: "2099-01-01T00:00:00.000Z" },
        deviceSession: { id: "menu-auth-device" }
      });
    }
    if (path === "/auth/oauth/providers") return json({ providers: [] });
    if (path === "/roles/check") return json({ allowed: true });
    if (path === "/v1/marketplace-intro") {
      return json({ completedAt: "2026-07-17T00:00:00.000Z" });
    }
    if (path === "/v1/conversations" && request.method() === "GET") {
      return json({ conversations: [] });
    }
    return json({ message: `The test does not provide ${request.method()} ${path}.` }, 404);
  });
  await page.addInitScript(() => {
    localStorage.setItem("grogoni.marketplace-intro.completed.v1", "true");
  });
}

async function openMenu(page: Page) {
  await page.getByRole("button", { name: "Open menu", exact: true }).click();
  return page.getByRole("dialog", { name: "Menu" });
}

for (const sessionState of ["none", "device"] as const) {
  test(`menu Log in and Sign up open their screens (session: ${sessionState})`, async ({
    page
  }) => {
    await mockApi(page, sessionState);
    await page.goto("/");

    let menu = await openMenu(page);
    await expect(menu.getByRole("button")).toContainText(["Log in", "Sign up"]);
    await menu.getByRole("button", { name: "Log in", exact: true }).click();
    await expect(page).toHaveURL(/\/login$/u);
    await expect(page.getByRole("dialog", { name: "Menu" })).toHaveCount(0);
    await expect(page.locator("#auth-onboarding-title")).toBeVisible();

    await page.goto("/");
    menu = await openMenu(page);
    await menu.getByRole("button", { name: "Sign up", exact: true }).click();
    await expect(page).toHaveURL(/\/signup$/u);
    await expect(page.locator("#signup-title")).toHaveText("Connect with your market");
  });
}

test("a signed-in account sees no Log in / Sign up in the menu", async ({ page }) => {
  await mockApi(page, "account");
  await page.goto("/");
  const menu = await openMenu(page);
  await expect(menu.getByRole("button", { name: "Message history", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Log in", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("button", { name: "Sign up", exact: true })).toHaveCount(0);
});

function rememberPhoneLogin(page: Page) {
  return page.addInitScript(() => {
    localStorage.setItem(
      "grogoni.chatFirst.ownerAuth",
      JSON.stringify({ contact: "+254712345678", countryCode: "+254" })
    );
  });
}

test("a device session on a device that remembers a phone login gets the recognized-device pill", async ({
  page
}) => {
  await mockApi(page, "device");
  await rememberPhoneLogin(page);
  await page.goto("/");
  await expect(page.locator(".recognized-device-pill")).toBeVisible();
});

test("a device account that owns a shop gets no Log in / Sign up anywhere", async ({ page }) => {
  await mockApi(page, "device");
  await rememberPhoneLogin(page);
  await page.addInitScript(() => {
    localStorage.setItem(
      "grogoni.chatFirst.activeBusiness",
      JSON.stringify({
        id: "device-shop",
        name: "Device Shop",
        language: "en",
        role: "owner",
        grogoniId: "grogoni.device-shop"
      })
    );
  });
  await page.goto("/");
  const menu = await openMenu(page);
  await expect(menu.getByRole("button", { name: "Go to my shop", exact: true })).toBeVisible();
  await expect(page.locator(".recognized-device-pill")).toHaveCount(0);
  await expect(menu.getByRole("button", { name: "Log in", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("button", { name: "Sign up", exact: true })).toHaveCount(0);
});

test("a stale stored shop from a failed ownership check clears on reconnect and Log in returns", async ({
  page
}) => {
  // The stored shop belongs to a previous account, not this device session. With the server
  // failing, neither /roles/check nor /v1/session/context can say so, so the shop stays and Log in
  // stays hidden. Once the device reconnects, the session context loads, shows the account has no
  // shop, and the sign-in entry comes back without a reload.
  await mockApi(page, "device");
  let serverHealthy = false;
  await page.route("http://127.0.0.1:4000/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path !== "/roles/check" && path !== "/v1/session/context") return route.fallback();
    if (!serverHealthy) {
      return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    }
    if (path === "/roles/check") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ allowed: false })
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accountId: "menu-auth-account",
        userId: "menu-auth-user",
        sessionId: "menu-auth-session",
        // The server's last place differs from where the user is; a retry must not move them.
        conversationId: "server-last-conversation",
        activeShopId: null,
        agentId: "grogoni",
        activeModelId: "local",
        mode: "marketplace",
        activeSurface: "conversation",
        permissions: [],
        sessionVersion: 1,
        shops: []
      })
    });
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      "grogoni.chatFirst.activeBusiness",
      JSON.stringify({
        id: "previous-account-shop",
        name: "Previous Account Shop",
        language: "en",
        role: "owner",
        grogoniId: "grogoni.previous-account-shop"
      })
    );
  });
  await page.goto("/");

  let menu = await openMenu(page);
  await expect(menu.getByRole("button", { name: "Go to my shop", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Log in", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  serverHealthy = true;
  await page.context().setOffline(true);
  await page.context().setOffline(false);

  menu = await openMenu(page);
  await expect(menu.getByRole("button", { name: "Log in", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Set up your shop", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/u);
});
