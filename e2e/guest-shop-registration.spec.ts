import { expect, test, type Page } from "@playwright/test";

const guestSession = {
  authenticated: true,
  account: { id: "guest-account", identityLevel: "device", primaryAuthChannel: "device" },
  user: { id: "guest-user", displayName: "Guest", language: "en", phoneNumberE164: null },
  session: { expiresAt: "2099-01-01T00:00:00.000Z" },
  deviceSession: { id: "guest-device" }
};

async function mockGuest(page: Page) {
  const created: Array<Record<string, unknown>> = [];
  await page.route("http://127.0.0.1:4000/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/session" || path === "/auth/bootstrap") return json(guestSession);
    if (path === "/v1/session/context") {
      return json({
        accountId: "guest-account",
        userId: "guest-user",
        sessionId: "guest-session",
        conversationId: "guest-conversation",
        activeShopId: null,
        agentId: "agent",
        activeModelId: "model",
        mode: "marketplace",
        activeSurface: "chat",
        permissions: [],
        sessionVersion: 1,
        shops: []
      });
    }
    if (path === "/auth/oauth/providers") return json({ providers: [] });
    if (path === "/roles/check") return json({ allowed: true });
    if (path === "/v1/marketplace-intro") return json({ completedAt: "2026-07-17T00:00:00.000Z" });
    if (path === "/v1/conversations" && request.method() === "GET") {
      return json({ conversations: [] });
    }
    if (path === "/v1/e2ee/devices") return json({ id: "device", accountId: "guest-account" });
    if (path === "/account/phone") {
      return json({ user: { ...guestSession.user, phoneNumberE164: "+254712345678" } });
    }
    if (path === "/businesses" && request.method() === "POST") {
      created.push(request.postDataJSON() as Record<string, unknown>);
      return json({
        business: { id: "guest-shop", name: "Mama Mboga", language: "en", grogoniId: "G1" },
        membership: { role: "owner" }
      });
    }
    return json({ message: `The test does not provide ${request.method()} ${path}.` }, 404);
  });
  await page.addInitScript(() => {
    localStorage.setItem("grogoni.marketplace-intro.completed.v1", "true");
  });
  return created;
}

test("a guest registers a shop from navigation, with no signup", async ({ page }) => {
  const created = await mockGuest(page);
  await page.goto("/marketplace");
  await page.getByTestId("shop-entry-button").click();
  await expect(page.getByRole("heading", { name: "Add your phone number" })).toBeVisible();
  await page.getByLabel("Phone number").fill("254712345678");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Set up your business" })).toBeVisible();
  await page.getByLabel("Business name").fill("Mama Mboga");
  await page.getByRole("button", { name: "Create business" }).click();
  await expect.poll(() => created.length).toBe(1);
  expect(created[0]).toMatchObject({ name: "Mama Mboga" });
  await expect(page.getByRole("heading", { name: "Set up your business" })).toBeHidden();
});

test("a guest registers a shop by asking the marketplace agent", async ({ page }) => {
  const created = await mockGuest(page);
  await page.goto("/marketplace");
  const composer = page.getByLabel("Message", { exact: true });
  const say = async (text: string) => {
    await composer.fill(text);
    await composer.press("Enter");
  };
  await say("I want to open a shop");
  await expect(page.getByText("What is it called?")).toBeVisible();
  await say("Mama Mboga");
  await expect(page.getByText("Which phone number should Mama Mboga use?")).toBeVisible();
  await say("0712345678");
  await expect(page.getByText("Reply yes to create it.")).toBeVisible();
  expect(created).toHaveLength(0);
  await say("yes");
  await expect.poll(() => created.length).toBe(1);
  expect(created[0]).toMatchObject({
    name: "Mama Mboga",
    phoneNumber: "+254712345678",
    phoneCountry: "KE",
    viaAssistant: true
  });
});

test("a reminder ends a pending registration, so its answer creates nothing", async ({ page }) => {
  const created = await mockGuest(page);
  await page.goto("/marketplace");
  const composer = page.getByLabel("Message", { exact: true });
  const say = async (text: string) => {
    await composer.fill(text);
    await composer.press("Enter");
  };
  await say("open a shop");
  await expect(page.getByText("What is it called?")).toBeVisible();
  await say("Mama Mboga");
  await expect(page.getByText("Which phone number should Mama Mboga use?")).toBeVisible();
  await say("0712345678");
  await expect(page.getByText("Reply yes to create it.")).toBeVisible();
  await say("remind me to call mama at 8am");
  await expect(page.getByText("When should I remind you?")).toBeVisible();
  await say("ok");
  await page.waitForTimeout(500);
  expect(created).toHaveLength(0);
});

test("a guest shop owner is asked to add a way back in", async ({ page }) => {
  await mockGuest(page);
  const pins: unknown[] = [];
  await page.route("http://127.0.0.1:4000/auth/pin/setup", async (route) => {
    pins.push(route.request().postDataJSON());
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...guestSession,
        account: { ...guestSession.account, identityLevel: "strong" }
      })
    });
  });
  await page.goto("/marketplace");
  await page.getByTestId("shop-entry-button").click();
  await page.getByLabel("Phone number").fill("254712345678");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel("Business name").fill("Mama Mboga");
  await page.getByRole("button", { name: "Create business" }).click();
  const prompt = page.getByRole("region", { name: "Secure your shop" });
  await expect(prompt).toBeVisible();
  await prompt.getByLabel("Or create a 4-digit PIN").fill("4826");
  await prompt.getByRole("button", { name: "Create PIN", exact: true }).click();
  await expect.poll(() => pins).toEqual([{ pin: "4826", pinConfirmation: "4826" }]);
});
