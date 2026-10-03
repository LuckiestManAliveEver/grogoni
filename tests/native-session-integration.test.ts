import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import {
  clearCachedAuthSession,
  hasServerAuthenticatedSession,
  isAuthBootstrapPending,
  readCachedAuthSession,
  saveCachedAuthSession
} from "../apps/web/src/auth-bootstrap";
import { agentSessionAuthScenarios } from "./ai-eval/agent-session-auth-scenarios";

describe("native-style account session lifecycle", () => {
  it("bootstraps a device session and rotates refresh credentials", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const signup = await app.inject({
      method: "POST",
      url: "/auth/pin/signup",
      headers: deviceHeaders("device-one"),
      payload: { method: "phone", contact: "+254700003001", pin: "1234" }
    });
    const originalCookies = cookieHeader(signup.headers["set-cookie"]);

    const bootstrap = await app.inject({
      method: "GET",
      url: "/auth/bootstrap",
      headers: { cookie: originalCookies }
    });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json()).toMatchObject({
      authenticated: true,
      deviceSession: { deviceId: "device-one", status: "active", current: true }
    });

    const refresh = await app.inject({
      method: "POST",
      url: "/auth/session/refresh",
      headers: { ...deviceHeaders("device-one", false), cookie: originalCookies }
    });
    expect(refresh.statusCode).toBe(200);
    const rotatedCookies = cookieHeader(refresh.headers["set-cookie"]);
    expect(rotatedCookies).not.toBe(originalCookies);
    await app.close();
  });

  it("tolerates a near-simultaneous second refresh with the pre-rotation cookie (e.g. two tabs)", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const signup = await app.inject({
      method: "POST",
      url: "/auth/pin/signup",
      headers: deviceHeaders("device-one"),
      payload: { method: "phone", contact: "+254700003002", pin: "1234" }
    });
    const originalCookies = cookieHeader(signup.headers["set-cookie"]);

    const firstTab = await app.inject({
      method: "POST",
      url: "/auth/session/refresh",
      headers: { ...deviceHeaders("device-one", false), cookie: originalCookies }
    });
    expect(firstTab.statusCode).toBe(200);
    const firstTabCookies = cookieHeader(firstTab.headers["set-cookie"]);

    // A second tab/request still holding the pre-rotation cookie, arriving moments later, must
    // not be treated as a stolen-token replay - it gets handed the same rotated session instead.
    const secondTab = await app.inject({
      method: "POST",
      url: "/auth/session/refresh",
      headers: { ...deviceHeaders("device-one", false), cookie: originalCookies }
    });
    expect(secondTab.statusCode).toBe(200);
    const firstTabBody = firstTab.json<{ session: { id: string } }>();
    const secondTabBody = secondTab.json<{ session: { id: string } }>();
    expect(secondTabBody.session.id).toBe(firstTabBody.session.id);
    expect(cookieHeader(secondTab.headers["set-cookie"])).toBe(firstTabCookies);

    const stillActive = await app.inject({
      method: "GET",
      url: "/auth/bootstrap",
      headers: { cookie: firstTabCookies }
    });
    expect(stillActive.statusCode).toBe(200);
    expect(stillActive.json()).toMatchObject({ authenticated: true });
    await app.close();
  });

  it("rejects reuse of a pre-rotation cookie once the grace period has passed", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const signup = await app.inject({
      method: "POST",
      url: "/auth/pin/signup",
      headers: deviceHeaders("device-one"),
      payload: { method: "phone", contact: "+254700003003", pin: "1234" }
    });
    const originalCookies = cookieHeader(signup.headers["set-cookie"]);

    const refresh = await app.inject({
      method: "POST",
      url: "/auth/session/refresh",
      headers: { ...deviceHeaders("device-one", false), cookie: originalCookies }
    });
    expect(refresh.statusCode).toBe(200);
    const rotatedCookies = cookieHeader(refresh.headers["set-cookie"]);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 20_000));
    try {
      const reused = await app.inject({
        method: "POST",
        url: "/auth/session/refresh",
        headers: { ...deviceHeaders("device-one", false), cookie: originalCookies }
      });
      expect(reused.statusCode).toBe(401);
      expect(reused.json()).toMatchObject({ code: "auth_refresh_reuse_detected" });

      const revokedFamily = await app.inject({
        method: "GET",
        url: "/auth/bootstrap",
        headers: { cookie: rotatedCookies }
      });
      expect(revokedFamily.statusCode).toBe(401);
    } finally {
      vi.useRealTimers();
    }
    await app.close();
  });

  it("rejects refresh with no credential and rejects refresh after logout", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });

    const noCookie = await app.inject({
      method: "POST",
      url: "/auth/session/refresh",
      headers: deviceHeaders("device-one", false)
    });
    expect(noCookie.statusCode).toBe(401);
    expect(noCookie.json()).toMatchObject({ code: "auth_refresh_required" });

    const invalidCookie = await app.inject({
      method: "POST",
      url: "/auth/session/refresh",
      headers: { ...deviceHeaders("device-one", false), cookie: "grogoni_refresh=not-a-real-token" }
    });
    expect(invalidCookie.statusCode).toBe(401);
    expect(invalidCookie.json()).toMatchObject({ code: "auth_refresh_revoked" });

    const signup = await app.inject({
      method: "POST",
      url: "/auth/pin/signup",
      headers: deviceHeaders("device-one"),
      payload: { method: "phone", contact: "+254700003009", pin: "1234" }
    });
    const cookies = cookieHeader(signup.headers["set-cookie"]);

    const loggedOut = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: cookies }
    });
    expect(loggedOut.statusCode).toBe(200);

    const refreshAfterLogout = await app.inject({
      method: "POST",
      url: "/auth/session/refresh",
      headers: { ...deviceHeaders("device-one", false), cookie: cookies }
    });
    expect(refreshAfterLogout.statusCode).toBe(401);
    expect(refreshAfterLogout.json()).toMatchObject({ code: "auth_refresh_revoked" });
    await app.close();
  });

  it("logs out one device family without revoking another device", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const signup = await app.inject({
      method: "POST",
      url: "/auth/pin/signup",
      headers: deviceHeaders("phone-one"),
      payload: { method: "phone", contact: "+254700003002", pin: "1234" }
    });
    const firstCookies = cookieHeader(signup.headers["set-cookie"]);
    const login = await app.inject({
      method: "POST",
      url: "/auth/pin/login",
      headers: deviceHeaders("phone-two"),
      payload: { method: "phone", contact: "+254700003002", pin: "1234" }
    });
    const secondCookies = cookieHeader(login.headers["set-cookie"]);

    await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie: firstCookies } });
    const first = await app.inject({
      method: "GET",
      url: "/auth/bootstrap",
      headers: { cookie: firstCookies }
    });
    const second = await app.inject({
      method: "GET",
      url: "/auth/bootstrap",
      headers: { cookie: secondCookies }
    });
    expect(first.statusCode).toBe(401);
    expect(second.statusCode).toBe(200);
    await app.close();
  });

  it("logs out every device and clears both browser authentication cookies", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const signup = await app.inject({
      method: "POST",
      url: "/auth/pin/signup",
      headers: deviceHeaders("all-devices-one"),
      payload: { method: "phone", contact: "+254700003004", pin: "1234" }
    });
    const firstCookies = cookieHeader(signup.headers["set-cookie"]);
    const login = await app.inject({
      method: "POST",
      url: "/auth/pin/login",
      headers: deviceHeaders("all-devices-two"),
      payload: { method: "phone", contact: "+254700003004", pin: "1234" }
    });
    const secondCookies = cookieHeader(login.headers["set-cookie"]);

    const logoutAll = await app.inject({
      method: "POST",
      url: "/auth/logout-all",
      headers: { cookie: firstCookies }
    });
    const clearedCookies = JSON.stringify(logoutAll.headers["set-cookie"]);
    const [first, second] = await Promise.all([
      app.inject({ method: "GET", url: "/auth/bootstrap", headers: { cookie: firstCookies } }),
      app.inject({ method: "GET", url: "/auth/bootstrap", headers: { cookie: secondCookies } })
    ]);

    expect(logoutAll.statusCode).toBe(200);
    expect(logoutAll.json()).toMatchObject({ revoked: 2 });
    expect(clearedCookies).toContain("grogoni_session=");
    expect(clearedCookies).toContain("grogoni_refresh=");
    expect(first.statusCode).toBe(401);
    expect(second.statusCode).toBe(401);
    await app.close();
  });
});

