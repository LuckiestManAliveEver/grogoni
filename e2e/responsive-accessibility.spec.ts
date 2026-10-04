import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { buildShopCapabilities } from "../services/api/src/cp2/domains/shop-hub/capabilities";

const viewportMatrix = [
  { name: "compact 280px phone", width: 280, height: 653 },
  { name: "small phone portrait", width: 320, height: 568 },
  { name: "Android phone portrait", width: 360, height: 800 },
  { name: "modern phone portrait", width: 390, height: 844 },
  { name: "large phone portrait", width: 430, height: 932 },
  { name: "phone landscape", width: 844, height: 390 },
  { name: "foldable cover", width: 540, height: 720 },
  { name: "tablet portrait", width: 768, height: 1024 },
  { name: "tablet landscape", width: 1024, height: 768 },
  { name: "small laptop", width: 1280, height: 720 },
  { name: "desktop", width: 1440, height: 900 },
  { name: "full HD", width: 1920, height: 1080 },
  { name: "ultrawide", width: 2560, height: 1080 }
] as const;

test.beforeEach(async ({ page }) => {
  await installApiMocks(page);
  await page.addInitScript(() => {
    localStorage.setItem(
      "grogoni.chatFirst.activeBusiness",
      JSON.stringify({
        id: "responsive-certification-shop",
        name: "Jane's International Neighborhood Market and Supplies",
        language: "en",
        role: "owner",
        grogoniId: "grogoni.janes-market"
      })
    );
    localStorage.setItem("grogoni.chatFirst.mode", "seller");
    localStorage.setItem("grogoni.marketplace-intro.completed.v1", "true");
  });
});

for (const width of [360, 1280]) {
  test(`runtime handoff is visible before Edit at ${width}px and explains an unavailable host`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/sell/conversations/responsive-conversation");
    await page.getByRole("button", { name: "Account and agent settings" }).click();
    const dialog = page.getByRole("dialog", { name: "Account and agent settings" });
    const header = dialog.locator(".agent-profile-header");
    await expect(header.getByRole("button", { name: "Go offline", exact: true })).toBeVisible();
    await expect(header.getByRole("button", { name: "Go offline", exact: true })).toBeDisabled();
    await expect(header.locator(".agent-profile-actions button")).toHaveText([
      "Go offline",
      "Refresh runtime",
      "Edit",
      "Sign out"
    ]);
    await expect(header.getByText("AI business attendant · Hosted", { exact: true })).toBeVisible();
    await expect(dialog.locator("#runtime-handoff-guidance")).toHaveText(
      "No compatible local runtime is currently connected."
    );
    await expect
      .poll(() => header.evaluate((element) => element.scrollWidth <= element.clientWidth))
      .toBe(true);
  });
}

test("secondary modules preserve the conversation URL and browser history", async ({ page }) => {
  await page.goto("/");
  const initialHistoryLength = await page.evaluate(() => history.length);

  await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await page.getByRole("button", { name: "Browse marketplace", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Marketplace" })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expect.poll(() => page.evaluate(() => history.length)).toBe(initialHistoryLength);
  await page.getByRole("button", { name: "Close Marketplace" }).click();
  await expect(page.getByRole("dialog", { name: "Marketplace" })).toHaveCount(0);

  await page.getByRole("button", { name: "Account and agent settings" }).click();
  const settingsDialog = page.getByRole("dialog", { name: "Account and agent settings" });
  await expect(settingsDialog).toBeVisible();
  await settingsDialog.locator(".settings-group-title", { hasText: "Agent behavior" }).click();
  await expect(
    settingsDialog.getByLabel("Open-source agent catalogue", { exact: true })
  ).toBeVisible();
  await expect(settingsDialog.getByText("Retail Agent", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expect.poll(() => page.evaluate(() => history.length)).toBe(initialHistoryLength);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Account and agent settings" })).toHaveCount(0);
});

test("a stale agent-profile chunk reloads once and reopens settings instead of going blank", async ({
  page
}) => {
  let rejectedProfileChunk = false;
  await page.route("**/src/AgentProfileSurface.tsx", async (route) => {
    if (!rejectedProfileChunk) {
      rejectedProfileChunk = true;
      await route.fulfill({ status: 404, contentType: "text/plain", body: "Old chunk removed" });
      return;
    }
    await route.continue();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Account and agent settings" }).click();

  await expect(page.getByRole("dialog", { name: "Account and agent settings" })).toBeVisible({
    timeout: 30_000
  });
  await expect(page.getByText("Business", { exact: true })).toBeVisible();
  expect(rejectedProfileChunk).toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() => sessionStorage.getItem("grogoni.lazy-module-recovery.v1.agent-profile"))
    )
    .toBeNull();
});

for (const nestedProfileChunk of [
  { label: "model panel", file: "AgentModelPanel.tsx", moduleKey: "agent-model-panel" },
  {
    label: "identity security panel",
    file: "IdentitySecurityPanel.tsx",
    moduleKey: "identity-security-panel"
  }
]) {
  test(`a stale profile ${nestedProfileChunk.label} chunk reloads once and reopens settings`, async ({
    page
  }) => {
    let rejectedNestedProfileChunk = false;
    let nestedProfileChunkCanLoad = false;
    let documentRequestCount = 0;
    page.on("request", (request) => {
      if (request.resourceType() !== "document") return;
      documentRequestCount += 1;
      if (rejectedNestedProfileChunk) nestedProfileChunkCanLoad = true;
    });
    await page.route(`**/src/${nestedProfileChunk.file}`, async (route) => {
      if (!nestedProfileChunkCanLoad) {
        rejectedNestedProfileChunk = true;
        await route.fulfill({ status: 404, contentType: "text/plain", body: "Old chunk removed" });
        return;
      }
      await route.continue();
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Account and agent settings" }).click();

    await expect.poll(() => rejectedNestedProfileChunk).toBe(true);
    await expect.poll(() => documentRequestCount, { timeout: 30_000 }).toBe(2);
    await expect(page.getByRole("dialog", { name: "Account and agent settings" })).toBeVisible({
      timeout: 30_000
    });
    await expect(page.getByText("Business", { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          (moduleKey) => sessionStorage.getItem(`grogoni.lazy-module-recovery.v1.${moduleKey}`),
          nestedProfileChunk.moduleKey
        )
      )
      .toBeNull();
  });
}

test("clicking a public shop opens its storefront instead of a blank screen", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await page.getByRole("button", { name: "Browse marketplace", exact: true }).click();

  const shopCard = page.getByRole("link", { name: /Responsive Public Shop/u });
  await expect(shopCard).toBeVisible();
  await shopCard.click();

  await expect(page).toHaveURL(/\/agent\/grogoni\.responsive-public-shop$/u);
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByText("Responsive Public Shop", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Storefront chat" })).toBeVisible();
});

test("the agent catalogue hides an unavailable agent instead of listing it disabled", async ({
  page
}) => {
  const unavailableAgent = {
    ...mockOssAgent,
    id: "github:example/unlicensed-agent",
    label: "Unlicensed Agent",
    sourceId: "example/unlicensed-agent",
    source: "github",
    licenseVerified: false,
    executionMode: "repository"
  };
  await page.route("**/v1/oss-agents/github**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        agents: [unavailableAgent],
        status: "available",
        connection: "public",
        message: "GitHub connected."
      })
    })
  );

  await page.goto("/");
  await page.getByRole("button", { name: "Account and agent settings" }).click();
  const settingsDialog = page.getByRole("dialog", { name: "Account and agent settings" });
  await settingsDialog.locator(".settings-group-title", { hasText: "Agent behavior" }).click();
  await expect(settingsDialog.getByText("Retail Agent", { exact: true })).toBeVisible();
  await expect(settingsDialog.getByText("Unlicensed Agent", { exact: true })).toHaveCount(0);
});

test("offers Gmail contacts as the first network source for a verified Gmail account", async ({
  page
}) => {
  // Overrides installApiMocks' defaults for this test only (page.route handlers added later take
  // precedence): a verified Gmail address already linked, Google configured, and no seed network
  // yet - the exact state where IdentityNetworkOnboardingCard should show "Add your first
  // contacts" with an enabled "Import Google Contacts" button.
  const verifiedGmailSession = {
    account: {
      id: "responsive-account",
      primaryAuthChannel: "phone",
      primaryAuthDestination: "+254700000900"
    },
    user: {
      id: "responsive-user",
      displayName: "Jane Owner",
      language: "en",
      emailAddress: "jane.owner@gmail.com",
      emailVerificationStatus: "verified"
    },
    session: { id: "responsive-session", expiresAt: "2099-01-01T00:00:00.000Z" }
  };
  await page.route("**/session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(verifiedGmailSession)
    })
  );
  await page.route("**/auth/bootstrap", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(verifiedGmailSession)
    })
  );
  await page.route("**/auth/oauth/providers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        providers: [
          {
            id: "google",
            displayName: "Google",
            configured: true,
            enabled: true,
            implemented: true,
            scopes: ["openid", "email", "profile"]
          }
        ]
      })
    })
  );
  await page.route("**/network", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ownerUserId: "responsive-user",
        generatedAt: "2026-07-15T00:00:00.000Z",
        nodes: [],
        edges: [],
        sources: []
      })
    })
  );
  let oauthStartBody: Record<string, unknown> | null = null;
  await page.route("**/auth/oauth/start", (route) => {
    oauthStartBody = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authorizationUrl: "http://127.0.0.1:5173/#mock-google-consent",
        csrfToken: "mock-csrf",
        expiresAt: "2026-07-15T00:10:00.000Z",
        provider: "google",
        state: "mock-state"
      })
    });
  });

  await page.goto("/");
  const card = page.locator(".identity-network-onboarding");
  await expect(card.getByRole("heading", { name: "Add your first contacts" })).toBeVisible();

  const importButton = card.getByRole("button", { name: "Import Google Contacts" });
  await expect(importButton).toBeEnabled();
  await importButton.click();

  await expect
    .poll(() => oauthStartBody)
    .toMatchObject({
      provider: "google",
      purpose: "contacts"
    });
});

