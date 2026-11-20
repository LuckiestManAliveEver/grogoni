import { expect, test, type Page } from "@playwright/test";
import { buildShopCapabilities } from "../services/api/src/cp2/domains/shop-hub/capabilities";

/**
 * Browser certification for instant messaging (docs/audits/instant-messaging-remaining-2026-11-19.md,
 * section 3): offline queueing that survives a reload, manual retry with the same clientMessageId,
 * ordering, session restore after reload and session switching. The API is a route fixture; the
 * timings it injects describe the browser, never production latency.
 */

const business = {
  id: "cert-shop",
  name: "Fixture shop",
  language: "en",
  role: "owner",
  grogoniId: "cert-shop"
};
const session = {
  account: { id: "cert-account" },
  user: { id: "cert-user", displayName: "Owner", language: "en" },
  session: { id: "cert-session", expiresAt: "2099-01-01T00:00:00Z" }
};

function agentSession(id: string, title: string) {
  return {
    id,
    accountId: "cert-account",
    kind: "personal",
    conversationType: "DAEMON",
    activeShopId: business.id,
    title,
    hasHumanRecipient: false,
    isPermanentDaemon: false,
    createdAt: "2026-11-18T00:00:00Z",
    updatedAt: "2026-11-18T00:00:00Z",
    lastMessage: null,
    unreadCount: 0,
    participant: { id: `${id}-participant`, role: "account", accountId: "cert-account" }
  };
}

interface Submission {
  conversationId: string;
  clientMessageId: string;
  text: string;
}

async function installFixture(page: Page) {
  const conversations = [
    agentSession("cert-chat-a", "Restock session"),
    agentSession("cert-chat-b", "Pricing session")
  ];
  const messages = new Map<string, unknown[]>(conversations.map((item) => [item.id, []]));
  const state = {
    /** Every POST /v1/messages that reached the fixture, in arrival order. */
    submitted: [] as Submission[],
    /** While true, POST /v1/messages fails as a dropped connection. */
    dropSends: false,
    ackDelayMs: 50,
    /** Extra wait before the server answers a thread read (GET /v1/conversations/:id). */
    threadDelayMs: 0
  };
  // On the browser context, so a second tab (a cold app start) talks to the same fixture.
  await page.context().route("http://127.0.0.1:4000/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (["/health", "/health/ready"].includes(path)) return json({ ok: true });
    if (["/session", "/auth/bootstrap"].includes(path)) return json(session);
    if (path === "/v1/session/context")
      return json({
        accountId: "cert-account",
        mode: "seller",
        activeShopId: business.id,
        activeSurface: "messenger",
        conversationId: conversations[0]!.id,
        shops: [
          { business, membership: { role: "owner", businessId: business.id, userId: "cert-user" } }
        ],
        sessionVersion: 1
      });
    if (path === "/businesses")
      return json({
        businesses: [
          { business, membership: { role: "owner", businessId: business.id, userId: "cert-user" } }
        ]
      });
    if (path === "/v1/conversations") return json({ conversations });
    const opened = conversations.find((item) => path === `/v1/conversations/${item.id}`);
    if (opened && request.method() === "GET") {
      if (state.threadDelayMs > 0)
        await new Promise((resolve) => setTimeout(resolve, state.threadDelayMs));
      return json({
        conversation: opened,
        participants: [],
        messages: messages.get(opened.id),
        typing: [],
        channels: []
      });
    }
    if (opened) return json({ conversation: opened });
    if (path.endsWith("/runtime/sessions"))
      return json(
        request.method() === "POST"
          ? {
              id: "cert-runtime",
              businessId: business.id,
              conversationId: conversations[0]!.id,
              status: "active",
              turnCount: 0
            }
          : []
      );
    if (path === "/v1/messages") {
      if (state.dropSends) return route.abort("connectionfailed");
      const payload = request.postDataJSON();
      state.submitted.push({
        conversationId: payload.conversationId,
        clientMessageId: payload.clientMessageId,
        text: payload.content?.text ?? ""
      });
      await new Promise((resolve) => setTimeout(resolve, state.ackDelayMs));
      const thread = messages.get(payload.conversationId) ?? [];
      // Idempotent like the server: the same clientMessageId returns the stored message.
      const existing = thread.find(
        (item) => (item as { clientMessageId: string }).clientMessageId === payload.clientMessageId
      );
      const message = existing ?? {
        id: `server-${payload.clientMessageId}`,
        conversationId: payload.conversationId,
        clientMessageId: payload.clientMessageId,
        author: "user",
        authorId: "cert-user",
        content: payload.content,
        status: "sent",
        createdAt: payload.clientTimestamp,
        deletedAt: null,
        replyToMessageId: null,
        reactions: []
      };
      if (!existing) thread.push(message);
      return json({
        ...(message as object),
        processing: {
          correlationId: (message as { id: string }).id,
          turnId: (message as { id: string }).id,
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
    if (path === "/v1/e2ee/devices") return json({ id: "cert-device", accountId: "cert-account" });
    if (path === "/auth/oauth/providers") return json({ providers: [] });
    if (path === "/v1/marketplace-intro") return json({ completedAt: "2026-11-18T00:00:00Z" });
    return json({ code: "fixture_unavailable", message: "Unavailable in fixture." }, 404);
  });
  await page.context().addInitScript((business) => {
    localStorage.setItem("grogoni.marketplace-intro.completed.v1", "true");
    localStorage.setItem("grogoni.chatFirst.activeBusiness", JSON.stringify(business));
    localStorage.setItem("grogoni.chatFirst.mode", "seller");
  }, business);
  return { state, conversations, messages };
}

async function openSession(page: Page, conversationId: string) {
  await page.goto(`/workspace/conversations/${conversationId}`);
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(composer).toBeVisible({ timeout: 25_000 });
  return composer;
}

async function send(page: Page, text: string) {
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill(text);
  await composer.press("Enter");
  await expect(page.locator(".message-list")).toContainText(text);
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error(error.message));
  await page.setViewportSize({ width: 360, height: 800 });
});

test("a reload reopens the same agent session with its messages", async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = await installFixture(page);
  await openSession(page, "cert-chat-b");
  await send(page, "Price check on sugar");
  await expect.poll(() => fixture.state.submitted.length).toBe(1);

  await page.reload();
  await expect(page).toHaveURL(/\/workspace\/conversations\/cert-chat-b$/u);
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({
    timeout: 25_000
  });
  await expect(page.locator(".message-list")).toContainText("Price check on sugar");
  expect(fixture.state.submitted.map((item) => item.conversationId)).toEqual(["cert-chat-b"]);
});

