import { expect, test, type Page } from "@playwright/test";
import { buildShopCapabilities } from "../services/api/src/cp2/domains/shop-hub/capabilities";

// Controlled transport gates. These numbers describe the browser under injected latency and
// failures, never production API or carrier latency. The API is a fixture served on 127.0.0.1:4000.

interface FixtureOptions {
  /** Delay before POST /v1/messages answers. */
  ackDelayMs?: number;
  /** The first N message POSTs fail at the network level (no response). */
  failFirstPosts?: number;
  /** When set, an agent turn completes this long after its message is accepted. */
  replyAfterMs?: number;
}

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
const conversationFixture = (id: string, title: string) => ({
  id,
  accountId: "instant-account",
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
  participant: { id: `${id}-participant`, role: "account", accountId: "instant-account" }
});

async function mountFixture(page: Page, options: FixtureOptions = {}) {
  page.on("pageerror", (error) => console.error(error.message));
  await page.setViewportSize({ width: 360, height: 800 });
  const conversations = [
    conversationFixture("instant-chat", "Fixture session"),
    conversationFixture("instant-chat-b", "Second session")
  ];
  const messages = new Map<string, Record<string, unknown>[]>(
    conversations.map((item) => [item.id, []])
  );
  const submitted: string[] = [];
  const created: unknown[] = [];
  const turns = new Map<string, { conversationId: string; readyAt: number; reply: string }>();
  let failuresLeft = options.failFirstPosts ?? 0;
  // page.route still intercepts while the context is offline, so the fixture refuses requests
  // itself, as a real dropped network would.
  // threadReadDelayMs: a thread read answers this late, with the messages it had when it arrived.
  const network = { offline: false, threadReadDelayMs: 0 };
  const threadsServed = new Set<string>();
  const runtimeSessions: string[] = [];
  let sequence = 0;
  const nextSequence = () => (sequence += 1);
  await page.route("http://127.0.0.1:4000/**", async (route) => {
    if (network.offline) return route.abort("internetdisconnected");
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
        conversationId: conversations[0]!.id,
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
    if (path === "/v1/conversations" && request.method() === "POST") {
      const body = request.postDataJSON();
      created.push(body);
      const direct = {
        ...conversationFixture("instant-direct", String(body.recipient)),
        conversationType: "DIRECT",
        hasHumanRecipient: true
      };
      if (!conversations.some((item) => item.id === direct.id)) {
        conversations.push(direct);
        messages.set(direct.id, []);
      }
      return json({ conversation: direct, participants: [], messages: [], typing: [] });
    }
    if (path === "/v1/conversations") return json({ conversations });
    const thread = conversations.find((item) => path === `/v1/conversations/${item.id}`);
    if (thread) {
      threadsServed.add(thread.id);
      // Delta reads as the API serves them: a cursor, and ?since= returns only newer messages.
      const since = new URL(request.url()).searchParams.get("since");
      const all = messages.get(thread.id)!;
      const delta = since !== null && Number(since) <= sequence;
      const answer = {
        conversation: thread,
        participants: [],
        messages: delta ? all.filter((item) => Number(item.serverSequence) > Number(since)) : all,
        messageCursor: String(sequence),
        isDelta: delta,
        typing: [],
        channels: []
      };
      if (network.threadReadDelayMs > 0)
        await new Promise((resolve) => setTimeout(resolve, network.threadReadDelayMs));
      return json(answer);
    }
    if (path.endsWith("/runtime/sessions")) {
      if (request.method() !== "POST") return json([]);
      // One runtime session per conversation, bound to the conversation the client names.
      const conversationId = String(request.postDataJSON()?.conversationId ?? conversations[0]!.id);
      runtimeSessions.push(conversationId);
      return json({
        id: `runtime-${conversationId}`,
        businessId: business.id,
        conversationId,
        status: "active",
        turnCount: 0
      });
    }
    if (path === "/v1/messages") {
      const payload = request.postDataJSON();
      submitted.push(payload.clientMessageId);
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        return route.abort("internetdisconnected");
      }
      await new Promise((resolve) => setTimeout(resolve, options.ackDelayMs ?? 50));
      const list = messages.get(payload.conversationId) ?? [];
      // The server deduplicates on clientMessageId: a retry returns the stored message.
      const existing = list.find((item) => item.clientMessageId === payload.clientMessageId);
      const message = existing ?? {
        id: `server-${payload.clientMessageId}`,
        conversationId: payload.conversationId,
        clientMessageId: payload.clientMessageId,
        author: "user",
        authorId: "instant-user",
        content: payload.content,
        status: "sent",
        createdAt: payload.clientTimestamp ?? new Date().toISOString(),
        deletedAt: null,
        replyToMessageId: null,
        reactions: []
      };
      if (!existing) list.push({ ...message, serverSequence: nextSequence() });
      if (options.replyAfterMs !== undefined && !turns.has(String(message.id)))
        turns.set(String(message.id), {
          conversationId: payload.conversationId,
          readyAt: Date.now() + options.replyAfterMs,
          reply: `Reply to ${(payload.content as { text?: string }).text ?? "message"}`
        });
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
    if (path.startsWith("/v1/agent-turns/")) {
      const id = decodeURIComponent(path.split("/").at(-1)!);
      const turn = turns.get(id);
      const pending = {
        processing: {
          correlationId: id,
          turnId: id,
          status: "pending",
          errorCode: null,
          retryable: false
        }
      };
      if (!turn) return json(pending);
      const wait = Math.max(0, Math.min(turn.readyAt - Date.now(), 2_000));
      await new Promise((resolve) => setTimeout(resolve, wait));
      if (Date.now() < turn.readyAt) return json(pending);
      const reply = {
        id: `reply-${id}`,
        conversationId: turn.conversationId,
        clientMessageId: `reply-${id}`,
        author: "agent",
        authorId: "instant-account-agent",
        content: { type: "text", text: turn.reply },
        status: "sent",
        createdAt: new Date().toISOString(),
        deletedAt: null,
        replyToMessageId: id,
        reactions: []
      };
      const list = messages.get(turn.conversationId)!;
      if (!list.some((item) => item.id === reply.id))
        list.push({ ...reply, serverSequence: nextSequence() });
      return json({
        agentMessage: reply,
        processing: { ...pending.processing, status: "completed" }
      });
    }
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
  const open = async (conversationId = conversations[0]!.id) => {
    await page.goto(`/workspace/conversations/${conversationId}`);
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(composer).toBeVisible({ timeout: 25_000 });
    return composer;
  };
  const setOffline = async (offline: boolean) => {
    network.offline = offline;
    await page.context().setOffline(offline);
  };
  /** Resolves once the app has loaded this thread from the API (the composer is ready to send). */
  const threadLoaded = (conversationId = conversations[0]!.id) =>
    expect.poll(() => threadsServed.has(conversationId), { timeout: 25_000 }).toBe(true);
  /** A message from someone else arrives on the server (no request from this browser). */
  const receive = (conversationId: string, text: string) => {
    const id = `inbound-${sequence + 1}`;
    messages.get(conversationId)!.push({
      id,
      conversationId,
      clientMessageId: id,
      author: "agent",
      authorId: "instant-account-agent",
      content: { type: "text", text },
      status: "sent",
      createdAt: new Date().toISOString(),
      deletedAt: null,
      replyToMessageId: null,
      reactions: [],
      serverSequence: nextSequence()
    });
  };
  return {
    messages,
    submitted,
    created,
    runtimeSessions,
    open,
    setOffline,
    network,
    threadLoaded,
    receive
  };
}

for (const [profile, ackDelayMs] of [
  ["normal", 50],
  ["mobile-300ms", 300],
  ["slow-server", 1500]
] as const) {
  test(`composer accepts two messages before replies on ${profile}`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    const fixture = await mountFixture(page, { ackDelayMs });
    const composer = await fixture.open();
    // Agent chats use the home shell (no thread header): the session is identified by its URL.
    await expect(page.locator(".messenger-thread-header")).toHaveCount(0);
    await composer.fill("First fixture question");
    await composer.press("Enter");
    await expect(page.locator(".message-list")).toContainText("First fixture question");
    await expect(composer).toBeEnabled();
    await composer.fill("Second fixture question");
    await composer.press("Enter");
    await expect(page.locator(".message-list")).toContainText("Second fixture question");
    await expect.poll(() => fixture.submitted.length).toBe(2);
    expect(new Set(fixture.submitted).size).toBe(2);
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

test("a slow model never blocks the composer, and the reply lands under its message", async ({
  page
}) => {
  test.setTimeout(60_000);
  const fixture = await mountFixture(page, { replyAfterMs: 4_000 });
  const composer = await fixture.open();
  await composer.fill("Slow model question");
  await composer.press("Enter");
  await expect(page.locator(".message-list")).toContainText("Slow model question");
  // While the model is still thinking the user keeps typing and sending.
  await composer.fill("Follow-up while waiting");
  await composer.press("Enter");
  await expect(page.locator(".message-list")).toContainText("Follow-up while waiting");
  await expect.poll(() => fixture.submitted.length).toBe(2);
  await expect(page.locator(".message-list")).toContainText("Reply to Slow model question", {
    timeout: 20_000
  });
  const text = await page.locator(".message-list").innerText();
  expect(text.indexOf("Slow model question")).toBeLessThan(
    text.indexOf("Reply to Slow model question")
  );
});

test("a failed send is retried with the same message id and ends sent, without a duplicate", async ({
  page
}) => {
  test.setTimeout(60_000);
  const fixture = await mountFixture(page, { failFirstPosts: 1 });
  const composer = await fixture.open();
  await composer.fill("Sent through a dropped connection");
  await composer.press("Enter");
  await expect(page.locator(".message-list")).toContainText("Sent through a dropped connection");
  await expect(page.locator(".message-list")).toContainText(/Not sent/u);
  const retry = page.getByRole("button", { name: "Retry message" });
  // The automatic quick resend may win the race against the tap; both must end the same way.
  if (await retry.isVisible().catch(() => false)) await retry.click().catch(() => undefined);
  await expect
    .poll(() => fixture.messages.get("instant-chat")!.length, { timeout: 20_000 })
    .toBe(1);
  await expect(page.locator(".message-list")).not.toContainText(/Not sent/u, { timeout: 20_000 });
  expect(fixture.submitted.length).toBeGreaterThanOrEqual(2);
  expect(new Set(fixture.submitted).size).toBe(1);
});

test("messages typed offline wait, then send in typed order on reconnect and survive a reload", async ({
  page
}) => {
  test.setTimeout(90_000);
  const fixture = await mountFixture(page);
  const composer = await fixture.open();
  await fixture.threadLoaded();
  await page.waitForLoadState("networkidle");
  await fixture.setOffline(true);
  await composer.fill("Offline first");
  await composer.press("Enter");
  await composer.fill("Offline second");
  await composer.press("Enter");
  await expect(page.locator(".message-list")).toContainText("Offline first");
  await expect(page.locator(".message-list")).toContainText("Offline second");
  expect(fixture.messages.get("instant-chat")).toHaveLength(0);
  await fixture.setOffline(false);
  await expect
    .poll(() => fixture.messages.get("instant-chat")!.length, { timeout: 30_000 })
    .toBe(2);
  const texts = fixture.messages
    .get("instant-chat")!
    .map((message) => (message.content as { text: string }).text);
  expect(texts).toEqual(["Offline first", "Offline second"]);
  // After a reload the thread shows each message exactly once.
  await fixture.open();
  const list = page.locator(".message-list");
  // The phone's copy shows first and the server's answer replaces it (#86): wait for both.
  await expect(list).toContainText("Offline first");
  await expect(list).toContainText("Offline second");
  const shown = await list.innerText();
  expect(shown.split("Offline first").length - 1).toBe(1);
  expect(shown.split("Offline second").length - 1).toBe(1);
});

test("a send accepted while an older thread read is in flight stays, once, at the end", async ({
  page
}) => {
  test.setTimeout(60_000);
  const fixture = await mountFixture(page);
  const composer = await fixture.open();
  await fixture.threadLoaded();
  await page.waitForLoadState("networkidle");
  // From now on a thread read answers 1.5 s late, with what the server had when it was asked.
  fixture.network.threadReadDelayMs = 1_500;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await composer.fill("Sent during a slow read");
  await composer.press("Enter");
  await expect.poll(() => fixture.messages.get("instant-chat")!.length).toBe(1);
  // Through the stale answer landing and the reads after it: always shown, once, and last.
  const list = page.locator(".message-list");
  for (let elapsed = 0; elapsed < 4_000; elapsed += 200) {
    const text = await list.innerText();
    expect(text.split("Sent during a slow read").length - 1).toBe(1);
    expect(text.indexOf("Sent during a slow read")).toBeGreaterThan(text.indexOf("Karibu"));
    await page.waitForTimeout(200);
  }
  fixture.network.threadReadDelayMs = 0;
});

test("New Message opens the picker and starts a Grogoni chat with a typed Kenyan number", async ({
  page
}) => {
  test.setTimeout(60_000);
  const fixture = await mountFixture(page);
  // Wide enough for the conversation list to sit beside the thread (on a phone it is swiped in).
  await page.setViewportSize({ width: 1280, height: 800 });
  await fixture.open();
  const start = page.getByRole("button", { name: "Message a phone number or email" });
  await expect(start).toBeVisible({ timeout: 25_000 });
  await start.click();
  const picker = page.getByRole("region", { name: "New message recipient" });
  await expect(picker).toBeVisible();
  await picker.getByLabel("Name, phone number or email").fill("0712 345678");
  await expect(picker).toContainText("+254712345678");
  await expect(picker.getByRole("button", { name: "Send as SMS" })).toBeVisible();
  await picker.getByRole("button", { name: "Open Grogoni chat" }).click();
  await expect.poll(() => fixture.created.length).toBe(1);
  expect(fixture.created[0]).toMatchObject({ recipient: "+254712345678" });
});

test("a message that arrives while the thread is open appears without a reload", async ({
  page
}) => {
  test.setTimeout(60_000);
  const fixture = await mountFixture(page);
  await fixture.open();
  await fixture.threadLoaded();
  // Let the thread settle so its last read and its cursor are recent (the regression served the
  // same ?since= URL from a 30 s cache, so new messages stayed invisible).
  await page.waitForTimeout(3_000);
  fixture.receive("instant-chat", "Arrived while you were looking");
  await expect(page.locator(".message-list")).toContainText("Arrived while you were looking", {
    timeout: 12_000
  });
});
