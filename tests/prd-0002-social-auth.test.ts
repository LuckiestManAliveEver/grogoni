import { signupPhone } from "./fixtures/account-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import type { OAuthProvider } from "../packages/shared-types/src";

const providers: OAuthProvider[] = [
  "google",
  "facebook",
  "tiktok",
  "apple",
  "github",
  "microsoft",
  "linkedin",
  "x"
];

describe("authentication channels", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps phone PIN available and rejects email OTP session creation", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    await signupPhone(app, "social-auth-boundary");
    const email = await app.inject({
      method: "POST",
      url: "/auth/otp/request",
      payload: { method: "email", contact: "owner@example.com" }
    });
    expect(email.statusCode).toBe(403);
    expect(email.json()).toMatchObject({ code: "phone_login_required" });
    expect(email.headers["set-cookie"]).toBeUndefined();
    expect(store.snapshot().accounts).toHaveLength(1);
    await app.close();
  });

  it("publishes every OAuth provider as disabled", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const response = await app.inject({ method: "GET", url: "/auth/oauth/providers" });

    expect(response.statusCode).toBe(200);
    expect(response.json().providers).toEqual(
      providers.map((provider) =>
        expect.objectContaining({
          id: provider,
          enabled: false,
          configured: false
        })
      )
    );

    await app.close();
  });

  it("publishes an OAuth provider when its feature flag and credentials are configured", async () => {
    vi.stubEnv("OAUTH_GOOGLE_ENABLED", "true");
    vi.stubEnv("OAUTH_GOOGLE_CLIENT_ID", "google-client-id");
    vi.stubEnv("OAUTH_GOOGLE_CLIENT_SECRET", "google-client-secret");
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const response = await app.inject({ method: "GET", url: "/auth/oauth/providers" });
    const google = response
      .json()
      .providers.find((provider: { id: OAuthProvider }) => provider.id === "google");

    expect(response.statusCode).toBe(200);
    expect(google).toMatchObject({
      id: "google",
      enabled: true,
      configured: true
    });

    await app.close();
  });

  it.each(providers)("rejects %s OAuth login before creating a session", async (provider) => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const response = await app.inject({
      method: "POST",
      url: "/auth/oauth/start",
      headers: jsonHeaders(),
      payload: JSON.stringify({
        provider,
        redirectUri: "http://127.0.0.1:5173/auth/oauth/callback"
      })
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "oauth_provider_disabled" });

    await app.close();
  });

  it("rejects the legacy social-login endpoint", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const response = await app.inject({
      method: "POST",
      url: "/auth/social/login",
      headers: jsonHeaders(),
      payload: JSON.stringify({ provider: "google", email: "owner@example.com" })
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "social_login_disabled" });

    await app.close();
  });

  it("rejects direct OAuth callback completion", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    const response = await app.inject({
      method: "POST",
      url: "/auth/oauth/callback",
      headers: jsonHeaders(),
      payload: JSON.stringify({
        provider: "google",
        state: "disabled-state",
        csrfToken: "disabled-csrf",
        code: "disabled-code"
      })
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "oauth_provider_disabled" });

    await app.close();
  });
});

function jsonHeaders() {
  return { "content-type": "application/json" };
}