test("switching sessions keeps each session's messages in its own thread", async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = await installFixture(page);
  await openSession(page, "cert-chat-a");
  await send(page, "Restock 20 bags of maize");
  await openSession(page, "cert-chat-b");
  await expect(page.locator(".message-list")).not.toContainText("Restock 20 bags of maize");
  await send(page, "Lower bread to 55");
  await openSession(page, "cert-chat-a");
  await expect(page.locator(".message-list")).toContainText("Restock 20 bags of maize");
  await expect(page.locator(".message-list")).not.toContainText("Lower bread to 55");
  await expect
    .poll(() => fixture.state.submitted.map((item) => `${item.conversationId}:${item.text}`))
    .toEqual(["cert-chat-a:Restock 20 bags of maize", "cert-chat-b:Lower bread to 55"]);
});

test("messages typed offline wait on the device, survive a reload and send in order", async ({
  page,
  context
}) => {
  test.setTimeout(90_000);
  const fixture = await installFixture(page);
  await openSession(page, "cert-chat-a");

  // Route fixtures still answer while the context is offline, so the fixture drops sends too.
  fixture.state.dropSends = true;
  await context.setOffline(true);
  await send(page, "Offline one");
  await send(page, "Offline two");
  const list = page.locator(".message-list");
  await expect(list).not.toContainText("Sent");
  expect(fixture.state.submitted).toEqual([]);

  // Back online, but the API still drops sends: the reload must not lose the waiting messages.
  await context.setOffline(false);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({
    timeout: 25_000
  });
  await expect(list).toContainText("Offline one");
  await expect(list).toContainText("Offline two");
  expect(fixture.state.submitted).toEqual([]);

  // The connection recovers: a reconnect sends both, oldest first, each exactly once.
  fixture.state.dropSends = false;
  await context.setOffline(true);
  await context.setOffline(false);
  await expect
    .poll(() => fixture.state.submitted.map((item) => item.text), { timeout: 30_000 })
    .toEqual(["Offline one", "Offline two"]);
  expect(new Set(fixture.state.submitted.map((item) => item.clientMessageId)).size).toBe(2);
  await expect(list.getByText("Sent", { exact: true })).toHaveCount(2, { timeout: 15_000 });
});

