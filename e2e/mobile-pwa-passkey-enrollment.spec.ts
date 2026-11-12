import { expect, test, type Page, type Route } from "@playwright/test";

const account = {
  id: "account-passkey",
  primaryAuthChannel: "phone",
  primaryAuthDestination: "+254712345678",
  status: "active",
  identityLevel: "strong"
};
const signedIn = {
  authenticated: true,
  isNewAccount: false,
  mfaRequired: false,
  session: {
    id: "session-passkey",
    accountId: account.id,
    expiresAt: "2099-01-01T00:00:00.000Z"
  },
  deviceSession: { id: "device-passkey" },
  account,
  user: { id: "user-passkey", displayName: "Jane", language: "en" },
  memberships: [],
  stores: [],
  agents: []
};
const registrationOptions = {
  ceremonyId: "registration-ceremony",
  options: {
    challenge: Buffer.from("server-generated-registration-challenge").toString("base64url"),
    rp: { name: "Grogoni", id: "localhost" },
    user: {
      id: Buffer.from(account.id).toString("base64url"),
      name: account.primaryAuthDestination,
      displayName: "Jane"
    },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    timeout: 60_000,
    attestation: "none"
  }
};

async function useVirtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
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
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

test("signup includes a real passkey step", async ({ page }) => {
  await useVirtualAuthenticator(page);
  const registered: unknown[] = [];
  await page.route("http://127.0.0.1:4000/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/auth/signup/start") return json(route, { transactionId: "signup" });
    if (path === "/auth/signup/complete") return json(route, signedIn);
    if (path === "/auth/passkeys/register/options") return json(route, registrationOptions);
    if (path === "/auth/passkeys/register/verify") {
      registered.push(route.request().postDataJSON().ceremonyId);
      return json(route, { id: "passkey-1", label: "Phone" });
    }
    if (path === "/auth/passkeys") return json(route, { passkeys: [{ id: "passkey-1" }] });
    if (path === "/auth/oauth/providers") return json(route, { providers: [] });
    return json(
      route,
      { code: "auth_session_expired", message: "Authentication is required." },
      401
    );
  });

  await page.goto("http://localhost:5173/signup");
  await page.getByLabel("Phone number", { exact: true }).fill("712345678");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel("Display name").fill("Jane");
  await page.getByLabel("Password", { exact: true }).fill("secure first password");
  await page.getByLabel("Confirm password").fill("secure first password");
  for (const box of await page.getByRole("checkbox").all()) await box.check();
  await page.getByRole("button", { name: "Create account", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Create your passkey" })).toBeVisible();
  await expect(page.getByText(/device security|secure this device/iu)).toHaveCount(0);
  await page.getByRole("button", { name: "Create passkey", exact: true }).click();
  await expect.poll(() => registered).toEqual(["registration-ceremony"]);
});

test("browsing with an existing session does not prompt for credentials", async ({ page }) => {
  await useVirtualAuthenticator(page);
  const credentialRequests: string[] = [];
  await page.route("http://127.0.0.1:4000/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/auth/passkeys") || path === "/auth/credentials/status") {
      credentialRequests.push(path);
      return json(route, { passkeys: [] });
    }
    if (path === "/session" || path === "/auth/bootstrap") return json(route, signedIn);
    if (path === "/auth/oauth/providers") return json(route, { providers: [] });
    if (path === "/roles/check") return json(route, { allowed: true });
    if (path === "/v1/marketplace-intro") {
      return json(route, { completedAt: "2026-07-17T00:00:00.000Z" });
    }
    if (path === "/v1/conversations") return json(route, { conversations: [] });
    return json(route, { message: `The test does not provide ${path}.` }, 404);
  });
  await page.goto("http://localhost:5173/");
  await expect(page.getByRole("region", { name: "Set up account passkey" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Create your passkey" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open menu", exact: true })).toBeVisible();
  expect(credentialRequests).toEqual([]);
});
