/**
 * Browser eval of the user journey fixes (docs/frontend/frontend.md, "Chat gestures and guest
 * chat"). Free: no model calls. Drives a real phone-sized Chromium with touch through the paths
 * that failed in the October 2026 production journey and scores each one pass/fail.
 *
 *   EVAL_TARGET=local       vite on localhost:5173 against the Edge stand-in on localhost:8000
 *                           (pnpm edge:local, then VITE_API_BASE_URL=http://localhost:8000 vite).
 *                           Also checks the owner path, creating a throwaway shop locally.
 *   EVAL_TARGET=production  https://grogoni.com as a guest only: it creates no shop and no data
 *                           beyond the device account every visitor gets.
 *
 *   pnpm eval:user-journey:local
 *   pnpm eval:user-journey:production
 *
 * Evidence: $EVAL_OUT (default /tmp/user-journey/<target>) holds report.json and a screenshot per
 * check. Exit code 1 when the pass rate is below EVAL_PASS_THRESHOLD (default 1: every check).
 */
/* global document, localStorage, window, MutationObserver -- read only inside page.evaluate, which runs in the browser. */
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { URL } from "node:url";

const { chromium } = createRequire(import.meta.url)("@playwright/test");

const target = process.env.EVAL_TARGET === "production" ? "production" : "local";
const webUrl =
  process.env.EVAL_WEB_URL ??
  (target === "production" ? "https://grogoni.com" : "http://localhost:5173");
const apiUrl =
  process.env.EVAL_API_URL ?? (target === "production" ? `${webUrl}/api` : "http://localhost:8000");
const out = process.env.EVAL_OUT ?? `/tmp/user-journey/${target}`;
const threshold = Number(process.env.EVAL_PASS_THRESHOLD ?? "1");
const burstSize = Number(process.env.EVAL_BURST ?? "16");
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ headless: true });
/**
 * Each browser context is its own visitor. Locally there is no proxy to set x-forwarded-for, so
 * every context would share one rate-limit key and the Continue limit on new guest accounts (per
 * client address) would refuse the later ones. Each local context gets a distinct documentation
 * address, added to its API requests below the browser (a page-set header would fail CORS).
 */
async function asVisitor(context) {
  if (target !== "local") return context;
  const address = `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
  await context.route(`${apiUrl}/**`, (route) =>
    route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": address } })
  );
  return context;
}
const context = await asVisitor(
  await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true
  })
);
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
const serverErrors = [];
page.on("response", (response) => {
  // Failures this eval injects on purpose carry x-eval-simulated and are not counted.
  if (
    response.url().startsWith(apiUrl) &&
    response.status() >= 500 &&
    response.headers()["x-eval-simulated"] === undefined
  )
    serverErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
});

const results = [];
async function check(name, run) {
  const started = Date.now();
  let passed = false;
  let detail;
  try {
    detail = await run();
    passed = detail?.passed !== false;
  } catch (error) {
    detail = { error: String(error?.message ?? error).slice(0, 300) };
  }
  const screenshot = `${out}/${results.length + 1}-${name}.png`;
  await page.screenshot({ path: screenshot }).catch(() => undefined);
  results.push({ name, passed, ms: Date.now() - started, detail, screenshot });
  console.log(`${passed ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail).slice(0, 240)}`);
}

async function home() {
  await page.goto(`${webUrl}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator("textarea").first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
}

async function swipe(fromX, toX, y = 420) {
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: fromX, y }]
  });
  for (let step = 1; step <= 6; step++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: fromX + ((toX - fromX) * step) / 6, y }]
    });
    await page.waitForTimeout(15);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(1500);
}

const visibleHeadings = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("h1,h2,h3")]
      .filter((element) => element.getBoundingClientRect().height > 0)
      .map((element) => element.textContent.trim())
  );
const bodyText = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));

/** The thread's text only (the conversation list above it previews the latest message). */
const threadOnly = () =>
  page.evaluate(() =>
    (document.querySelector(".message-list")?.textContent ?? "").replace(/\s+/g, " ")
  );

async function sendChat(text) {
  // As a person would: wait until the chat has opened (the composer says so while it has not).
  await page.waitForFunction(
    () => document.querySelector("textarea")?.placeholder !== "Opening this chat…",
    undefined,
    { timeout: 30_000 }
  );
  await page.locator("textarea").first().fill(text);
  await page.getByRole("button", { name: /^send/i }).last().click();
}

await home();

/**
 * The 503 root cause: hydrating a request rewrote the shared built-in agent row every time. With
 * a database URL (local default: the stand-in's database), the burst below must leave that row's
 * updated_at untouched. Production: set EVAL_DATABASE_URL to the Neon URL to include it.
 */
const databaseUrl =
  process.env.EVAL_DATABASE_URL ??
  (target === "local" ? (await import("./edge-local-config.mjs")).edgeLocal.queueUrl : null);
async function agentRowStamp() {
  if (databaseUrl === null) return null;
  const { Client } = createRequire(new URL("../services/api/package.json", import.meta.url))("pg");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query(
      "select updated_at, record->>'updatedAt' as stamp from cp2_native_runtime_agents where entity_id = 'builtin:shopkeeper:v1'"
    );
    return rows[0] ? `${rows[0].updated_at.toISOString()} ${rows[0].stamp}` : "missing";
  } finally {
    await client.end();
  }
}
const agentRowBefore = await agentRowStamp();