test("a failed send retried by hand keeps its clientMessageId", async ({ page }) => {
  test.setTimeout(90_000);
  const fixture = await installFixture(page);
  await openSession(page, "cert-chat-a");
  fixture.state.dropSends = true;
  await send(page, "Needs a retry");
  const list = page.locator(".message-list");
  await expect(list.getByText(/Not sent/u).first()).toBeVisible({ timeout: 20_000 });
  expect(fixture.state.submitted).toEqual([]);

  fixture.state.dropSends = false;
  const retry = list.getByRole("button", { name: "Retry message" });
  const waiting = page.getByRole("button", { name: /Send waiting/u });
  // The per-message control when shown, otherwise the waiting-messages control above the thread.
  await expect(retry.or(waiting).first()).toBeVisible({ timeout: 20_000 });
  await retry.or(waiting).first().click();
  await expect
    .poll(() => fixture.state.submitted.map((item) => item.text), { timeout: 20_000 })
    .toEqual(["Needs a retry"]);
  const [sent] = fixture.state.submitted;
  // A slow ack: the composer stays usable and a second tap cannot create a second message.
  fixture.state.ackDelayMs = 1_500;
  await send(page, "After the retry");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeEnabled();
  await expect.poll(() => fixture.state.submitted.length, { timeout: 20_000 }).toBe(2);
  expect(fixture.state.submitted[0]?.clientMessageId).toBe(sent?.clientMessageId);
  expect(new Set(fixture.state.submitted.map((item) => item.clientMessageId)).size).toBe(2);
  await expect.poll(() => fixture.messages.get("cert-chat-a")?.length).toBe(2);
});

test("a chat opened before opens from the phone on a cold start while the server is slow", async ({
  page,
  context
}) => {
  test.setTimeout(60_000);
  const fixture = await installFixture(page);
  fixture.messages.get("cert-chat-a")!.push({
    id: "server-earlier",
    conversationId: "cert-chat-a",
    clientMessageId: "earlier-hello-0001",
    author: "user",
    authorId: "cert-user",
    content: { type: "text", text: "Earlier hello from this phone" },
    status: "sent",
    createdAt: "2026-11-18T09:00:00Z",
    deletedAt: null,
    replyToMessageId: null,
    reactions: []
  });
  await openSession(page, "cert-chat-a");
  await expect(page.locator(".message-list")).toContainText("Earlier hello from this phone");
  // Leave it for another chat, then close the app: only the device's storage remains.
  await openSession(page, "cert-chat-b");
  await page.close();

  // The server now takes 4 s to answer a thread read; the device copy must not wait for it.
  fixture.state.threadDelayMs = 4_000;
  // Something arrived while the app was closed: the device copy cannot know it yet.
  fixture.messages.get("cert-chat-a")!.push({
    id: "server-newer",
    conversationId: "cert-chat-a",
    clientMessageId: "newer-hello-00001",
    author: "user",
    authorId: "cert-user",
    content: { type: "text", text: "Newer message from the server" },
    status: "sent",
    createdAt: "2026-11-18T10:00:00Z",
    deletedAt: null,
    replyToMessageId: null,
    reactions: []
  });
  const cold = await context.newPage();
  await cold.setViewportSize({ width: 360, height: 800 });
  const started = Date.now();
  await cold.goto("/workspace/conversations/cert-chat-a");
  await expect(cold.locator(".message-list")).toContainText("Earlier hello from this phone", {
    timeout: 3_500
  });
  expect(Date.now() - started).toBeLessThan(3_500);
  // Then the server's answer replaces the device copy without another tap.
  await expect(cold.locator(".message-list")).toContainText("Newer message from the server", {
    timeout: 15_000
  });
  await expect(cold.locator(".message-list")).toContainText("Earlier hello from this phone");
});
