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

for (const width of [1280, 390])
  test(`My Assistant details show the ID and switch agent and model at ${width}px`, async ({
    page
  }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: 900 });
    const session = {
      account: {
        id: "assistant-account",
        primaryAuthChannel: "phone",
        primaryAuthDestination: "+442079460571"
      },
      user: { id: "assistant-user", displayName: "Owner", language: "en" },
      session: { id: "assistant-session", expiresAt: "2099-01-01T00:00:00Z" }
    };
    const assistantId = "4b8e2f10-5c7d-4a3b-9e21-7f6d5c4b3a29";
    const assistant = {
      id: assistantId,
      accountId: session.account.id,
      conversationType: "DAEMON",
      kind: "personal",
      activeShopId: null,
      isPermanentDaemon: true,
      title: "Your daemon",
      hasHumanRecipient: false,
      createdAt: "2026-10-23T00:00:00Z",
      updatedAt: "2026-10-23T00:00:00Z",
      unreadCount: 0,
      lastMessage: null,
      participant: {
        id: "participant-assistant",
        conversationId: assistantId,
        role: "account",
        accountId: session.account.id,
        createdAt: "2026-10-23T00:00:00Z"
      }
    };
    // Help topics and owner-named sessions are also conversationType DAEMON and come first in
    // the server's inbox order; only isPermanentDaemon marks My Assistant.
    const agentChat = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
      ...assistant,
      id,
      title,
      isPermanentDaemon: false,
      participant: { ...assistant.participant, id: `participant-${id}`, conversationId: id },
      ...extra
    });
    const helpHome = agentChat("7c1d2e3f-4a5b-4c6d-8e7f-901a2b3c4d5e", "Help", {
      helpTopic: "home"
    });
    const sessionChat = agentChat("8d2e3f4a-5b6c-4d7e-9f80-a12b3c4d5e6f", "Restock maize");
    let runtime = {
      conversationId: assistantId,
      selectedAgentId: "grogoni",
      agents: [
        { id: "grogoni", label: "Grogoni agent" },
        { id: "pi", label: "Pi agent" }
      ],
      selectedModelId: "gpt-6-luna",
      models: [
        { id: "gpt-6-luna", label: "Luna" },
        { id: "model-b", label: "Model B" }
      ],
      available: true,
      errorCode: null
    };
    const puts: unknown[] = [];
    let messages: unknown[] = [];
    await page.route("http://127.0.0.1:4000/**", async (route) => {
      const request = route.request();
      const requestUrl = new URL(request.url());
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
          conversationId: assistantId,
          shops: [],
          sessionVersion: 1
        };
      else if (path === "/v1/conversations")
        body = { conversations: [helpHome, sessionChat, assistant] };
      else if (path === `/v1/conversations/${assistantId}/model`) {
        if (request.method() === "PUT") {
          const change = request.postDataJSON() as { agentId?: string; modelId?: string };
          puts.push(change);
          runtime = {
            ...runtime,
            selectedAgentId: change.agentId ?? runtime.selectedAgentId,
            selectedModelId: change.modelId ?? runtime.selectedModelId
          };
        }
        body = runtime;
      } else if (path.startsWith(`/v1/conversations/${assistantId}`))
        body = { conversation: assistant, participants: [], messages, channels: [], typing: [] };
      else if (path === "/v1/shops") body = { shops: [] };
      else if (path === "/businesses") body = { businesses: [] };
      else if (path === "/auth/oauth/providers") body = { providers: [] };
      else if (path === "/v1/marketplace-intro") body = { completedAt: "2026-10-01T00:00:00Z" };
      else if (path === "/v1/e2ee/devices")
        body = { id: "assistant-device", accountId: session.account.id };
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
    await page.goto(`/marketplace`);
    if (width < 760) {
      // Open the inbox with the same swipe gesture as the mobile navigation regression.
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
    const item = page.locator(`[data-conversation-id="${assistantId}"]`).first();
    await expect(item).toContainText("My Assistant", { timeout: 20000 });
    await expect(item).toContainText("ASSISTANT");
    await expect(item).not.toContainText("daemon");
    await expect(item).toHaveClass(/pinned-agent/);
    const sessionItem = page.locator(`[data-conversation-id="${sessionChat.id}"]`).first();
    await expect(sessionItem).toContainText("Restock maize");
    await expect(sessionItem).not.toContainText("My Assistant");
    await expect(sessionItem.getByRole("button", { name: "Details" })).toHaveCount(0);

    // Entry point 1: the pinned inbox row, reachable even while the empty chat shows the home view.
    await item.getByRole("button", { name: "Details" }).click();
    const details = page.getByRole("dialog", { name: "My Assistant details" });
    await expect(details).toBeVisible();
    await expect(details).toContainText(assistantId);
    const agent = details.getByLabel("Agent");
    const model = details.getByLabel("Model");
    await expect(agent).toHaveValue("grogoni");
    await expect(model).toHaveValue("gpt-6-luna");
    await agent.selectOption("pi");
    await expect(details).toContainText("My Assistant now runs on Pi agent.");
    await model.selectOption("model-b");
    await expect(details).toContainText("My Assistant now runs on Model B.");
    expect(puts).toEqual([{ agentId: "pi" }, { modelId: "model-b" }]);
    await expect(agent).toHaveValue("pi");
    await expect(model).toHaveValue("model-b");
    await page.screenshot({ path: `test-results/my-assistant-details-inbox-${width}.png` });
    await details.getByRole("button", { name: "Close My Assistant details" }).click();
    await expect(details).toHaveCount(0);

    // Entry point 2: the thread header, once the assistant chat has messages.
    messages = [
      {
        id: "assistant-reply",
        conversationId: assistantId,
        clientMessageId: "assistant-reply",
        idempotencyKey: "assistant-reply",
        author: "agent",
        authorId: "agent",
        content: { type: "text", text: "Hello from your assistant." },
        clientTimestamp: null,
        createdAt: "2026-10-23T00:01:00Z"
      }
    ];
    await page.reload();
    if (width < 760) {
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
    await item.locator(".conversation-select").click();
    const header = page.locator(".messenger-thread-header");
    await expect(header).toContainText("My Assistant", { timeout: 20000 });
    await expect(header).not.toContainText("daemon");
    await expect(page.locator(".message.grogoniclaw .message-author").first()).toContainText(
      "My Assistant"
    );
    await header.getByRole("button", { name: "My Assistant details", exact: true }).click();
    await expect(details).toBeVisible();
    await expect(agent).toHaveValue("pi");
    await expect(model).toHaveValue("model-b");
    await details.getByRole("button", { name: "Close My Assistant details" }).click();
    // The fixed title opens the same details instead of a rename form.
    await header.getByRole("button", { name: "Open My Assistant details" }).click();
    await expect(details).toBeVisible();
    await expect(page.getByLabel("Conversation topic")).toHaveCount(0);
    await page.screenshot({ path: `test-results/my-assistant-details-header-${width}.png` });
  });
