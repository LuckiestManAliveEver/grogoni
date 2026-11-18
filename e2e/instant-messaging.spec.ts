import { expect, test } from "@playwright/test";
import { buildShopCapabilities } from "../services/api/src/cp2/domains/shop-hub/capabilities";

// Controlled transport gates. These numbers describe the browser under injected latency,
// never production API or carrier latency.
for (const [profile, ackDelayMs] of [
  ["normal", 50],
  ["mobile-300ms", 300],
  ["slow-server", 1500]
] as const) {
  test(`composer accepts two messages before replies on ${profile}`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    page.on("pageerror", (error) => console.error(error.message));
    await page.setViewportSize({ width: 360, height: 800 });
    const business = {
      id: "instant-shop",
      name: "Fixture shop",
      language: "en",
      role: "owner",
      grogoniId: "instant-shop"
    };
    const session = {
      account: { id: "instant-account" },
      user: { id: "instant-user", displayName: "Owner", language: "en" },
      session: { id: "instant-session", expiresAt: "2099-01-01T00:00:00Z" }
    };
    const conversation = {
      id: "instant-chat",
      accountId: "instant-account",
      kind: "personal",
      conversationType: "DAEMON",
      activeShopId: business.id,
      title: "Fixture session",
      hasHumanRecipient: false,
      isPermanentDaemon: false,
      createdAt: "2026-11-18T00:00:00Z",
      updatedAt: "2026-11-18T00:00:00Z",
      lastMessage: null,
      unreadCount: 0,
      participant: { id: "instant-participant", role: "account", accountId: "instant-account" }
    };
    const messages: unknown[] = [];
    const submitted: string[] = [];
    await page.route("http://127.0.0.1:4000/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const json = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (["/health", "/health/ready"].includes(path)) return json({ ok: true });
      if (["/session", "/auth/bootstrap"].includes(path)) return json(session);
      if (path === "/v1/session/context")
        return json({
          accountId: "instant-account",
          mode: "seller",
          activeShopId: business.id,
          activeSurface: "messenger",
          conversationId: conversation.id,
          shops: [
            {
              business,
              membership: { role: "owner", businessId: business.id, userId: "instant-user" }
            }
          ],
          sessionVersion: 1
        });
      if (path === "/businesses")
        return json({
          businesses: [
            {
              business,
              membership: { role: "owner", businessId: business.id, userId: "instant-user" }
            }
          ]
        });
      if (path === "/v1/conversations") return json({ conversations: [conversation] });
      if (path === `/v1/conversations/${conversation.id}`)
        return json({ conversation, participants: [], messages, typing: [], channels: [] });
      if (path.endsWith("/runtime/sessions"))
        return json(
          request.method() === "POST"
            ? {
                id: "instant-runtime",
                businessId: business.id,
                conversationId: conversation.id,
                status: "active",
                turnCount: 0
              }
            : []
        );
      if (path === "/v1/messages") {
        const payload = request.postDataJSON();
        submitted.push(payload.clientMessageId);
        await new Promise((resolve) => setTimeout(resolve, ackDelayMs));
        const message = {
          id: `server-${payload.clientMessageId}`,
          conversationId: conversation.id,
          clientMessageId: payload.clientMessageId,
          author: "user",
          authorId: "instant-user",
          content: payload.content,
          status: "sent",
          createdAt: payload.clientTimestamp,
          deletedAt: null,
          replyToMessageId: null,
          reactions: []
        };
        messages.push(message);
        return json({
          ...message,
          processing: {
            correlationId: message.id,
            turnId: message.id,
            status: "pending",
            errorCode: null,
            retryable: false
          }
        });
      }
      if (path.startsWith("/v1/agent-turns/"))
        return json({
          processing: {
            correlationId: path.split("/").at(-1),
            turnId: path.split("/").at(-1),
            status: "pending",
            errorCode: null,
            retryable: false
          }
        });
      if (path.endsWith("/capabilities"))
        return json(
          buildShopCapabilities({
            businessId: business.id,
            role: "owner",
            setupStates: {},
            now: new Date("2026-11-18")
          })
        );
      if (path === "/roles/check") return json({ allowed: true });
      if (path === "/v1/e2ee/devices")
        return json({ id: "instant-device", accountId: "instant-account" });
      if (path === "/auth/oauth/providers") return json({ providers: [] });
      if (path === "/v1/marketplace-intro") return json({ completedAt: "2026-11-18T00:00:00Z" });
      return json({ code: "fixture_unavailable", message: "Unavailable in fixture." }, 404);
    });
    await page.addInitScript((business) => {
      localStorage.setItem("grogoni.marketplace-intro.completed.v1", "true");
      localStorage.setItem("grogoni.chatFirst.activeBusiness", JSON.stringify(business));
      localStorage.setItem("grogoni.chatFirst.mode", "seller");
    }, business);
    await page.goto(`/workspace/conversations/${conversation.id}`);
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(composer).toBeVisible({ timeout: 25_000 });
    await expect(page.locator(".messenger-thread-header")).toContainText("Fixture session");
    await composer.fill("First fixture question");
    await composer.press("Enter");
    await expect(page.locator(".message-list")).toContainText("First fixture question");
    await expect(composer).toBeEnabled();
    await composer.fill("Second fixture question");
    await composer.press("Enter");
    await expect(page.locator(".message-list")).toContainText("Second fixture question");
    await expect.poll(() => submitted.length).toBe(2);
    expect(new Set(submitted).size).toBe(2);
    const measurements = await page.evaluate(() =>
      performance.getEntriesByName("message.send.accepted_ms").map((entry) => entry.duration)
    );
    expect(measurements).toHaveLength(2);
    expect(Math.max(...measurements)).toBeLessThan(100);
    await testInfo.attach("controlled-acceptance-metrics.json", {
      body: JSON.stringify({ profile, ackDelayMs, acceptedMs: measurements }),
      contentType: "application/json"
    });
  });
}
