import { expect, test, type Locator, type Page } from "@playwright/test";

test("a signed-in account registers its first shop without OTP", async ({ page }) => {
  let createBusinessBody: Record<string, unknown> | null = null;

  await page.route("http://127.0.0.1:4000/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/session" || path === "/auth/bootstrap") {
      return json({
        account: { id: "first-shop-account" },
        user: {
          id: "first-shop-user",
          displayName: "First Shop Owner",
          language: "en",
          phoneNumberE164: "+254712345678",
          phoneCountryCode: "KE",
          phoneNationalNumber: "712345678",
          phoneVerificationStatus: "unverified",
          phoneSource: "shop_registration",
          publicPhoneEnabled: false
        },
        session: { expiresAt: "2099-01-01T00:00:00.000Z" }
      });
    }
    if (path === "/auth/oauth/providers") return json({ providers: [] });
    if (path === "/v1/marketplace-intro") {
      return json({ completedAt: "2026-07-17T00:00:00.000Z" });
    }
    if (path === "/v1/conversations" && request.method() === "GET") {
      return json({ conversations: [] });
    }
    if (path === "/v1/e2ee/devices" && request.method() === "POST") {
      return json({ id: "first-shop-device", accountId: "first-shop-account" });
    }
    if (path === "/businesses" && request.method() === "POST") {
      createBusinessBody = request.postDataJSON() as Record<string, unknown>;
      return json({
        business: {
          id: "first-shop",
          name: "No OTP Shop",
          language: "en",
          grogoniId: "254A00000001"
        },
        membership: { role: "owner" }
      });
    }

    return json({ message: `The test does not provide ${request.method()} ${path}.` }, 404);
  });

  await page.addInitScript(() => {
    localStorage.setItem("grogoni.marketplace-intro.completed.v1", "true");
  });
  await page.goto("/marketplace");
  await page.getByTestId("shop-entry-button").click();

  await expect(page.getByRole("heading", { name: "Set up your business" })).toBeVisible();
  await expect(
    page.getByText(
      "Create your shop once using your signed-in account. You can update these details later.",
      { exact: true }
    )
  ).toBeVisible();
  await expect(page.locator('input[autocomplete="one-time-code"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Send (SMS|email) code/ })).toHaveCount(0);

  await page.getByLabel("Business name").fill("No OTP Shop");
  await page.getByRole("button", { name: "Create business" }).click();

  await expect
    .poll(() => createBusinessBody)
    .toEqual({
      name: "No OTP Shop",
      language: "en",
      phoneNumber: "+254712345678",
      phoneCountry: "KE"
    });
  await expect(page.getByRole("heading", { name: "Set up your business" })).toBeHidden();
});

// Mouse clicks and touch taps reach Continue differently. Both used to be at risk of losing the
// first press: the phone field's blur check inserted a line above Continue and moved it mid-press.
async function captureOwnerPhone(page: Page, press: (target: Locator) => Promise<void>) {
  let savedPhoneBody: Record<string, unknown> | null = null;
  let otpRequests = 0;
  const user = {
    id: "phone-capture-user",
    displayName: "Phone Capture Owner",
    language: "en",
    phoneNumberE164: null,
    phoneCountryCode: null,
    phoneNationalNumber: null,
    phoneVerificationStatus: null,
    phoneSource: null,
    publicPhoneEnabled: false
  };

  await page.route("http://127.0.0.1:4000/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path.startsWith("/auth/otp/")) {
      otpRequests += 1;
      return json({ message: "OTP must not be used for shop phone capture." }, 500);
    }
    if (path === "/auth/oauth/providers") return json({ providers: [] });
    if (path === "/session" || path === "/auth/bootstrap") {
      return json({
        account: {
          id: "phone-capture-account",
          primaryAuthChannel: "email",
          primaryAuthDestination: "phone-capture@example.test"
        },
        user,
        session: { expiresAt: "2099-01-01T00:00:00.000Z" }
      });
    }
    if (path === "/v1/marketplace-intro") {
      return json({ completedAt: "2026-07-17T00:00:00.000Z" });
    }
    if (path === "/v1/conversations" && request.method() === "GET") {
      return json({ conversations: [] });
    }
    if (path === "/v1/e2ee/devices" && request.method() === "POST") {
      return json({ id: "phone-capture-device", accountId: "phone-capture-account" });
    }
    if (path === "/account/phone" && request.method() === "PUT") {
      savedPhoneBody = request.postDataJSON() as Record<string, unknown>;
      Object.assign(user, {
        phoneNumberE164: "+254712345678",
        phoneCountryCode: "KE",
        phoneNationalNumber: "712345678",
        phoneVerificationStatus: "unverified",
        phoneSource: "shop_registration"
      });
      return json({ user });
    }

    return json({ message: `The test does not provide ${request.method()} ${path}.` }, 404);
  });

  await page.addInitScript(() => {
    localStorage.setItem("grogoni.marketplace-intro.completed.v1", "true");
  });
  await page.goto("/marketplace");
  await page.getByTestId("shop-entry-button").click();

  await expect(page.getByRole("heading", { name: "Add your phone number" })).toBeVisible();
  const continueButton = page.getByRole("button", { name: "Continue", exact: true });
  await expect(continueButton).toBeDisabled();
  await page.getByLabel("Phone number").fill("123");
  await press(continueButton);
  await expect(page.getByRole("alert")).toHaveText("The phone number is too short.");

  await page.getByLabel("Phone number").fill("254712345678");
  await press(continueButton);

  await expect.poll(() => savedPhoneBody).toEqual({ phoneNumber: "+254712345678", country: "KE" });
  await expect(page.getByRole("heading", { name: "Set up your business" })).toBeVisible();
  expect(otpRequests).toBe(0);
}

test("captures and normalizes the compulsory owner phone without SMS", async ({ page }) => {
  await captureOwnerPhone(page, (target) => target.click());
});

test.describe("on a touch phone", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("captures the owner phone with a single tap on Continue", async ({ page }) => {
    await captureOwnerPhone(page, (target) => target.tap());
  });
});