describe("frontend lifecycle state", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("persists only the non-secret bootstrap view for offline restoration", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    });
    saveCachedAuthSession({
      account: {
        id: "account-1",
        primaryAuthChannel: "phone",
        primaryAuthDestination: "+254700003003"
      },
      user: { id: "user-1", accountId: "account-1", displayName: "Jane", language: "en" },
      session: { id: "session-view", expiresAt: "2030-01-01T00:00:00.000Z" }
    });
    expect(readCachedAuthSession()).toMatchObject({
      account: { id: "account-1" },
      user: { id: "user-1" }
    });
    expect([...values.values()].join(" ")).not.toMatch(/refresh|password|1234/i);
    clearCachedAuthSession();
    expect(readCachedAuthSession()).toBeNull();
  });

  it("classifies pending bootstrap states", () => {
    expect(isAuthBootstrapPending("initializing")).toBe(true);
    expect(isAuthBootstrapPending("restoring-session")).toBe(true);
    expect(isAuthBootstrapPending("authenticated")).toBe(false);
    expect(hasServerAuthenticatedSession("offline-authenticated")).toBe(false);
    expect(hasServerAuthenticatedSession("failed")).toBe(false);
    expect(hasServerAuthenticatedSession("authenticated")).toBe(true);
  });

  it("keeps every frozen agent-session lifecycle scenario behind canonical authentication", () => {
    for (const scenario of agentSessionAuthScenarios) {
      expect(hasServerAuthenticatedSession(scenario.bootstrapState), scenario.name).toBe(
        scenario.serverSessionCreationAllowed
      );
    }
  });
});

function deviceHeaders(deviceId: string, includeContentType = true): Record<string, string> {
  return {
    ...(includeContentType ? { "content-type": "application/json" } : {}),
    "x-grogoni-device-id": deviceId,
    "x-grogoni-device-name": `${deviceId} name`,
    "x-grogoni-platform": "android",
    "x-grogoni-client": "pwa",
    "user-agent": "Grogoni test device"
  };
}

function cookieHeader(header: string | string[] | undefined): string {
  const values = Array.isArray(header) ? header : header === undefined ? [] : [header];
  const cookies = values.flatMap((value) => value.split(/,(?=\s*[^;,]+=)/u));
  if (cookies.length < 2) throw new Error("Expected access and refresh cookies.");
  return cookies.map((cookie) => cookie.trim().split(";")[0]).join("; ");
}
