import { expect, test, type Page } from "@playwright/test";
import { buildShopCapabilities } from "../services/api/src/cp2/domains/shop-hub/capabilities";

async function swipe(page: Page, direction: "left" | "right") {
  await page.locator(".messenger-thread").evaluate((thread, direction) => {
    const x = direction === "right" ? 90 : 300;
    const endX = direction === "right" ? 300 : 90;
    const target = thread.querySelector(".message-list") ?? thread;
    const touch = new Touch({ identifier: 1, target, clientX: x, clientY: 250 });
    target.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [touch] }));
    target.dispatchEvent(
      new TouchEvent("touchend", {
        bubbles: true,
        touches: [],
        changedTouches: [new Touch({ identifier: 1, target, clientX: endX, clientY: 255 })]
      })
    );
  }, direction);
}

for (const mode of ["buyer", "seller"] as const) {
  test(`${mode} mobile swipes preserve the composer and draft`, async ({ page }) => {
    page.on("pageerror", (error) => console.error(error.message));
    await page.route("http://127.0.0.1:4000/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const json = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (mode === "seller") {
        if (path === "/session" || path === "/auth/bootstrap")
          return json({
            account: { id: "mobile-owner-account" },
            user: { id: "mobile-owner", displayName: "Jane", language: "en" },
            session: { id: "mobile-session", expiresAt: "2099-01-01T00:00:00Z" }
          });
        if (path === "/roles/check") return json({ allowed: true });
        if (path === "/v1/session/context") return json({ message: "Unavailable in fixture" }, 404);
        if (path === "/v1/conversations") return json({ conversations: [] });
        if (path === "/v1/e2ee/devices")
          return json({ id: "mobile-device", accountId: "mobile-owner-account" });
        if (path.endsWith("/capabilities"))
          return json(
            buildShopCapabilities({
              businessId: "mobile-shop",
              role: "owner",
              setupStates: {},
              now: new Date("2026-10-23")
            })
          );
      }
      const body =
        path === "/auth/oauth/providers"
          ? { providers: [] }
          : path === "/v1/marketplace-intro"
            ? { completedAt: "2026-10-01T00:00:00Z" }
            : path.includes("storefront")
              ? { storefronts: [] }
              : { code: "auth_session_expired", message: "Authentication is required." };
      await route.fulfill({
        status:
          path === "/session" || path === "/auth/bootstrap"
            ? 401
            : path === "/auth/oauth/providers" ||
                path === "/v1/marketplace-intro" ||
                path.includes("storefront")
              ? 200
              : 404,
        contentType: "application/json",
        body: JSON.stringify(body)
      });
    });
    await page.addInitScript((mode) => {
      localStorage.setItem("grogoni.marketplace-intro.completed.v1", "true");
      if (mode === "seller") {
        localStorage.setItem(
          "grogoni.chatFirst.activeBusiness",
          JSON.stringify({
            id: "mobile-shop",
            name: "Your shop",
            language: "en",
            role: "owner",
            grogoniId: "grogoni.mobile-shop"
          })
        );
        localStorage.setItem("grogoni.chatFirst.mode", "seller");
      }
    }, mode);
    await page.goto(mode === "seller" ? "/sell" : "/marketplace");
    const textbox = page.locator(".composer textarea");
    await expect(textbox).toBeVisible({ timeout: 25_000 });
    await textbox.fill("Keep this draft");
    await textbox.blur();
    await swipe(page, "right");
    const contacts = page.getByRole("region", { name: "Contacts", exact: true });
    await expect(contacts).toBeVisible();
    await expect(contacts.locator(".conversation-list > article").first()).toContainText(
      "Pinned agent"
    );
    await expect(textbox).toBeVisible();
    await expect(textbox).toBeEnabled();
    await textbox.fill("Draft from contacts");
    await page.getByRole("button", { name: "Close Contacts", exact: true }).click();
    await swipe(page, "left");
    const panel = page.locator(".mobile-chat-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(mode === "seller" ? "Your shop" : "Marketplace");
    await expect(textbox).toHaveValue("Draft from contacts");
    const box = await textbox.boundingBox();
    const panelBox = await panel.boundingBox();
    expect(box).not.toBeNull();
    expect(panelBox).not.toBeNull();
    expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(box!.y);
    await textbox.fill("Still editable");
    await page.screenshot({ path: `/tmp/grogoni-mobile-${mode}.png`, fullPage: true });
  });
}