await check("concurrent-reads-no-503", async () => {
  const paths = ["/v1/conversations", "/v1/shops", "/auth/session"];
  const statuses = await page.evaluate(
    async ({ apiUrl, paths, burstSize }) =>
      Promise.all(
        Array.from({ length: burstSize }, (_, index) =>
          fetch(`${apiUrl}${paths[index % paths.length]}`, { credentials: "include" })
            .then((response) => response.status)
            .catch(() => 0)
        )
      ),
    { apiUrl, paths, burstSize }
  );
  const failed = statuses.filter((status) => status >= 500 || status === 0);
  return { passed: failed.length === 0, statuses };
});

if (databaseUrl !== null) {
  await check("requests-leave-shared-agent-row-untouched", async () => {
    const after = await agentRowStamp();
    return {
      passed: agentRowBefore !== "missing" && after === agentRowBefore,
      before: agentRowBefore,
      after
    };
  });
}

await check("guest-greeting-is-explained-and-survives-refresh", async () => {
  await sendChat("hello there");
  // Longer than two 4-second thread refreshes: the exchange must not be wiped.
  await page.waitForTimeout(9_000);
  const text = await bodyText();
  return {
    passed: text.includes("hello there") && text.includes("I find products and shops on Grogoni"),
    searchedForGreeting: text.includes('lists "hello there"')
  };
});

await check("no-resend-control-with-empty-outbox", async () => {
  // Runs after a message, so the thread header (where the control lives) is showing; the check
  // only counts when that header is really on screen.
  const text = await bodyText();
  const headerShown = /Buy session|Sell session/u.test(text);
  return { passed: headerShown && !/Retry failed|waiting message/i.test(text), headerShown };
});

await check("guest-exchange-survives-a-reload", async () => {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("textarea").first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(6_000);
  const text = await bodyText();
  return {
    passed: text.includes("hello there") && text.includes("I find products and shops on Grogoni")
  };
});

await check("guest-buy-query-reports-real-results", async () => {
  await sendChat("I want to buy sugar");
  await page.waitForTimeout(9_000);
  const text = await bodyText();
  const honest =
    /I couldn't find "sugar" on Grogoni|I found \d+ items? from \d+ shops? for "sugar"/u.test(text);
  return { passed: honest && !text.includes("I searched the marketplace for that") };
});

