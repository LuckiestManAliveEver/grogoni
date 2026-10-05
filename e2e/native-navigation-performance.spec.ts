import { expect, test, type Page } from "@playwright/test";
import { buildShopCapabilities } from "../services/api/src/cp2/domains/shop-hub/capabilities";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await installDelayedApi(page);
  await page.addInitScript(() => {
    localStorage.setItem(
      "grogoni.chatFirst.activeBusiness",
      JSON.stringify({
        id: "performance-shop",
        name: "Performance Shop",
        language: "en",
        role: "owner",
        grogoniId: "254P12345678"
      })
    );
    localStorage.setItem("grogoni.chatFirst.mode", "seller");
    localStorage.setItem("grogoni.marketplace-intro.completed.v1", "true");
  });
});

test("primary navigation remains local while data refreshes slowly", async ({ page }) => {
  await page.goto("/sell");
  const workspaceButton = page.getByRole("button", { name: "Workspace", exact: true });
  await expect(workspaceButton).toBeVisible({ timeout: 30_000 });
  const shellId = await page.locator(".app-frame").getAttribute("data-shell-instance");
  const timings: Record<string, number> = {};

  // Shop Hub modules (opened from the "Workspace" header button at /sell/shop) open their
  // screens locally over the same shell instance, titled per apps/web/src/app-shell.ts's
  // quickActions labels, and close back to plain chat.
  for (const destination of [
    { module: "orders", surface: "Invoices", dialogTitle: "Invoices" },
    { module: "receipts", surface: "Receipts & files", dialogTitle: "Purchase receipts" },
    { module: "insights", surface: "Business summary", dialogTitle: "Reports" }
  ]) {
    await workspaceButton.click();
    const hub = page.getByRole("dialog", { name: "Your shop" });
    await expect(hub).toBeVisible();
    await hub.locator(`.shop-hub-tile[data-module-id="${destination.module}"]`).click();
    const duration = await clickToSecondPaint(page, destination.surface);
    timings[destination.dialogTitle] = Math.round(duration * 10) / 10;
    await expect(page.getByRole("dialog", { name: destination.dialogTitle })).toBeVisible();
    expect(duration, `${destination.surface} navigation`).toBeLessThan(300);
    expect(await page.locator(".app-frame").getAttribute("data-shell-instance")).toBe(shellId);
    await page.getByRole("button", { name: `Close ${destination.dialogTitle}` }).click();
  }

  // Catalogue is a nested view inside the same launcher dialog (relabeled "Catalogue" instead of
  // "Your shop") rather than its own dialog - apps/web/src/workspace-panel-title.ts.
  await workspaceButton.click();
  await expect(page.getByRole("dialog", { name: "Your shop" })).toBeVisible();
  await page.locator('.shop-hub-tile[data-module-id="catalog"]').click();
  const catalogueDuration = await clickToSecondPaint(page, "Open catalogue");
  timings.catalogue = Math.round(catalogueDuration * 10) / 10;
  await expect(page.getByRole("dialog", { name: "Catalogue" })).toBeVisible();
  expect(catalogueDuration, "Catalogue navigation").toBeLessThan(300);
  expect(await page.locator(".app-frame").getAttribute("data-shell-instance")).toBe(shellId);
  await expect(page).toHaveURL(/\/sell\/shop$/);
  await page.getByRole("button", { name: "Close Catalogue" }).click();
  await expect(page).toHaveURL(/\/sell$/);

  console.log("[GROGONI_NAV_BENCH]", JSON.stringify(timings));
});

test("workspace and model settings do not replace the authenticated shell", async ({ page }) => {
  await page.goto("/sell");
  const shellId = await page.locator(".app-frame").getAttribute("data-shell-instance");

  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Your shop" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Account and agent settings" }).click();
  await expect(page.getByRole("dialog", { name: "Account and agent settings" })).toBeVisible();
  await expect(page).toHaveURL(/\/sell$/);
  await page.locator(".settings-group-title", { hasText: "Model & inference" }).click();
  await page.getByRole("button", { name: "Open model library" }).click();
  await expect(page.getByRole("heading", { name: "Model library", exact: true })).toBeVisible({
    timeout: 30_000
  });
  await expect(page.getByLabel("Grogoni local models", { exact: true })).toHaveCount(0);

  expect(await page.locator(".app-frame").getAttribute("data-shell-instance")).toBe(shellId);
});