test("the Shop Hub opens at /sell/shop, opens modules as drawers, and closes with Escape", async ({
  page
}) => {
  await page.goto("/sell");
  const workspaceButton = page.getByRole("button", { name: "Workspace", exact: true });
  await workspaceButton.click();
  const dialog = page.getByRole("dialog", { name: "Your shop" });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/sell\/shop$/u);
  await expect(dialog.getByRole("region", { name: "Needs attention" })).toContainText(
    "Add your first product so customers can order."
  );

  await dialog.locator('.shop-hub-tile[data-module-id="catalog"]').click();
  const moduleView = dialog.locator('.shop-hub-detail[data-module-id="catalog"]');
  await expect(moduleView).toBeVisible();
  await expect(
    moduleView.getByRole("button", { name: "Ask the agent: Add a product", exact: true })
  ).toBeVisible();
  await expect(moduleView.getByRole("button", { name: "Back" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(moduleView).toBeHidden();
  await expect(dialog.locator('.shop-hub-tile[data-module-id="catalog"]')).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/sell$/u);
  await expect(workspaceButton).toBeFocused();
});

test("Ask the agent pre-fills the chat with the tool's command", async ({ page }) => {
  await page.goto("/sell/shop");
  const dialog = page.getByRole("dialog", { name: "Your shop" });
  await expect(dialog).toBeVisible();
  await dialog.locator('.shop-hub-tile[data-module-id="payments"]').click();
  await page
    .getByRole("region", { name: "Payments" })
    .getByRole("button", { name: "Ask the agent: Record a payment" })
    .click();
  await expect(page.getByRole("dialog", { name: "Your shop" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("#payment.record ");
});

for (const locale of ["en-US", "sw-KE"] as const) {
  test.describe(`Go to my shop at 360px (${locale})`, () => {
    test.use({ locale });

    test("opens the Shop Hub from the menu without overflow", async ({ page }) => {
      const sw = locale === "sw-KE";
      await page.setViewportSize({ width: 360, height: 800 });
      await page.goto("/sell");
      await page.getByRole("button", { name: "Open menu" }).click();
      await page.getByRole("button", { name: "Go to my shop" }).click();
      const dialog = page.getByRole("dialog", { name: sw ? "Duka lako" : "Your shop" });
      await expect(dialog).toBeVisible();
      await expect(page).toHaveURL(/\/sell\/shop$/u);
      await expect(dialog.locator(".shop-hub-tile").first()).toBeVisible();
      await expect(dialog).toContainText(sw ? "Njia za mauzo" : "Channels");
      await expect(dialog).toContainText(sw ? "Yanahitaji kushughulikiwa" : "Needs attention");
      await expectNoViewportOverflow(page);
      await expectInteractiveControlsInsideViewport(page, dialog.locator(".shop-hub-header"));
      const tileBox = await dialog.locator(".shop-hub-tile").first().boundingBox();
      expect(tileBox?.width ?? 0).toBeGreaterThan(120);
      const results = await new AxeBuilder({ page })
        .include(".shop-hub")
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(results.violations, formatViolations(results.violations)).toEqual([]);
    });
  });
}

test("the Business workspace dashboard reflows on a small screen and stays keyboard-reachable", async ({
  page
}) => {
  // Audit A27 ("Merchant workspace"): MerchantWorkspaceDashboard is new markup rendered inside
  // the existing Workspace StackedModule, switching its content without remounting the module -
  // so the focus trap's initial-focus effect never re-fires for this nested view. This proves the
  // Tab-trap keydown handler still adapts to the swapped content instead of assuming stale
  // elements, and that the new stats/orders/catalogue layout reflows at a small width.
  // The header "Workspace" launcher is deliberately hidden below 760px (styles.css); on mobile the
  // dashboard is reached through "Go to my shop" in the menu instead. Open it at desktop width
  // first, then shrink the viewport to check the new content's own reflow.
  await page.goto("/sell");
  const workspaceButton = page.getByRole("button", { name: "Workspace", exact: true });
  await workspaceButton.click();
  // Scoped by the Workspace module's own id, not accessible name: the dialog's title (and so its
  // aria-labelledby text) changes from "Your shop" to "Business workspace" once the dashboard
  // opens, a name-filtered locator would stop matching after that transition, and a bare
  // role="dialog" locator collides with the separate Messages module mounted alongside it.
  const dialog = page.locator('[data-module-id="workspace"] [role="dialog"]');
  await expect(dialog).toBeVisible();
  const closeButton = dialog.locator(".stacked-module-heading button");

  await dialog.locator('.shop-hub-tile[data-module-id="orders"]').click();
  await page
    .getByRole("region", { name: "Orders & sales" })
    .getByRole("button", { name: "Today's dashboard", exact: true })
    .click();
  const backButton = dialog.getByRole("button", { name: "Back" });
  await expect(backButton).toBeVisible();
  await expect(dialog.getByText("No orders yet.")).toBeVisible();
  await expect(dialog.getByText("No products yet.")).toBeVisible();

  // Small-screen reflow of the dashboard's own content - the real "small-screen layout" contract
  // for this new markup, independent of the header chrome that's hidden below 760px (mobile
  // reaches this dashboard through the inline owner-controls card instead, not this launcher).
  // Below 760px the conversation inbox also becomes its own StackedModule alongside this one
  // (ChatSurface.tsx's isCompactViewport branch), so this also exercises the fix for
  // stacked-module-stack.ts: two simultaneously-open modules used to each install their own
  // document-level Tab/Escape handler, and Tab from this dialog's last control jumped into the
  // Messages module instead of wrapping (see tests/stacked-module-focus-stack.test.tsx for the
  // isolated regression coverage of that fix).
  await page.setViewportSize({ width: 320, height: 700 });
  await expect(dialog.getByText("No orders yet.")).toBeVisible();
  await expectNoViewportOverflow(page);
  await expectInteractiveControlsInsideViewport(page, dialog);
  const messagesDialog = page.locator('[data-module-id="messenger-inbox"] [role="dialog"]');
  await expect(messagesDialog).toBeVisible();

  // Tab-trap wraps around the dashboard's own controls (close, Back, then the two "See all"
  // buttons - empty state renders no other focusable rows), not the Messages module's, even
  // though it's also open right now.
  const lastSeeAll = dialog.getByRole("button", { name: "See all" }).nth(1);
  await lastSeeAll.focus();
  await page.keyboard.press("Tab");
  await expect(closeButton).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(lastSeeAll).toBeFocused();

  // Back is reachable and operable by keyboard alone, returning to the Shop Hub without closing
  // the dialog. Also proves the pointer-blocking half of the same fix: before it, the Messages
  // module (painted with the same base z-index, later in DOM order) covered this dialog and ate
  // the click - Playwright's actionability check made that failure explicit instead of silently
  // clicking through.
  await backButton.focus();
  await page.keyboard.press("Enter");
  await expect(dialog.locator('.shop-hub-tile[data-module-id="orders"]')).toBeVisible();
  await dialog.locator('.shop-hub-tile[data-module-id="orders"]').click();
  await page
    .getByRole("region", { name: "Orders & sales" })
    .getByRole("button", { name: "Today's dashboard", exact: true })
    .click();
  await expect(dialog.getByText("No orders yet.")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("existing shops keep the Shop Hub out of the chat until the launcher opens it", async ({
  page
}) => {
  await page.goto("/sell");
  await expect(page.locator(".shop-hub")).toHaveCount(0);

  const launcher = page.getByRole("button", { name: "Workspace", exact: true });
  await launcher.click();
  const dialog = page.getByRole("dialog", { name: "Your shop" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".shop-hub")).toHaveCount(1);
  // One tile per registry module the owner can see (11 today), rendered from the endpoint.
  await expect(dialog.locator(".shop-hub-tile")).toHaveCount(11);

  await dialog.getByRole("button", { name: "Close Your shop" }).click();
  await expect(page.locator(".shop-hub")).toHaveCount(0);
  await expect(launcher).toBeFocused();

  await launcher.click();
  await expect(page.getByRole("dialog", { name: "Your shop" })).toHaveCount(1);
  await page.keyboard.press("Escape");

  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill("The hub is closed and chat still works.");
  await expect(composer).toHaveValue("The hub is closed and chat still works.");
  await expect(page.getByRole("dialog", { name: "Your shop" })).toHaveCount(0);
});

test("SMS handoff confirms cost, normalizes the recipient, and preserves the draft", async ({
  page
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/sell");
  const composer = page.getByRole("textbox", { name: "Message" });
  const draft = `Hello from Grogoni. ${"This message may use more than one carrier SMS. ".repeat(4)}`;
  await composer.fill(draft);

  let grogoniMessagePosts = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/v1/messages") {
      grogoniMessagePosts += 1;
    }
  });

  await page.getByRole("button", { name: "Open message actions", exact: true }).click();
  const actions = page.getByRole("dialog", { name: "More message actions" });
  await expect(actions).toBeVisible();
  await actions.getByRole("button", { name: "Send as SMS", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Send as SMS" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Your mobile carrier may charge for this SMS.")).toBeVisible();
  await expect(dialog.getByText(/multiple charges may apply/)).toBeVisible();
  await dialog.getByLabel("Telephone number").fill("0712 345 678");
  await dialog.getByRole("button", { name: "Review SMS details" }).click();
  await expect(dialog.getByText("+254712345678")).toBeVisible();
  await expect(dialog.getByLabel("Message preview")).toHaveValue(draft);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(composer).toHaveValue(draft);
  expect(grogoniMessagePosts).toBe(0);
});

test("mobile composer keeps one More control and exposes secondary actions in a sheet", async ({
  page
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/sell");

  const composer = page.getByRole("textbox", { name: "Message" });
  const more = page.getByRole("button", { name: "Open message actions", exact: true });
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await expect(more).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  // Voice is a standalone, always-visible control in the bottom row (shown while the draft is
  // empty), not tucked inside the action sheet.
  await expect(page.getByRole("button", { name: "Record voice", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Take photo", exact: true })).toHaveCount(0);
  await expect(page.getByText(/will answer$/)).toBeVisible();

  await more.click();
  const actions = page.getByRole("dialog", { name: "More message actions" });
  await expect(actions).toBeVisible();
  await expect(actions.getByRole("button", { name: "Take photo", exact: true })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Photos", exact: true })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Files", exact: true })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Record voice", exact: true })).toHaveCount(0);
  await expect(actions.getByRole("button", { name: "Open command", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(actions).toHaveCount(0);
  await expect(more).toBeFocused();
});

test("the composer grows to show a wrapped draft instead of clipping it on mobile", async ({
  page
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/sell");
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toBeVisible({ timeout: 15_000 });

  const emptyHeight = (await composer.boundingBox())?.height ?? 0;
  // Single visible line by default - the fixed-height/overflow:hidden bug this guards against
  // only appears once content wraps, so an empty composer should stay compact.
  expect(emptyHeight).toBeLessThan(50);

  await composer.fill(
    "This is a somewhat long test message typed into the chat composer box on a phone"
  );
  await expect
    .poll(async () => (await composer.boundingBox())?.height ?? 0)
    .toBeGreaterThan(emptyHeight);

  // No clipped tail: the grown box must be tall enough to show the whole wrapped draft, not just
  // scroll it out of view behind a fixed-height, overflow:hidden box. A few px of tolerance for
  // border-box rounding between scrollHeight and clientHeight - a real clipping regression (the
  // fixed-height bug this guards against) leaves a full line's worth of gap, not a rounding pixel.
  const { scrollHeight, clientHeight } = await composer.evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    return { scrollHeight: textarea.scrollHeight, clientHeight: textarea.clientHeight };
  });
  expect(clientHeight).toBeGreaterThanOrEqual(scrollHeight - 4);
});

test("persisted owner-control entry stays attached to its historical message and opens the hub", async ({
  page
}) => {
  await page.setExtraHTTPHeaders({ "x-grogoni-test-owner-controls": "true" });
  // The startup chat window stays blank unless the URL deep-links to a conversation (see
  // useChatInboxState.loadMessagingInbox) - go straight to the historical conversation instead of
  // relying on auto-selecting the first inbox entry.
  await page.goto("/sell/conversations/responsive-conversation");
  const historicalMessage = page
    .locator("article.message")
    .filter({ hasText: "Shared owner controls" });
  await expect(historicalMessage).toHaveCount(1, { timeout: 30_000 });
  await expect(historicalMessage.locator("section.generated-card-message")).toHaveCount(1);
  await expect(page.getByRole("dialog", { name: "Your shop" })).toHaveCount(0);

  await historicalMessage.locator(".shop-hub-entry-button").click();
  await expect(page.getByRole("dialog", { name: "Your shop" })).toBeVisible();
});

test("account deletion requires DELETE, PIN, acknowledgement, and signs out", async ({ page }) => {
  let pinVerifications = 0;
  let deletionRequests = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/auth/pin/verify") pinVerifications += 1;
    if (path.endsWith("/compliance/account-deletion")) deletionRequests += 1;
  });

  await page.goto("/settings");
  await page.locator(".settings-group-title", { hasText: "Advanced" }).click();
  await page.getByRole("button", { name: "Delete account", exact: true }).click();
  await page.getByRole("button", { name: "Delete entire account" }).click();
  await page.getByLabel("Type DELETE to confirm").fill("DELETE");
  await page.getByRole("button", { name: "Continue to verification" }).click();
  await page
    .getByRole("group", { name: "Verify account deletion" })
    .getByLabel("Owner PIN")
    .fill("1234");
  await page.getByLabel(/I understand that all account access is disabled immediately/).check();
  await page.getByTestId("delete-account-confirm").click();
  await expect(page).toHaveURL(/\/signup$/);
  await expect(
    page.getByRole("heading", { name: "Connect with your market", level: 1 })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Log in", exact: true })).toBeVisible();
  expect(pinVerifications).toBe(1);
  expect(deletionRequests).toBe(1);
});

test("shop deletion Continue and Quarantine buttons call the backend", async ({ page }) => {
  let startRequests = 0;
  let finalizeRequests = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/shop-deletion/request")) startRequests += 1;
    if (path.endsWith("/shop-deletion/responsive-shop-deletion/finalize")) {
      finalizeRequests += 1;
    }
  });

  await page.goto("/settings");
  await page.locator(".settings-group-title", { hasText: "Advanced" }).click();
  await page.getByRole("button", { name: "Delete account", exact: true }).click();
  await page.getByRole("button", { name: "Delete this shop", exact: true }).click();
  await page.getByLabel("Type the shop ID to continue").fill("grogoni.janes-market");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("textbox", { name: "Login PIN", exact: true }).fill("1234");
  await page.getByLabel(/I understand the shop will be hidden now and permanently purged/).check();
  await page.getByRole("button", { name: "Quarantine shop" }).click();

  await expect(page.locator('.shop-deletion-card[role="status"]')).toContainText("QUARANTINED");
  expect(startRequests).toBe(1);
  expect(finalizeRequests).toBe(1);
});

test("messaging inbox and thread adapt across phone and desktop screens", async ({ page }) => {
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 1440, height: 900 }
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    if (viewport.width < 760) {
      await page.getByRole("button", { name: "Open menu" }).click();
      await page.getByRole("button", { name: "Message history" }).click();
    }
    await expect(page.getByRole("heading", { name: "Messages" })).toBeVisible();
    await page.getByRole("button", { name: /Delivery coordination/ }).click();
    await expect(
      page.locator(".messenger-thread").getByText("The order is ready.", { exact: true })
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    await expectNoViewportOverflow(page);
  }
});

test("draft Terms of Service reflow and pass an automated accessibility scan", async ({ page }) => {
  test.setTimeout(90_000);
  for (const viewport of [
    { width: 280, height: 653 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 }
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/terms");
    await expect(page.getByRole("heading", { name: "Terms of Service", level: 1 })).toBeVisible({
      timeout: 20_000
    });
    await expect(page.getByText("Version 1.0 (Draft) · Parts I–IV")).toBeVisible();
    await expect(page.getByText("Effective Date: To Be Inserted")).toBeVisible();
    await expect(page.getByRole("heading", { name: "1. Introduction" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "15. The Grogoni Services" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "33. Subscription Plans" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "77. Effective Date and Version History" })
    ).toBeVisible();
    await expectNoViewportOverflow(page);

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations, formatViolations(results.violations)).toEqual([]);
  }
});

test("draft Privacy Policy reflows and passes an automated accessibility scan", async ({
  page
}) => {
  test.setTimeout(90_000);
  for (const viewport of [
    { width: 280, height: 653 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 }
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/privacy");
    await expect(page.getByRole("heading", { name: "Privacy Policy", level: 1 })).toBeVisible({
      timeout: 20_000
    });
    await expect(page.getByText("Version 1.0 (Draft) · Parts I–IV")).toBeVisible();
    await expect(page.getByText("Effective Date: To Be Inserted")).toBeVisible();
    await expect(page.getByRole("heading", { name: "1. Introduction" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "40. Version History" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Annex D – Data Subject Rights Summary" })
    ).toBeVisible();
    await expectNoViewportOverflow(page);

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations, formatViolations(results.violations)).toEqual([]);
  }
});

test("public account deletion resource reflows and passes accessibility", async ({ page }) => {
  for (const viewport of [
    { width: 280, height: 653 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 }
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/account-deletion");
    await expect(
      page.getByRole("heading", { name: "Delete your Grogoni account", level: 1 })
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Continue to secure deletion request" })
    ).toHaveAttribute("href", "/?intent=account-deletion");
    await expect(
      page.getByText("You do not need to reinstall or open the Android app.")
    ).toBeVisible();
    await expectNoViewportOverflow(page);

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations, formatViolations(results.violations)).toEqual([]);
  }
});

for (const viewport of viewportMatrix) {
  test(`${viewport.name}: model library reflows without clipped controls`, async ({ page }) => {
    await openModelLibrary(page, viewport);
    await expectNoViewportOverflow(page);
    await expectInteractiveControlsInsideViewport(
      page,
      page.getByRole("dialog", { name: "Account and agent settings" })
    );
  });
}

for (const viewport of viewportMatrix) {
  test(`${viewport.name}: the seller chat home reflows without clipped controls`, async ({
    page
  }) => {
    // The primary screen ("conversation is the app," docs/frontend/frontend.md) only had spot
    // checks at 2-3 widths before this. Every other surface in this file's viewportMatrix sweep is
    // a secondary dialog (model library); this closes that gap for the screen sellers actually land
    // on first.
    await page.setViewportSize(viewport);
    await page.goto("/sell");
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
    await expectNoViewportOverflow(page);
    await expectInteractiveControlsInsideViewport(page, page.locator("body"));
  });
}

for (const viewport of viewportMatrix) {
  test(`${viewport.name}: the customer marketplace home reflows without clipped controls`, async ({
    page
  }) => {
    // "/" is the other primary entry point - the marketplace/customer-facing shell, structurally
    // different chrome from "/sell" (no Buy/Messages pills; navigation lives behind the hamburger
    // menu, see "the status notice never covers the customer home's header buttons" above). Same
    // gap as the seller sweep above: only ever spot-checked at one width before this.
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Open menu", exact: true })).toBeVisible({
      timeout: 15_000
    });
    await expectNoViewportOverflow(page);
    // .home-suggestion-chips (home-reference.css) is a deliberate single-row, swipeable chip strip
    // - flex-wrap: nowrap + overflow-x: auto + a hidden scrollbar, the same pattern as a native
    // mobile "stories" row - so its own buttons legitimately sit outside the initial viewport at
    // narrow widths and are excluded from the page-wide clipping sweep below. Verified separately:
    // scrollable by touch/mouse (its own scrollWidth exceeds clientWidth) and reachable by keyboard
    // (a focused off-screen chip scrolls into view, standard browser behavior for overflow: auto).
    await expectInteractiveControlsInsideViewport(page, page.locator("body"), [
      ".home-suggestion-chips button"
    ]);
    const chipStrip = page.locator(".home-suggestion-chips");
    if ((await chipStrip.count()) > 0) {
      const overflowsRow = await chipStrip.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
      if (overflowsRow) {
        const lastChip = chipStrip.getByRole("button").last();
        await lastChip.focus();
        await expect(lastChip).toBeInViewport();
      }
    }
  });
}

test("activating a backend model preserves the previous model when activation fails", async ({
  page
}) => {
  // Scoped to this test only, rather than added to the shared `modelCatalog` fixture: a second
  // backend-configured entry changes which action buttons render per card (Test model / Use with
  // agent / an inline activation-failure status), a combination the shared-catalog reflow tests
  // below don't otherwise exercise.
  const secondModelId = "responsive-second-backend-model";
  await page.route("**/v1/ai-models", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        models: [
          modelCatalog[0],
          {
            id: secondModelId,
            label: "Second Backend Model",
            provider: "openai",
            description: "A second backend-hosted model for activation-failure coverage.",
            capabilities: ["chat"],
            available: true,
            source: "hosted",
            format: "remote",
            license: null,
            licenseUrl: null,
            modelCardUrl: null,
            downloadUrl: null,
            fileName: null,
            fileSizeBytes: null,
            minimumMemoryGb: null,
            recommended: false,
            contextWindow: 32_000,
            runtimeAvailability: { backend: "configured" }
          }
        ]
      })
    })
  );
  await page.setExtraHTTPHeaders({
    "x-grogoni-test-seed-active-model": "openai-fast",
    "x-grogoni-test-failing-activation-model": secondModelId
  });
  await openModelLibrary(page, { width: 390, height: 844 });

  await expect(page.locator(".agent-model-current h4")).toHaveText("OpenAI fast");

  const secondModelCard = page
    .locator(".ai-model-card")
    .filter({ hasText: "Second Backend Model" });
  await secondModelCard.getByRole("button", { name: "Use with agent" }).click();
  // This model isn't the platform-included default, so it's merchant-funded - the activation
  // request doesn't fire until this confirmation is accepted (see AgentModelPanel.tsx's
  // requestActivateServerBackendModel).
  await secondModelCard.getByRole("button", { name: "Confirm switch" }).click();

  await expect(secondModelCard.getByRole("status")).toHaveText(
    "Activation failed. The previous working model remains active - try again or pick a different model."
  );
  await expect(page.locator(".agent-model-current h4")).toHaveText("OpenAI fast");
});

test("a second backend-configured model does not clip the model library at 280px", async ({
  page
}) => {
  // Regression coverage for a bug once tracked separately (a second backend-configured entry was
  // suspected of clipping the model library card at the narrowest supported viewport). Re-audited:
  // does not reproduce against today's `.model-lab-grid` (styles.css), whose
  // `grid-template-columns: repeat(auto-fit, minmax(min(160px, 100%), 1fr))` already collapses to a
  // single fluid column at 280px. This test pins that fixed state so a future regression is caught
  // instead of silently reintroduced.
  const secondModelId = "responsive-second-backend-model";
  await page.route("**/v1/ai-models", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        models: [
          modelCatalog[0],
          {
            id: secondModelId,
            label: "Second Backend Model",
            provider: "openai",
            description: "A second backend-hosted model for activation-failure coverage.",
            capabilities: ["chat"],
            available: true,
            source: "hosted",
            format: "remote",
            license: null,
            licenseUrl: null,
            modelCardUrl: null,
            downloadUrl: null,
            fileName: null,
            fileSizeBytes: null,
            minimumMemoryGb: null,
            recommended: false,
            contextWindow: 32_000,
            runtimeAvailability: { backend: "configured" }
          }
        ]
      })
    })
  );
  await page.setExtraHTTPHeaders({
    "x-grogoni-test-seed-active-model": "openai-fast",
    "x-grogoni-test-failing-activation-model": secondModelId
  });
  await openModelLibrary(page, { width: 280, height: 653 });

  await expect(page.locator(".agent-model-current h4")).toHaveText("OpenAI fast");
  const secondModelCard = page
    .locator(".ai-model-card")
    .filter({ hasText: "Second Backend Model" });
  await secondModelCard.getByRole("button", { name: "Use with agent" }).click();
  // This model isn't the platform-included default, so it's merchant-funded - the activation
  // request doesn't fire until this confirmation is accepted (see AgentModelPanel.tsx's
  // requestActivateServerBackendModel).
  await secondModelCard.getByRole("button", { name: "Confirm switch" }).click();
  await expect(secondModelCard.getByRole("status")).toHaveText(
    "Activation failed. The previous working model remains active - try again or pick a different model."
  );

  await expectNoViewportOverflow(page);
  await expectInteractiveControlsInsideViewport(
    page,
    page.getByRole("dialog", { name: "Account and agent settings" })
  );
});