await check("guest-questions-get-answers-not-searches", async () => {
  // Each phrase and what it must get. Search replies name the product, other replies do not.
  const expectations = [
    ["How do I open a shop", "To sell on Grogoni, tap the shop button"],
    ["Where is my order?", "I can't look up orders or deliveries"],
    ["Delivery?", "I can't look up orders or deliveries"],
    ["Habari gani", "I find products and shops on Grogoni"],
    ["Help me please", "I find products and shops on Grogoni"],
    ["Thanks bro", "You're welcome"],
    ["Thank you for your help", "You're welcome"],
    ["I need help", "I find products and shops on Grogoni"],
    ["how are you?", "I find products and shops on Grogoni"],
    ["Can I get sugar?", '"sugar"'],
    ["Thanks! I also need rice", '"rice"'],
    ["Do you have maize flour available?", '"maize flour"'],
    ["How much for cooking oil?", '"cooking oil"'],
    ["👍", "I find products and shops on Grogoni"]
  ];
  const missing = [];
  for (const [phrase, answer] of expectations) {
    const before = (await threadOnly()).length;
    await sendChat(phrase);
    await page.waitForTimeout(2_500);
    const added = (await threadOnly()).slice(before);
    if (!added.includes(answer)) missing.push(phrase);
  }
  const text = await threadOnly();
  // Nothing that is not a product was searched for as one.
  const searchedNonProducts = [
    "How do I open a shop",
    "Where is my order",
    "Habari gani",
    "Help me please",
    "Thanks bro",
    "you for your help",
    "help",
    "how are you"
  ].filter((phrase) => text.includes(`"${phrase}" on Grogoni`) || text.includes(`for "${phrase}"`));
  return {
    passed: missing.length === 0 && searchedNonProducts.length === 0,
    missing,
    searchedNonProducts
  };
});

await check("swipe-left-opens-contact-book", async () => {
  await home();
  await swipe(320, 120);
  const headings = await visibleHeadings();
  return { passed: headings.includes("My Network"), headings: headings.slice(0, 6) };
});

await check("swipe-right-opens-shops-for-a-buyer", async () => {
  await home();
  await swipe(70, 300);
  const headings = await visibleHeadings();
  return { passed: headings.includes("Explore shops"), headings: headings.slice(0, 6) };
});

await check("vertical-and-diagonal-drags-do-nothing", async () => {
  await home();
  // A thumb scrolling the thread: mostly vertical, a little sideways.
  for (const [fromX, fromY, toX, toY] of [
    [200, 650, 215, 250],
    [300, 600, 150, 380]
  ]) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: fromX, y: fromY }]
    });
    for (let step = 1; step <= 6; step++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: fromX + ((toX - fromX) * step) / 6, y: fromY + ((toY - fromY) * step) / 6 }
        ]
      });
      await page.waitForTimeout(15);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(1200);
  }
  const opened = (await visibleHeadings()).filter((heading) =>
    ["My Network", "Explore shops", "Your shop"].includes(heading)
  );
  return { passed: opened.length === 0, opened };
});

await check("short-and-edge-swipes-do-nothing", async () => {
  await home();
  await swipe(320, 290);
  await swipe(8, 300);
  const after = await visibleHeadings();
  const opened = after.filter((heading) =>
    ["My Network", "Explore shops", "Your shop"].includes(heading)
  );
  // The route may settle onto the thread's own URL meanwhile; it must never reach a panel route.
  const url = new URL(page.url()).pathname;
  return { passed: opened.length === 0 && !/network|\/sell\/shop/u.test(url), opened, url };
});

