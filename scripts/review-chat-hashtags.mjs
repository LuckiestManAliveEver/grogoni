import { chromium, expect } from "@playwright/test";
import { buildApi } from "../services/api/src/app.ts";
import { createCp2Store } from "../services/api/src/cp2/store.ts";
import { createOpenRouterRuntime } from "../services/api/src/inference/openrouter-runtime.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { URL } from "node:url";
import { runtimeToolRegistry } from "../packages/tool-core/src/registry/index.ts";
const origin = process.env.BROWSER_REVIEW_ORIGIN ?? "http://127.0.0.1:5176";
const output = ".test-tmp/chat-hashtag-review";
await mkdir(output, { recursive: true });
const models = createOpenRouterRuntime();
const app = buildApi({
  webRoot: false,
  allowedCorsOrigins: [origin],
  cp2: { store: createCp2Store({ modelRuntimeAdapterResolver: (input) => models.resolve(input) }) }
});
app.log.level = "silent";
const browser = await chromium.launch({ headless: true });
const report = { steps: [], models: [] };
try {
  const context = await browser.newContext({
    viewport: { width: 1366, height: 860 },
    serviceWorkers: "block"
  });
  await context.route("**/api/**", async (route) => {
    try {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/v1/ai/turn-stream/")) {
        await route.fulfill({
          status: 404,
          body: "Preview transport unavailable in inject harness"
        });
        return;
      }
      const result = await app.inject({
        method: request.method(),
        url: url.pathname.slice(4) + url.search,
        headers: request.headers(),
        ...(request.postData() ? { payload: request.postData() } : {})
      });
      const headers = { ...result.headers };
      if (headers["set-cookie"])
        headers["set-cookie"] = (
          Array.isArray(headers["set-cookie"])
            ? headers["set-cookie"].join("\n")
            : headers["set-cookie"]
        )
          .replace(/;\s*Secure/gi, "")
          .replace(/;\s*Domain=[^;\n]+/gi, "");
      for (const key of Object.keys(headers)) if (headers[key] === undefined) delete headers[key];
      if (
        url.pathname.endsWith("/runtime/turns") ||
        url.pathname.endsWith("/v1/messages") ||
        url.pathname.endsWith("/images/read")
      ) {
        const body = result.json();
        report.models.push({
          path: url.pathname,
          status: result.statusCode,
          model: body.turn?.model?.modelId ?? body.runtime?.turn?.model?.modelId ?? body.engine,
          code: body.code,
          message: body.message
        });
      }
      await route.fulfill({ status: result.statusCode, headers, body: result.body });
    } catch (e) {
      console.log("RELAY", e.name);
      await route.abort();
    }
  });
  const p = await context.newPage();
  p.setDefaultTimeout(30000);
  await p.goto(origin + "/marketplace");
  await p.getByRole("textbox", { name: "Message", exact: true }).waitFor({ timeout: 60000 });
  const call = (path, body, method = "POST") =>
    p.evaluate(
      async ({ path, body, method }) => {
        const r = await fetch("/api" + path, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: globalThis.AbortSignal.timeout(30000)
        });
        return { status: r.status, body: await r.json() };
      },
      { path, body, method }
    );
  const buyerDraft = p.getByRole("textbox", { name: "Message", exact: true });
  await buyerDraft.fill("#");
  await expect(p.locator(".hashtag-capability-list button")).toHaveCount(
    Object.keys(runtimeToolRegistry).length + 1
  );
  await buyerDraft.fill("#reports.summary");
  await p.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    p.getByText("Choose or create a shop before asking the authorized business runtime to act.", {
      exact: true
    })
  ).toBeVisible();
  report.buyerShopPrerequisite = true;
  const signup = await call("/auth/pin/signup", {
    method: "phone",
    contact: "+442079460981",
    pin: "3841"
  });
  if (signup.status !== 200) throw new Error("Signup " + signup.status);
  const created = await call("/businesses", {
    name: "Isolated hashtag browser review",
    language: "en"
  });
  if (created.status !== 200) throw new Error("Shop " + created.status);
  const business = created.body.business;
  await p.evaluate((b) => {
    globalThis.localStorage.setItem(
      "grogoni.chatFirst.activeBusiness",
      JSON.stringify({ ...b, role: "owner" })
    );
    globalThis.localStorage.setItem("grogoni.chatFirst.mode", "seller");
  }, business);
  await p.goto(origin + "/sell");
  await p.getByRole("textbox", { name: "Message", exact: true }).waitFor({ timeout: 60000 });

  const createdConversation = await call("/v1/conversations", {
    kind: "personal",
    activeShopId: business.id,
    title: "Hashtag tool review"
  });
  const conversationId = createdConversation.body.conversation.id;
  await call(
    "/v1/session/context",
    { mode: "seller", activeShopId: business.id, activeSurface: "conversation", conversationId },
    "PATCH"
  );
  const chatUrl = origin + "/workspace/conversations/" + conversationId;
  await p.goto(chatUrl);
  for (const tool of Object.keys(runtimeToolRegistry)) {
    const box = p.getByRole("textbox", { name: "Message", exact: true });
    await box.waitFor({ timeout: 60000 });
    await p.waitForTimeout(350);
    await box.fill("#" + tool + " {}");
    await p.waitForTimeout(200);
    const responsePromise = p.waitForResponse(
      (r) => {
        if (r.request().method() !== "POST") return false;
        try {
          const data = r.request().postDataJSON();
          return (
            data?.agent?.message === "#" + tool + " {}" || data?.message === "#" + tool + " {}"
          );
        } catch {
          return false;
        }
      },
      { timeout: 90000 }
    );
    await p.getByRole("button", { name: "Send", exact: true }).click();
    const response = await responsePromise;
    const body = await response.json();
    const runtime =
      body.runtime ??
      body.agent?.runtime ??
      body.agentProcessing?.runtime ??
      (body.turn ? body : null);
    await p.waitForTimeout(350);
    if (response.status() !== 200 && tool !== "computer.session.create")
      throw new Error(tool + " returned HTTP " + response.status());
    if (runtime && runtime.turn.plan.toolName !== tool)
      throw new Error(tool + " routed to " + runtime.turn.plan.toolName);
    report.steps.push({
      tool,
      status: response.status(),
      runtime: runtime
        ? {
            session: runtime.session,
            turn: {
              status: runtime.turn.status,
              plan: runtime.turn.plan,
              response: runtime.turn.response
            }
          }
        : null,
      keys: Object.keys(body),
      ui: (await p.locator("body").innerText()).slice(-3500)
    });
    console.log(
      "TOOL",
      tool,
      response.status(),
      runtime?.turn?.plan?.toolName ?? JSON.stringify(Object.keys(body)),
      runtime?.turn?.status ?? ""
    );
    if (response.status() >= 500) await p.screenshot({ path: output + "/" + tool + ".png" });
    await writeFile(output + "/routes.json", JSON.stringify(report, null, 2));
  }
  await p.screenshot({ path: output + "/completed.png", fullPage: true });
} catch (e) {
  report.error = e.message;
  process.exitCode = 1;
  console.log("FAIL", e.message);
  await writeFile(
    output + "/failure-ui.txt",
    await browser.contexts()[0].pages()[0].locator("body").innerText()
  );
} finally {
  await browser.close();
  await app.close();
  await writeFile(output + "/routes.json", JSON.stringify(report, null, 2));
}