test("WCAG 2.2 A/AA automated accessibility scan", async ({ page }) => {
  test.setTimeout(120_000);
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 430, height: 932 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 }
  ]) {
    await openModelLibrary(page, viewport);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations, formatViolations(results.violations)).toEqual([]);
  }
});

test("200% text size and WCAG text spacing preserve reflow", async ({ page }) => {
  await openModelLibrary(page, { width: 640, height: 720 });
  await page.addStyleTag({
    content: `
      html { font-size: 200% !important; }
      p { line-height: 1.5 !important; margin-bottom: 2em !important; }
      * { letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
    `
  });
  await expectNoViewportOverflow(page);
  await expectInteractiveControlsInsideViewport(
    page,
    page.getByRole("dialog", { name: "Account and agent settings" })
  );
});

test("keyboard navigation exposes a visible focus indicator", async ({ page }) => {
  await openModelLibrary(page, { width: 390, height: 844 });
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement) || element === document.body) return null;
      const style = getComputedStyle(element);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        boxShadow: style.boxShadow
      };
    });
    expect(focus).not.toBeNull();
    expect(
      focus?.outlineStyle !== "none" || focus.outlineWidth !== "0px" || focus.boxShadow !== "none"
    ).toBe(true);
  }
});

test("touch controls satisfy the WCAG 2.2 minimum target size", async ({ page }) => {
  await openModelLibrary(page, { width: 360, height: 800 });
  const undersized = await page
    .getByRole("dialog", { name: "Account and agent settings" })
    .locator("button, a[href], input, select, textarea")
    .evaluateAll((elements) =>
      elements.flatMap((element) => {
        const node = element as HTMLElement;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        if (style.visibility === "hidden" || style.display === "none" || rect.width === 0)
          return [];
        return rect.width < 24 || rect.height < 24
          ? [
              {
                label: node.getAttribute("aria-label") ?? node.textContent?.trim(),
                ...rect.toJSON()
              }
            ]
          : [];
      })
    );
  expect(undersized).toEqual([]);
});