if (target === "local") {
  const shopName = `Eval Shop ${Date.now() % 100000}`;
  const createShop = (on) =>
    on.evaluate(
      async ({ apiUrl, name }) => {
        const response = await fetch(`${apiUrl}/businesses`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name,
            language: "en",
            phoneNumber: `+2547${String(Date.now()).slice(-8)}`,
            phoneCountry: "KE"
          })
        });
        return { status: response.status, body: await response.json().catch(() => null) };
      },
      { apiUrl, name: shopName }
    );
  const simulated503 = (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      headers: { "x-eval-simulated": "1" },
      body: JSON.stringify({ code: "service_unavailable", message: "Simulated by the eval" })
    });
  let ownerShop = null;

  await check("swipe-right-opens-shop-hub-for-an-owner", async () => {
    ownerShop = await createShop(page);
    await home();
    await swipe(70, 300);
    const headings = await visibleHeadings();
    return {
      passed: ownerShop.status === 200 && headings.includes("Your shop"),
      created: ownerShop.status,
      url: new URL(page.url()).pathname,
      headings: headings.slice(0, 6)
    };
  });

  await check("same-name-shop-from-another-account-gets-a-free-id", async () => {
    const other = await asVisitor(
      await browser.newContext({ viewport: { width: 390, height: 844 } })
    );
    try {
      const otherPage = await other.newPage();
      await otherPage.goto(`${webUrl}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await otherPage.locator("textarea").first().waitFor({ timeout: 60_000 });
      await otherPage.waitForTimeout(1500);
      const second = await createShop(otherPage);
      const firstId = ownerShop?.body?.business?.grogoniId;
      const secondId = second.body?.business?.grogoniId;
      return {
        passed: second.status === 200 && typeof secondId === "string" && secondId !== firstId,
        firstId,
        secondId,
        status: second.status
      };
    } finally {
      await other.close();
    }
  });

  await check("two-shops-writing-at-once-no-503", async () => {
    // Writes, not reads: reads are retried on a lost race, so a read burst can hide conflicts.
    const other = await asVisitor(
      await browser.newContext({ viewport: { width: 390, height: 844 } })
    );
    try {
      const otherPage = await other.newPage();
      await otherPage.goto(`${webUrl}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await otherPage.locator("textarea").first().waitFor({ timeout: 60_000 });
      await otherPage.waitForTimeout(1500);
      const otherShop = await createShop(otherPage);
      const burst = (on, businessId) =>
        on.evaluate(
          async ({ apiUrl, businessId }) =>
            Promise.all(
              [0, 1, 2, 3].map((index) =>
                fetch(`${apiUrl}/businesses/${businessId}/products`, {
                  method: "POST",
                  credentials: "include",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ name: `Eval product ${index}`, unit: "kg", quantity: 1 })
                })
                  .then((response) => response.status)
                  .catch(() => 0)
              )
            ),
          { apiUrl, businessId }
        );
      const [mine, theirs] = await Promise.all([
        burst(page, ownerShop?.body?.business?.id),
        burst(otherPage, otherShop.body?.business?.id)
      ]);
      const statuses = [...mine, ...theirs];
      return { passed: statuses.every((status) => status === 200), statuses };
    } finally {
      await other.close();
    }
  });

  await check("sell-before-shops-load-opens-the-owned-shop", async () => {
    // A new device for this owner whose shop list fails to load at launch.
    await page.route(`${apiUrl}/v1/session/context`, simulated503);
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage))
        if (/activeBusiness|activeAgent/u.test(key)) localStorage.removeItem(key);
    });
    await home();
    const entry = page.getByTestId("shop-entry-button");
    const shopless = await entry.isVisible();
    await page.unroute(`${apiUrl}/v1/session/context`);
    await entry.click();
    await page.waitForTimeout(4000);
    const headings = await visibleHeadings();
    const url = new URL(page.url()).pathname;
    // The shop is open: the header now shows the owner's own controls, in seller mode.
    const shopOpen = await page.getByTestId("agent-profile-link").isVisible();
    return {
      passed:
        shopless &&
        shopOpen &&
        !headings.some((heading) => /set up your business/iu.test(heading)) &&
        /^\/(?:sell|workspace)/u.test(url),
      shopless,
      shopOpen,
      url,
      headings: headings.slice(0, 6)
    };
  });

  await check("send-while-marking-read-no-503", async () => {
    await home();
    const statuses = [];
    const track = (response) => {
      if (
        response.url().startsWith(apiUrl) &&
        /\/v1\/(?:messages|conversations\/)/u.test(response.url())
      )
        statuses.push(`${response.request().method()} ${response.status()}`);
    };
    page.on("response", track);
    try {
      const conversationId = await page.evaluate(
        () => window.location.pathname.match(/conversations\/([^/]+)/u)?.[1] ?? null
      );
      await sendChat("Add 2 bags of rice to stock");
      // Read markers from the same conversation while the agent turn runs.
      const marks = await page.evaluate(
        async ({ apiUrl, conversationId }) =>
          conversationId === null
            ? []
            : Promise.all(
                [0, 1, 2].map(() =>
                  fetch(`${apiUrl}/v1/conversations/${conversationId}`, {
                    method: "PATCH",
                    credentials: "include",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ read: true })
                  }).then((response) => response.status)
                )
              ),
        { apiUrl, conversationId }
      );
      // Until the agent's turn for this message is done: it holds the account's write lock, and
      // the next check's send would otherwise queue behind it.
      for (let waited = 0; waited < 30_000; waited += 1_000) {
        await page.waitForTimeout(1_000);
        const thread = await page.evaluate(
          () => document.querySelector(".message-list")?.textContent ?? ""
        );
        const sentAt = thread.lastIndexOf("Add 2 bags of rice to stock");
        if (sentAt !== -1 && /Shopkeeper/u.test(thread.slice(sentAt))) break;
      }
      const failed = statuses.filter((entry) => / 5\d\d$/u.test(entry));
      return {
        passed: conversationId !== null && failed.length === 0 && marks.every((s) => s === 200),
        conversationId,
        marks,
        failed
      };
    } finally {
      page.off("response", track);
    }
  });

  let firstSendTrace = null;
  await check("failed-send-is-marked-kept-and-resent-automatically", async () => {
    await home();
    // Type once the conversation is open, as a person would see it load.
    await page.waitForURL(/\/conversations\//u, { timeout: 30_000 });
    await page.waitForTimeout(1_000);
    // API request timings from here on, for the report if this check fails.
    const requestLog = [];
    const started = new Map();
    const checkStart = Date.now();
    page.on("request", (request) => {
      if (request.url().startsWith(apiUrl)) started.set(request, Date.now());
    });
    page.on("requestfinished", async (request) => {
      if (!started.has(request)) return;
      const response = await request.response().catch(() => null);
      requestLog.push(
        `${started.get(request) - checkStart}+${Date.now() - started.get(request)}ms ${request.method()} ${new URL(request.url()).pathname.slice(0, 32)} ${response?.status() ?? "?"}`
      );
    });
    // Every change of the status line from here on, for the report if this check fails.
    await page.evaluate(() => {
      const log = [];
      window.__statusLog = log;
      const seen = new WeakSet();
      const watch = () => {
        for (const element of document.querySelectorAll("[role=status]")) {
          if (seen.has(element)) continue;
          seen.add(element);
          new MutationObserver(() => log.push(element.textContent.trim().slice(0, 100))).observe(
            element,
            { childList: true, subtree: true, characterData: true }
          );
        }
      };
      watch();
      new MutationObserver(watch).observe(document.body, { childList: true, subtree: true });
    });
    let posts = 0;
    await page.route(`${apiUrl}/v1/messages`, (route) => {
      if (route.request().method() !== "POST") return route.continue();
      posts++;
      return simulated503(route);
    });
    await sendChat("Add 5 bags of sugar to stock");
    // Two thread refreshes: the failed message must stay, marked, with the resend control.
    await page.waitForTimeout(9_000);
    const text = await bodyText();
    firstSendTrace = await page.evaluate(() => ({
      path: window.location.pathname,
      placeholder: document.querySelector("textarea")?.placeholder ?? null,
      draft: document.querySelector("textarea")?.value ?? null
    }));
    const marked =
      text.includes("Add 5 bags of sugar to stock") &&
      text.includes("Not sent yet · retrying") &&
      text.includes("Send 1 waiting message");
    const postsWhileDown = posts;
    // Still failing: the outbox resends on its own (every 15s at most) without an online event.
    await page.waitForTimeout(17_000);
    const resentAutomatically = posts > postsWhileDown;
    // A second message while the first waits goes behind it, not past it.
    const postsBeforeSecond = posts;
    await sendChat("Actually make it 10 bags");
    await page.waitForTimeout(2_000);
    const queuedBehind =
      posts === postsBeforeSecond &&
      (await bodyText()).includes("Waiting to send") &&
      (await bodyText()).includes("Send 2 waiting messages");
    // The API recovers: one tap sends both, in the order they were typed.
    await page.unroute(`${apiUrl}/v1/messages`);
    const tapped = await page
      .getByRole("button", { name: /^Send 2 waiting messages$/u })
      .click({ timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!tapped) {
      const state = await page.evaluate(() => ({
        buttons: [...document.querySelectorAll("button")]
          .map((button) => button.textContent?.trim() ?? "")
          .filter((text) => /waiting|Send/u.test(text)),
        outbox: Object.entries(localStorage)
          .filter(([key]) => key.includes("messaging-outbox"))
          .map(([, value]) =>
            JSON.parse(value).map((entry) => ({
              id: entry.clientMessageId.slice(-6),
              conversation: entry.payload.conversationId?.slice(0, 8),
              attempts: entry.attempts
            }))
          ),
        path: window.location.pathname,
        statuses: [...document.querySelectorAll("[role=status], [aria-live]")]
          .map((element) => element.textContent?.trim().slice(0, 120) ?? "")
          .filter(Boolean),
        draft: document.querySelector("textarea")?.value ?? null,
        statusLog: [...new Set(window.__statusLog ?? [])].slice(0, 30),
        thread: (document.querySelector(".message-list")?.textContent ?? "").slice(-400)
      }));
      return {
        passed: false,
        marked,
        resentAutomatically,
        queuedBehind,
        tapped,
        firstSendTrace,
        state,
        slowRequests: requestLog.filter(
          (entry) => Number(entry.split("+")[1].split("ms")[0]) > 2_000
        )
      };
    }
    // Each resend runs an agent turn, which can take several seconds: wait until both are done.
    // The thread itself: the conversation list above it previews the latest message too.
    const threadText = () =>
      page.evaluate(() =>
        (document.querySelector(".message-list")?.textContent ?? "").replace(/\s+/g, " ")
      );
    let after = "";
    for (let waited = 0; waited < 30_000; waited += 2_000) {
      await page.waitForTimeout(2_000);
      after = await threadText();
      if (!/Not sent yet|Waiting to send/u.test(after)) break;
    }
    // Both messages delivered, in order. (The header may still offer to rerun an agent turn that
    // failed after its message was saved, e.g. with no model configured locally: that is the
    // agent retry, not an unsent message.)
    const delivered =
      !/Not sent yet|Waiting to send/u.test(after) &&
      after.indexOf("Add 5 bags of sugar to stock") > -1 &&
      after.indexOf("Add 5 bags of sugar to stock") < after.indexOf("Actually make it 10 bags");
    return {
      passed: marked && resentAutomatically && queuedBehind && delivered,
      marked,
      resentAutomatically,
      queuedBehind,
      delivered,
      posts,
      ...(delivered
        ? {}
        : {
            labels: after.match(/Not sent yet|Waiting to send/gu) ?? [],
            thread: after,
            order: [
              after.indexOf("Add 5 bags of sugar to stock"),
              after.indexOf("Actually make it 10 bags")
            ]
          })
    };
  });
}

await browser.close();
const passed = results.filter((result) => result.passed).length;
const report = {
  target,
  webUrl,
  apiUrl,
  ranAt: new Date().toISOString(),
  passRate: passed / results.length,
  threshold,
  serverErrors,
  results
};
await writeFile(`${out}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `\n${passed}/${results.length} passed · server 5xx seen: ${serverErrors.length} · ${out}/report.json`
);
process.exit(report.passRate >= threshold ? 0 : 1);