test("backend model activation survives reload and can be removed", async ({ page }) => {
  test.setTimeout(60_000);
  await page.route("http://127.0.0.1:4000/v1/ai-models", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ models: [configuredBackendModel] })
    })
  );
  await page.goto("/sell");
  await page.getByRole("button", { name: "Account and agent settings" }).click();
  await expect(page.getByRole("dialog", { name: "Account and agent settings" })).toBeVisible();
  await expect(page).toHaveURL(/\/sell$/u);
  await page.locator(".settings-group-title", { hasText: "Model & inference" }).click();
  await page.getByRole("button", { name: "Open model library" }).click();
  const backendModels = page.getByLabel("Grogoni local models", { exact: true });
  await expect(backendModels).toBeVisible();

  await backendModels.getByRole("button", { name: "Use with agent", exact: true }).click();
  // Any model other than the platform default asks for an explicit merchant confirmation first.
  await backendModels.getByRole("button", { name: "Confirm switch", exact: true }).click();
  await expect(
    backendModels.getByRole("button", { name: "Remove from agent", exact: true })
  ).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: "Account and agent settings" }).click();
  await expect(page.getByRole("dialog", { name: "Account and agent settings" })).toBeVisible();
  await page.locator(".settings-group-title", { hasText: "Model & inference" }).click();
  await page.getByRole("button", { name: "Open model library" }).click();
  await expect(
    backendModels.getByRole("button", { name: "Remove from agent", exact: true })
  ).toBeVisible();

  await backendModels.getByRole("button", { name: "Remove from agent", exact: true }).click();
  await expect(
    backendModels.getByRole("button", { name: "Use with agent", exact: true })
  ).toBeVisible();
});

const configuredBackendModel = {
  id: "qwen2.5-0.5b-android",
  label: "Qwen2.5 0.5B (Android recommended)",
  provider: "local",
  description: "Configured backend model fixture.",
  capabilities: ["chat", "tool-routing", "multilingual"],
  available: true,
  source: "huggingface",
  format: "GGUF",
  license: "Apache-2.0",
  licenseUrl: null,
  modelCardUrl: null,
  downloadUrl: null,
  fileName: null,
  fileSizeBytes: null,
  minimumMemoryGb: null,
  recommended: true,
  contextWindow: 32_768,
  runtimeAvailability: { backend: "configured" }
};

async function clickToSecondPaint(page: Page, label: string): Promise<number> {
  return page.getByRole("button", { name: label, exact: true }).evaluate(async (button) => {
    const startedAt = performance.now();
    button.click();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
    return performance.now() - startedAt;
  });
}