test("the status notice never covers the customer home's header buttons", async ({ page }) => {
  // The customer home (mode === "marketplace") has no Buy/Messages pills - Message history is
  // reached through the hamburger menu instead (see Grogoni Home: hides the Buy/Messages pills...
  // in tests/grogoni-home-progressive-entry.test.ts).
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("button", { name: "Message history" }).click();
  await page.getByRole("button", { name: "Notifications" }).click();

  const notice = page.locator(".app-action-notice");
  await expect(notice).toBeHidden();
  expect(await notice.boundingBox()).toBeNull();
});

test("reduced-motion and forced-color preferences keep the page operable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
  await openModelLibrary(page, { width: 390, height: 844 });
  await expectNoViewportOverflow(page);
  await expect(page.getByRole("heading", { name: "Model library", exact: true })).toBeVisible();
  await expect(page.getByPlaceholder("Search models, e.g. SmolLM")).toBeVisible();
});

async function openModelLibrary(
  page: Page,
  viewport: { width: number; height: number }
): Promise<void> {
  await page.setViewportSize(viewport);
  await page.goto("/");
  await page.getByRole("button", { name: "Account and agent settings" }).click();
  await expect(page.getByRole("dialog", { name: "Account and agent settings" })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await page.locator(".settings-group-title", { hasText: "Model & inference" }).click();
  await expect(page.getByRole("heading", { name: "Model library", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open model library" }).click();
  await expect(page.getByPlaceholder("Search models, e.g. SmolLM")).toBeVisible({
    timeout: 15_000
  });
}

async function expectNoViewportOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth
  }));
  expect(dimensions.scrollWidth, JSON.stringify(dimensions)).toBeLessThanOrEqual(
    dimensions.clientWidth + 1
  );
  expect(dimensions.bodyScrollWidth, JSON.stringify(dimensions)).toBeLessThanOrEqual(
    dimensions.clientWidth + 1
  );
}

