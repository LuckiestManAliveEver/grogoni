import { expect, test, type Browser, type Page } from "@playwright/test";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

/**
 * Two real phones, one real API. A locked-out PWA with no passkey asks a phone that is still
 * signed in to approve it. Both WebAuthn ceremonies are real: Chrome's virtual platform
 * authenticator signs, and the in-process API verifies with @simplewebauthn/server.
 *
 * Every browser request to the API is answered by `inject` on a Fastify app in this process, so
 * the cookie jar below stands in for each phone's cookies.
 */
const phone = "+254712345678";

async function phoneWithScreenLock(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true
    }
  });
  await page.addInitScript(() => {
    localStorage.setItem("grogoni.marketplace-intro.completed.v1", "true");
  });
  return page;
}

test("a locked-out PWA is approved by a signed-in phone, then gets its own passkey", async ({
  browser
}) => {
  test.setTimeout(120_000);
  const store = createCp2Store();
  const owner = store.signupWithPhonePin({ destination: phone, pin: "1234" });
  const api = buildApi({ cp2: { store } });
  await api.ready();

  async function connect(page: Page, jar: Map<string, string>) {
    await page.route("http://127.0.0.1:4000/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const headers = { ...(await request.allHeaders()) };
      delete headers.cookie;
      if (jar.size > 0)
        headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
      const response = await api.inject({
        method: request.method() as "GET",
        url: url.pathname + url.search,
        headers,
        ...(request.postDataBuffer() ? { payload: request.postDataBuffer()! } : {})
      });
      const setCookies = response.headers["set-cookie"];
      for (const cookie of Array.isArray(setCookies)
        ? setCookies
        : setCookies
          ? [setCookies]
          : []) {
        const [pair] = String(cookie).split(";");
        const [name, ...value] = pair!.split("=");
        if (/max-age=0/iu.test(String(cookie)) || value.join("=") === "") jar.delete(name!);
        else jar.set(name!, value.join("="));
      }
      const forwarded: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (name === "set-cookie" || name === "content-length" || value === undefined) continue;
        forwarded[name] = String(value);
      }
      await route.fulfill({
        status: response.statusCode,
        headers: forwarded,
        body: response.rawPayload
      });
    });
  }

  const pages: Page[] = [];
  try {
    // The locked-out browser: no session, no passkey, PIN forgotten.
    const lockedOut = await phoneWithScreenLock(browser);
    pages.push(lockedOut);
    await connect(lockedOut, new Map());
    await lockedOut.goto("http://localhost:5173/login");
    await lockedOut.getByLabel("Phone number", { exact: true }).fill("712345678");
    await lockedOut.getByRole("button", { name: "Trouble logging in?", exact: true }).click();
    await lockedOut.getByLabel("Recover with").selectOption("approval");
    await lockedOut.getByRole("button", { name: "Get an approval code", exact: true }).click();
    await expect(
      lockedOut.getByRole("heading", { name: "Approve from another device" })
    ).toBeVisible();
    const shown = (await lockedOut.locator(".trusted-device-code").innerText()).trim();
    expect(shown).toMatch(/^\d{3} \d{3}$/u);

    // The owner's phone, still signed in. It has no passkey yet, so it adds one first.
    const trusted = await phoneWithScreenLock(browser);
    pages.push(trusted);
    await connect(trusted, new Map([["grogoni_session", owner.session.id]]));
    await trusted.goto("http://localhost:5173/");
    const prompt = trusted.getByRole("region", { name: "Approve a browser" });
    await expect(prompt.getByText("A browser wants to log in")).toBeVisible({ timeout: 30_000 });
    // Exactly one request: the waiting screen never starts a second one behind the code it shows.
    await expect(prompt.getByText(/Chrome on Android/u)).toHaveCount(1);
    await prompt.getByLabel("Code from the other browser").fill(shown);
    await prompt.getByRole("button", { name: "Continue", exact: true }).click();
    await prompt
      .getByRole("button", { name: "Create passkey on this device", exact: true })
      .click();
    await expect(prompt.getByText("Passkey added. Enter the code again to approve.")).toBeVisible();
    await prompt.getByLabel("Code from the other browser").fill(shown);
    await prompt.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(prompt.getByText("Let in Chrome on Android?", { exact: false })).toBeVisible();
    await prompt.getByRole("button", { name: "Approve with passkey", exact: true }).click();
    await expect(prompt.getByText(/Approved Chrome on Android/u)).toBeVisible();

    // Back on the locked-out browser: it is in, and creates its own passkey.
    await expect(lockedOut.getByRole("heading", { name: "Create a passkey" })).toBeVisible({
      timeout: 15_000
    });
    await lockedOut.getByRole("button", { name: "Create passkey", exact: true }).click();
    await expect(lockedOut.getByRole("heading", { name: "Choose a new PIN" })).toBeVisible();
    await lockedOut.getByLabel("New 4-digit PIN", { exact: true }).fill("6789");
    await lockedOut.getByLabel("Confirm new PIN", { exact: true }).fill("6789");
    await lockedOut.getByRole("button", { name: "Save new PIN", exact: true }).click();
    await expect(lockedOut.getByRole("heading", { name: "Choose a new PIN" })).toHaveCount(0);

    const passkeys = store.snapshot().passkeys ?? [];
    expect(passkeys.filter((passkey) => passkey.accountId === owner.account.id)).toHaveLength(2);
    const events = (store.snapshot().auditEvents ?? []).map((event) => event.type);
    expect(events).toEqual(
      expect.arrayContaining([
        "auth.recovery_approval_requested",
        "auth.recovery_approval_approved",
        "auth.recovery_approval_completed"
      ])
    );
    // The new PIN works and the old one does not.
    expect(
      store.loginWithAccountPin({ channel: "phone", destination: phone, pin: "6789" }).account.id
    ).toBe(owner.account.id);
  } finally {
    // Close the phones first: an open app keeps polling the API.
    for (const page of pages) await page.context().close();
    await api.close();
  }
});