async function installDelayedApi(page: Page): Promise<void> {
  let activeBinding: Record<string, unknown> | null = null;
  await page.route("http://127.0.0.1:4000/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (url.pathname === "/auth/bootstrap" || url.pathname === "/session") {
      return json({
        account: { id: "performance-account" },
        user: { id: "performance-user", displayName: "Performance Owner", language: "en" },
        session: { id: "performance-session", expiresAt: "2099-01-01T00:00:00.000Z" }
      });
    }
    if (url.pathname === "/auth/oauth/providers") return json({ providers: [] });
    if (url.pathname === "/businesses/performance-shop/capabilities") {
      return json(
        buildShopCapabilities({
          businessId: "performance-shop",
          role: "owner",
          setupStates: {},
          now: new Date("2026-09-26T00:00:00.000Z")
        })
      );
    }
    if (url.pathname === "/v1/marketplace-intro") {
      return json({ completedAt: "2026-07-26T00:00:00.000Z" });
    }
    if (url.pathname === "/v1/session/context") {
      return json({
        accountId: "performance-account",
        userId: "performance-user",
        sessionId: "performance-session",
        // Not a real conversation ID with a matching /v1/conversations/:id fixture below - a
        // non-null value here makes the app optimistically route to that (nonexistent)
        // conversation's URL, which confuses every URL assertion in this file with an unrelated
        // "could not be found" redirect.
        conversationId: null,
        activeShopId: "performance-shop",
        agentId: "performance-shop",
        activeModelId: "qwen2.5-0.5b-android",
        mode: "seller",
        activeSurface: "conversation",
        permissions: ["membership:manage"],
        sessionVersion: 1,
        shops: [
          {
            business: {
              id: "performance-shop",
              name: "Performance Shop",
              language: "en",
              grogoniId: "254P12345678"
            },
            membership: {
              id: "performance-membership",
              businessId: "performance-shop",
              userId: "performance-user",
              role: "owner"
            }
          }
        ]
      });
    }
    if (url.pathname === "/roles/check") return json({ allowed: true, role: "owner" });
    if (url.pathname === "/health") return json({ status: "ok" });
    // Opening the model library (agent settings > "Open model library") fetches these three
    // without their own fallback/catch, unlike the rest of loadAiModels's requests - an
    // unmocked 404 here throws and the library never expands. See loadAiModels in
    // AgentModelPanel.tsx.
    if (url.pathname === "/v1/ai-models") return json({ models: [] });
    if (url.pathname.endsWith("/runtime/effective") && url.pathname.startsWith("/businesses/")) {
      return json({
        agent: { id: "builtin:shopkeeper", name: "Grogoni AI", runtimeAdapterId: "grogoni" },
        model: { id: "qwen2.5-0.5b-android", name: "Qwen2.5 0.5B (Android recommended)" },
        execution: { type: "backend", hostId: null, ready: true },
        binding: activeBinding !== null ? { id: activeBinding.id } : null,
        source: activeBinding !== null ? "explicit" : "default",
        status: "READY",
        ready: true
      });
    }
    if (url.pathname.endsWith("/ai-model") && url.pathname.startsWith("/businesses/")) {
      return json({
        businessId: "performance-shop",
        modelId: "qwen2.5-0.5b-android",
        activatedAt: "2026-07-26T00:00:00.000Z",
        activatedBy: "performance-account"
      });
    }
    if (url.pathname.endsWith("/model-binding") && url.pathname.startsWith("/api/agents/")) {
      if (method === "DELETE") {
        const removedBindingId = typeof activeBinding?.id === "string" ? activeBinding.id : null;
        activeBinding = null;
        return json({
          agentId: "performance-shop",
          shopId: "performance-shop",
          binding: null,
          removedBindingId
        });
      }
      return json({ binding: activeBinding });
    }
    if (
      method === "POST" &&
      url.pathname === "/api/agents/performance-shop/models/qwen2.5-0.5b-android/activate"
    ) {
      activeBinding = {
        id: "performance-qwen-binding",
        accountId: "performance-account",
        shopId: "performance-shop",
        agentId: "performance-shop",
        modelId: "qwen2.5-0.5b-android",
        status: "active",
        executionTarget: "backend",
        executionMode: "LOCAL_FIRST",
        permissions: {
          allowInstalledApp: false,
          allowRemoteShopDevice: false
        },
        activatedAt: "2026-08-14T00:00:00.000Z",
        verifiedAt: "2026-08-14T00:00:00.000Z",
        lastVerificationStatus: "passed",
        lastErrorCode: null,
        lastErrorMessage: null,
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
        updatedBy: "performance-user"
      };
      return json({
        binding: activeBinding,
        healthCheck: {
          ok: true,
          modelId: "qwen2.5-0.5b-android",
          provider: "ollama",
          executionTarget: "backend",
          latencyMs: 12,
          responsePreview: "GROGONI_MODEL_OK",
          errorCode: null,
          message: null,
          retryable: false,
          checkedAt: "2026-08-14T00:00:00.000Z"
        }
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 750));
    return json({ code: "performance_fixture_miss" }, 404);
  });
}