async function expectInteractiveControlsInsideViewport(
  page: Page,
  root: Locator,
  excludeSelectors: string[] = []
): Promise<void> {
  const viewportWidth = await page.evaluate(() => document.documentElement.clientWidth);
  const clipped = await root.locator("button, a[href], input, select, textarea").evaluateAll(
    (elements, { width, excludeSelectors }) =>
      elements.flatMap((element) => {
        const node = element as HTMLElement;
        if (excludeSelectors.some((selector) => node.matches(selector))) return [];
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        if (style.visibility === "hidden" || style.display === "none" || rect.width === 0)
          return [];
        return rect.left < -1 || rect.right > Number(width) + 1
          ? [
              {
                label: node.getAttribute("aria-label") ?? node.textContent?.trim(),
                left: rect.left,
                right: rect.right
              }
            ]
          : [];
      }),
    { width: viewportWidth, excludeSelectors }
  );
  expect(clipped).toEqual([]);
}

async function installApiMocks(page: Page): Promise<void> {
  let accountDeleted = false;
  let installedOssAgentManifests: Array<{
    manifestVersion: 1;
    accountId: string;
    userId: string;
    agent: unknown;
    installedAt: string;
  }> = [];
  let activeModelBinding: {
    id: string;
    agentId: string;
    shopId: string;
    accountId: string;
    modelId: string;
    status: string;
    executionMode: string;
    executionTarget: string;
    permissions: { allowRemoteShopDevice: boolean };
    activatedAt: string | null;
    lastVerifiedAt: string | null;
    lastVerificationStatus: string | null;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
    createdAt: string;
    updatedAt: string;
    updatedBy: string;
  } | null = null;
  await page.route("http://127.0.0.1:4000/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const failingActivationModelId =
      route.request().headers()["x-grogoni-test-failing-activation-model"] ?? null;
    const seedActiveModelId = route.request().headers()["x-grogoni-test-seed-active-model"];
    if (seedActiveModelId !== undefined && activeModelBinding === null) {
      activeModelBinding = {
        id: "responsive-seed-binding",
        agentId: "responsive-certification-shop",
        shopId: "responsive-certification-shop",
        accountId: "responsive-account",
        modelId: seedActiveModelId,
        status: "active",
        executionMode: "LOCAL_FIRST",
        executionTarget: "backend",
        permissions: { allowRemoteShopDevice: false },
        activatedAt: "2026-07-21T00:00:00.000Z",
        lastVerifiedAt: "2026-07-21T00:00:00.000Z",
        lastVerificationStatus: "passed",
        lastErrorCode: null,
        lastErrorMessage: null,
        createdAt: "2026-07-21T00:00:00.000Z",
        updatedAt: "2026-07-21T00:00:00.000Z",
        updatedBy: "responsive-user"
      };
    }
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (path === "/auth/oauth/providers") return json({ providers: [] });
    if (path === "/businesses/responsive-certification-shop/capabilities" && method === "GET") {
      return json(
        buildShopCapabilities({
          businessId: "responsive-certification-shop",
          role: "owner",
          setupStates: {
            catalog_products: "needs_setup",
            channels_linked: "unavailable",
            agent_runtime: "ready",
            delivery_corridors: "unavailable"
          },
          now: new Date("2026-09-26T00:00:00.000Z")
        })
      );
    }
    if (path === "/session" || path === "/auth/bootstrap") {
      if (accountDeleted) return json({ code: "session_invalid" }, 401);
      return json({
        account: { id: "responsive-account" },
        user: { id: "responsive-user", displayName: "Jane Owner", language: "en" },
        session: { id: "responsive-session", expiresAt: "2099-01-01T00:00:00.000Z" }
      });
    }
    if (path === "/v1/marketplace-intro") {
      return json({ completedAt: "2026-07-15T00:00:00.000Z" });
    }
    if (path === "/public/storefronts" && method === "GET") {
      return json({ storefronts: [mockPublicStorefront] });
    }
    if (path === "/public/storefronts/grogoni.responsive-public-shop" && method === "GET") {
      return json(mockPublicStorefront);
    }
    if (
      path === "/public/storefronts/grogoni.responsive-public-shop/sessions" &&
      method === "POST"
    ) {
      return json({
        conversationId: "responsive-public-conversation",
        capabilityToken: "responsive-public-capability",
        expiresAt: "2099-01-01T00:00:00.000Z"
      });
    }
    if (path === "/v1/e2ee/devices" && method === "POST") {
      return json({ id: "responsive-device", accountId: "responsive-account" });
    }
    if (path === "/v1/runtime/responsive-conversation/capabilities") {
      return route.fulfill({
        json: {
          hosted: [
            {
              executionHostId: "hosted",
              type: "backend",
              supported: true,
              configured: true,
              available: true,
              healthy: true,
              reachable: true,
              active: true,
              reason: null
            }
          ],
          local: [],
          activeExecutionHostId: "hosted",
          activeTransfer: null,
          handoff: { supported: false, available: false, reason: "LOCAL_RUNTIME_NOT_REGISTERED" }
        }
      });
    }
    if (path === "/v1/conversations" && method === "GET") {
      return json({ conversations: [mockConversationInbox] });
    }
    if (path === "/v1/conversations/responsive-conversation" && method === "GET") {
      return json(
        route.request().headers()["x-grogoni-test-owner-controls"] === "true"
          ? mockOwnerControlsConversationView
          : mockConversationView
      );
    }
    if (path === "/v1/conversations/responsive-conversation" && method === "PATCH") {
      return json(mockConversationView);
    }
    if (path.endsWith("/typing")) return json({ typing: [] });
    if (path === "/v1/messages") return json(mockMessage);
    if (path.endsWith("/runtime/sessions") && method === "GET") return json([mockRuntimeSession]);
    if (path.endsWith("/runtime/sessions") && method === "POST") {
      return json(mockRuntimeSession);
    }
    if (path === "/roles/check") return json({ allowed: true, role: "owner", permission: "*" });
    // installOssAgentForAccount/hydrateAccountOssAgentManifests (account-ai-assets.ts) call the
    // real backend contract (services/api/src/cp2/domains/agent-runtime/routes.ts): POST returns
    // the manifest directly, GET returns { manifests }.
    if (path === "/v1/oss-agents/installed" && method === "GET") {
      return json({ manifests: installedOssAgentManifests });
    }
    if (path === "/v1/oss-agents/installed" && method === "POST") {
      const body = route.request().postDataJSON() as { agent: unknown };
      const manifest = {
        manifestVersion: 1 as const,
        accountId: "responsive-account",
        userId: "responsive-user",
        agent: body.agent,
        installedAt: "2026-07-15T00:00:00.000Z"
      };
      installedOssAgentManifests = [...installedOssAgentManifests, manifest];
      return json(manifest);
    }
    if (path === "/v1/oss-agents/github") {
      return json({
        agents: [],
        status: "available",
        connection: "public",
        message: "GitHub connected."
      });
    }
    if (path === "/v1/oss-agents/huggingface") {
      return json({
        agents: [mockOssAgent],
        status: "available",
        connection: "public",
        message: "Hugging Face connected."
      });
    }
    if (path === "/v1/ai-models") return json({ models: modelCatalog });
    if (path === "/v1/models/installed" && method === "POST") return json({ registered: true });
    if (path.startsWith("/v1/models/") && path.endsWith("/validate") && method === "POST") {
      return json({
        installationStatus: "INSTALLED",
        compatibilityStatus: "COMPATIBLE",
        validationError: null
      });
    }
    if (path.endsWith("/model-binding") && method === "GET") {
      return json({ binding: activeModelBinding });
    }
    if (path.endsWith("/model-binding") && method === "DELETE") {
      const removedBindingId = activeModelBinding?.id ?? null;
      activeModelBinding = null;
      return json({
        agentId: "responsive-certification-shop",
        shopId: "responsive-certification-shop",
        binding: null,
        removedBindingId
      });
    }
    if (path.endsWith("/runtime/effective") && method === "GET") {
      const modelId = activeModelBinding?.modelId ?? "openai-fast";
      const model = modelCatalog.find((candidate) => candidate.id === modelId);
      return json({
        agent: { id: "builtin:shopkeeper", name: "Grogoni AI", runtimeAdapterId: "grogoni" },
        model: { id: modelId, name: model?.label ?? modelId },
        execution: { type: "backend", hostId: null, ready: true },
        binding: activeModelBinding !== null ? { id: activeModelBinding.id } : null,
        source: activeModelBinding !== null ? "explicit" : "default",
        status: "READY",
        ready: true
      });
    }
    if (/\/models\/[^/]+\/test$/u.test(path) && method === "POST") {
      const modelId = path.split("/").at(-2) ?? "";
      return json({
        healthCheck: {
          ok: true,
          modelId,
          provider: "grogoni",
          executionTarget: "backend",
          latencyMs: 42,
          responsePreview: null,
          errorCode: null,
          errorMessage: null,
          retryable: false,
          checkedAt: "2026-07-21T00:00:00.000Z"
        }
      });
    }
    if (/\/models\/[^/]+\/activate$/u.test(path) && method === "POST") {
      const modelId = path.split("/").at(-2) ?? "";
      if (modelId === failingActivationModelId) {
        return json(
          { message: "Backend inference is temporarily unreachable.", code: "MODEL_UNAVAILABLE" },
          502
        );
      }
      activeModelBinding = {
        id: "responsive-model-binding",
        agentId: "responsive-certification-shop",
        shopId: "responsive-certification-shop",
        accountId: "responsive-account",
        modelId,
        status: "active",
        executionMode: "LOCAL_FIRST",
        executionTarget: "backend",
        permissions: { allowRemoteShopDevice: false },
        activatedAt: "2026-07-21T00:00:00.000Z",
        lastVerifiedAt: "2026-07-21T00:00:00.000Z",
        lastVerificationStatus: "passed",
        lastErrorCode: null,
        lastErrorMessage: null,
        createdAt: "2026-07-21T00:00:00.000Z",
        updatedAt: "2026-07-21T00:00:00.000Z",
        updatedBy: "responsive-user"
      };
      return json({
        binding: activeModelBinding,
        healthCheck: {
          ok: true,
          modelId,
          provider: "grogoni",
          executionTarget: "backend",
          latencyMs: 42,
          responsePreview: null,
          errorCode: null,
          errorMessage: null,
          retryable: false,
          checkedAt: "2026-07-21T00:00:00.000Z"
        }
      });
    }
    if (path.endsWith("/ai-model")) {
      return json({ modelId: "qwen2.5-0.5b-android" });
    }
    if (path.endsWith("/social-accounts")) return json({ accounts: [] });
    if (path.endsWith("/shop-deletion/preview")) {
      return json({
        businessId: "responsive-certification-shop",
        accountId: "responsive-account",
        counts: { products: 1, customers: 2, suppliers: 1, salesRecords: 3, uploadedFiles: 1 },
        generatedAt: "2026-07-15T00:00:00.000Z"
      });
    }
    if (path.endsWith("/shop-deletion/request") && method === "POST") {
      return json({
        request: {
          id: "responsive-shop-deletion",
          status: "PENDING_VERIFICATION",
          anonymizeAfter: "2026-08-14T00:00:00.000Z"
        },
        preview: {
          businessId: "responsive-certification-shop",
          accountId: "responsive-account",
          counts: { products: 1, customers: 2, suppliers: 1, salesRecords: 3, uploadedFiles: 1 },
          generatedAt: "2026-07-15T00:00:00.000Z"
        }
      });
    }
    if (path.endsWith("/shop-deletion/responsive-shop-deletion/finalize") && method === "POST") {
      return json({
        id: "responsive-shop-deletion",
        status: "QUARANTINED",
        anonymizeAfter: "2026-08-14T00:00:00.000Z"
      });
    }
    if (path === "/auth/pin/verify" && method === "POST") return json({ verified: true });
    if (path.endsWith("/compliance/account-deletion") && method === "POST") {
      accountDeleted = true;
      return json({
        id: "responsive-deletion",
        accountId: "responsive-account",
        userId: "responsive-user",
        businessId: "responsive-certification-shop",
        actorId: "responsive-user",
        status: "scheduled",
        reason: null,
        requestedAt: "2026-07-15T00:00:00.000Z",
        deactivatedAt: "2026-07-15T00:00:00.000Z",
        anonymizeAfter: "2026-08-14T00:00:00.000Z",
        retention: {}
      });
    }
    return json({ message: "Not needed by responsive certification" }, 404);
  });
}

