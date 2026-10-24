import { expect, test } from "@playwright/test";

for (const width of [1280, 390])
  test(`all conversation types restore in the ${width}px main inbox`, async ({ page }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: 900 });
    const session = {
      account: {
        id: "inbox-account",
        primaryAuthChannel: "phone",
        primaryAuthDestination: "+442079460561"
      },
      user: { id: "inbox-user", displayName: "Buyer", language: "en" },
      session: { id: "inbox-session", expiresAt: "2099-01-01T00:00:00Z" }
    };
    const conversations = ["DAEMON", "DIRECT", "BUSINESS"].map((type) => ({
      id: `saved-${type}`,
      accountId: session.account.id,
      conversationType: type,
      kind: type === "BUSINESS" ? "storefront" : "personal",
      activeShopId: type === "BUSINESS" ? "fixture-shop" : null,
      isPermanentDaemon: type === "DAEMON",
      title: `Saved ${type}`,
      hasHumanRecipient: type === "DIRECT",
      createdAt: "2026-10-23T00:00:00Z",
      updatedAt: "2026-10-23T00:00:00Z",
      unreadCount: 0,
      lastMessage: null,
      participant: {
        id: `participant-${type}`,
        conversationId: `saved-${type}`,
        role: "account",
        accountId: session.account.id,
        createdAt: "2026-10-23T00:00:00Z"
      }
    }));
    await page.route("http://127.0.0.1:4000/**", async (route) => {
      const requestUrl = new URL(route.request().url());
      const path = requestUrl.pathname;
      let body: unknown = {},
        status = 200;
      if (path === "/health" || path === "/health/ready") body = { ok: true };
      else if (path === "/session" || path === "/auth/bootstrap") body = session;
      else if (path === "/v1/session/context")
        body = {
          accountId: session.account.id,
          mode: "marketplace",
          activeShopId: null,
          activeSurface: "messenger",
          conversationId: requestUrl.searchParams.get("conversationId") ?? "saved-DAEMON",
          shops: [],
          sessionVersion: 1
        };
      else if (path === "/v1/conversations") body = { conversations };
      else if (path.startsWith("/v1/conversations/saved-") && !path.endsWith("/model")) {
        const id = path.split("/")[3];
        body = {
          conversation: conversations.find((conversation) => conversation.id === id),
          participants: [],
          messages: [],
          channels: [],
          typing: []
        };
      } else if (path === "/v1/shops") body = { shops: [] };
      else if (path === "/businesses") body = { businesses: [] };
      else if (path === "/auth/oauth/providers") body = { providers: [] };
      else if (path === "/v1/marketplace-intro") body = { completedAt: "2026-10-01T00:00:00Z" };
      else if (path === "/v1/e2ee/devices")
        body = { id: "inbox-device", accountId: session.account.id };
      else if (path === "/roles/check") body = { allowed: true };
      else {
        status = 404;
        body = { code: "fixture_unavailable", message: "Not available in this fixture." };
      }
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.addInitScript(() =>
      localStorage.setItem("grogoni.marketplace-intro.completed.v1", "true")
    );
    const verify = async () => {
      if (width < 760) {
        // Open the existing inbox with the same swipe gesture as the mobile navigation regression.
        await page.locator(".messenger-thread").waitFor();
        await page.locator(".messenger-thread").evaluate((thread) => {
          const target = thread.querySelector(".message-list") ?? thread;
          target.dispatchEvent(
            new TouchEvent("touchstart", {
              bubbles: true,
              touches: [new Touch({ identifier: 1, target, clientX: 80, clientY: 250 })]
            })
          );
          target.dispatchEvent(
            new TouchEvent("touchend", {
              bubbles: true,
              touches: [],
              changedTouches: [new Touch({ identifier: 1, target, clientX: 310, clientY: 255 })]
            })
          );
        });
      }
      for (const type of ["DAEMON", "DIRECT", "BUSINESS"])
        await expect(page.locator(`[data-conversation-id="saved-${type}"]`).first()).toBeVisible({
          timeout: 20000
        });
      await expect(page.getByRole("searchbox", { name: "Search conversations" })).toBeVisible();
    };
    await page.goto("/marketplace");
    await verify();
    await page.reload();
    await verify();
    for (const type of ["DIRECT", "BUSINESS"]) {
      await page.locator(`[data-conversation-id="saved-${type}"] .conversation-select`).click();
      await expect(page.locator(".messenger-thread-header")).toContainText(`Saved ${type}`);
      await expect(page.getByTestId("home-welcome")).toHaveCount(0);
      await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveAttribute(
        "placeholder",
        "Write a message"
      );
      await page.reload();
      await expect(page.locator(".messenger-thread-header")).toContainText(`Saved ${type}`);
      await verify();
    }
  });