const mockMessage = {
  id: "responsive-message",
  conversationId: "responsive-conversation",
  clientMessageId: "responsive-client-message",
  author: "agent",
  authorId: "account-responsive-account-agent",
  content: { type: "text", text: "The order is ready." },
  status: "delivered",
  deliveredAt: "2026-07-15T12:00:00.000Z",
  readAt: null,
  editedAt: null,
  deletedAt: null,
  replyToMessageId: null,
  forwardedFromMessageId: null,
  reactions: [],
  clientTimestamp: "2026-07-15T12:00:00.000Z",
  createdAt: "2026-07-15T12:00:00.000Z"
};

const mockOwnerControlsMessage = {
  ...mockMessage,
  id: "responsive-owner-controls-message",
  clientMessageId: "responsive-owner-controls-client-message",
  content: { type: "owner-controls", shopId: "responsive-certification-shop" }
};

const mockParticipant = {
  id: "responsive-participant",
  conversationId: "responsive-conversation",
  role: "account",
  accountId: "responsive-account",
  businessId: null,
  agentId: null,
  displayName: "Jane Owner",
  lastReadAt: "2026-07-15T12:00:00.000Z",
  archivedAt: null,
  mutedUntil: null,
  pinnedAt: null,
  createdAt: "2026-07-15T11:00:00.000Z"
};

const mockConversationInbox = {
  id: "responsive-conversation",
  accountId: "responsive-account",
  kind: "personal",
  activeShopId: null,
  title: "Delivery coordination",
  createdAt: "2026-07-15T11:00:00.000Z",
  updatedAt: "2026-07-15T12:00:00.000Z",
  lastMessage: mockMessage,
  unreadCount: 0,
  participant: mockParticipant
};

const mockConversationView = {
  conversation: mockConversationInbox,
  participants: [mockParticipant],
  messages: [mockMessage],
  typing: []
};

const mockRuntimeSession = {
  id: "responsive-runtime-session",
  businessId: "responsive-certification-shop",
  userId: "responsive-user",
  status: "active",
  turnCount: 0,
  createdAt: "2026-07-15T12:00:00.000Z",
  updatedAt: "2026-07-15T12:00:00.000Z"
};

const mockOwnerControlsConversationView = {
  ...mockConversationView,
  messages: [mockOwnerControlsMessage]
};

const mockOssAgent = {
  id: "huggingface:example/retail-agent",
  label: "Retail Agent",
  description: "A licensed retail assistant Space.",
  source: "huggingface",
  sourceId: "example/retail-agent",
  sourceUrl: "https://huggingface.co/spaces/example/retail-agent",
  license: "apache-2.0",
  licenseUrl: "https://huggingface.co/spaces/example/retail-agent/blob/main/LICENSE",
  licenseVerified: true,
  runtime: "gradio",
  executionMode: "hosted-api",
  minimumDeviceTier: "low",
  minimumMemoryGb: 2,
  requiresGpu: false,
  popularity: 120,
  capabilities: ["agent", "retail"],
  updatedAt: "2026-07-15T00:00:00.000Z"
};

const mockPublicStorefront = {
  agentId: "grogoni.responsive-public-shop",
  grogoniId: "grogoni.responsive-public-shop",
  businessName: "Responsive Public Shop",
  presence: { status: "online", updatedAt: "2026-07-15T00:00:00.000Z" },
  products: [
    {
      id: "responsive-public-product",
      name: "Fresh mangoes",
      unit: "crate",
      available: true,
      sellingPrice: 125,
      image: null
    }
  ]
};

const modelCatalog = [
  {
    id: "openai-fast",
    label: "OpenAI fast",
    provider: "openai",
    description: "Fast hosted reasoning for connected shops.",
    capabilities: ["chat", "tool-routing"],
    available: true,
    source: "hosted",
    format: "remote",
    license: null,
    licenseUrl: null,
    modelCardUrl: null,
    downloadUrl: null,
    fileName: null,
    fileSizeBytes: null,
    minimumMemoryGb: null,
    recommended: false,
    contextWindow: 128_000,
    runtimeAvailability: { backend: "configured" }
  },
  mockModel("smollm2-360m-android", "SmolLM2 360M (Android saver)", 386_000_000, 2),
  mockModel("qwen2.5-0.5b-android", "Qwen2.5 0.5B (Android recommended)", 491_000_000, 3, true),
  mockModel("qwen2.5-1.5b-android", "Qwen2.5 1.5B (high-end Android)", 1_120_000_000, 6)
];

function mockModel(
  id: string,
  label: string,
  fileSizeBytes: number,
  minimumMemoryGb: number,
  recommended = false
) {
  return {
    id,
    label,
    provider: "local",
    description: `${label} model description for responsive certification.`,
    capabilities: ["chat", "tool-routing", "offline", "multilingual"],
    available: true,
    source: "huggingface",
    format: "GGUF",
    license: "Apache-2.0",
    licenseUrl: "https://huggingface.co/license",
    modelCardUrl: "https://huggingface.co/model",
    downloadUrl: "https://huggingface.co/model.gguf",
    fileName: `${id}.gguf`,
    fileSizeBytes,
    minimumMemoryGb,
    recommended
  };
}

function formatViolations(
  violations: Array<{ id: string; help: string; nodes: Array<{ target: unknown }> }>
): string {
  return violations
    .map(
      (violation) =>
        `${violation.id}: ${violation.help}\n${violation.nodes
          .map((node) => `  ${JSON.stringify(node.target)}`)
          .join("\n")}`
    )
    .join("\n");
}
