import { describe, expect, it } from "vitest";

import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";

describe("agent runtime session authentication contract", () => {
  it("uses the login session to create one idempotent business-bound runtime session", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "+254700008001", "Authenticated Shop");
    const body = { idempotencyKey: "runtime:authenticated-owner-request" };

    const first = await app.inject({
      method: "POST",
      url: `/businesses/${owner.businessId}/runtime/sessions`,
      headers: { ...jsonHeaders(), cookie: owner.cookies },
      payload: body
    });
    const replay = await app.inject({
      method: "POST",
      url: `/businesses/${owner.businessId}/runtime/sessions`,
      headers: { ...jsonHeaders(), cookie: owner.cookies },
      payload: body
    });

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
    expect(
      store.snapshot().runtimeSessions.filter((session) => session.businessId === owner.businessId)
    ).toHaveLength(1);
    await app.close();

    const restoredStore = createCp2Store();
    restoredStore.hydrateSnapshot(store.snapshot());
    const restoredApp = buildApi({ cp2: { store: restoredStore } });
    const replayAfterRestart = await restoredApp.inject({
      method: "POST",
      url: `/businesses/${owner.businessId}/runtime/sessions`,
      headers: { ...jsonHeaders(), cookie: owner.cookies },
      payload: body
    });
    expect(replayAfterRestart.statusCode).toBe(200);
    expect(replayAfterRestart.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
    expect(restoredStore.snapshot().runtimeSessions).toHaveLength(1);
    await restoredApp.close();
  });

  it("refreshes an expired access credential and then creates the runtime session", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "+254700008002", "Refresh Shop");
    const snapshot = store.snapshot();
    store.hydrateSnapshot({
      ...snapshot,
      sessions: snapshot.sessions.map((session) => ({
        ...session,
        expiresAt: new Date(Date.now() - 1_000).toISOString()
      }))
    });

    const expired = await app.inject({
      method: "POST",
      url: `/businesses/${owner.businessId}/runtime/sessions`,
      headers: { ...jsonHeaders(), cookie: owner.cookies },
      payload: { idempotencyKey: "runtime:expired-access-request" }
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toMatchObject({ code: "auth_required" });
    expect(store.snapshot().runtimeSessions).toHaveLength(0);

    const refresh = await app.inject({
      method: "POST",
      url: "/auth/session/refresh",
      headers: { ...deviceHeaders("refresh-device", false), cookie: owner.cookies }
    });
    expect(refresh.statusCode).toBe(200);

    const created = await app.inject({
      method: "POST",
      url: `/businesses/${owner.businessId}/runtime/sessions`,
      headers: {
        ...jsonHeaders(),
        cookie: cookieHeader(refresh.headers["set-cookie"])
      },
      payload: { idempotencyKey: "runtime:expired-access-request" }
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      businessId: owner.businessId,
      status: "active"
    });
    expect(store.snapshot().runtimeSessions).toHaveLength(1);
    await app.close();
  });

  it("rejects another account's business and implicit business agent without creating a session", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const first = await createOwnerBusiness(app, "+254700008003", "First Owner Shop");
    const second = await createOwnerBusiness(app, "+254700008004", "Second Owner Shop");

    const forbidden = await app.inject({
      method: "POST",
      url: `/businesses/${second.businessId}/runtime/sessions`,
      headers: { ...jsonHeaders(), cookie: first.cookies },
      payload: { idempotencyKey: "runtime:cross-account-request" }
    });

    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ code: "membership_required" });
    expect(store.snapshot().runtimeSessions).toHaveLength(0);
    await app.close();
  });

  it("rejects a missing browser credential without creating a runtime session", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "+254700008005", "Protected Shop");

    const response = await app.inject({
      method: "POST",
      url: `/businesses/${owner.businessId}/runtime/sessions`,
      headers: jsonHeaders(),
      payload: { idempotencyKey: "runtime:missing-cookie-request" }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "auth_required" });
    expect(store.snapshot().runtimeSessions).toHaveLength(0);
    await app.close();
  });
});

async function createOwnerBusiness(
  app: ReturnType<typeof buildApi>,
  contact: string,
  name: string
): Promise<{ businessId: string; cookies: string }> {
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: deviceHeaders("refresh-device"),
    payload: { method: "phone", contact, pin: "1234" }
  });
  expect(signup.statusCode).toBe(200);
  const cookies = cookieHeader(signup.headers["set-cookie"]);
  const business = await app.inject({
    method: "POST",
    url: "/businesses",
    headers: { ...jsonHeaders(), cookie: cookies },
    payload: { name, language: "en" }
  });
  expect(business.statusCode).toBe(200);
  return {
    businessId: business.json<{ business: { id: string } }>().business.id,
    cookies
  };
}

function deviceHeaders(deviceId: string, includeContentType = true): Record<string, string> {
  return {
    ...(includeContentType ? jsonHeaders() : {}),
    "x-grogoni-device-id": deviceId,
    "x-grogoni-device-name": `${deviceId} name`,
    "x-grogoni-platform": "android",
    "x-grogoni-client": "pwa",
    "user-agent": "Grogoni agent authentication test"
  };
}

function jsonHeaders(): Record<string, string> {
  return { "content-type": "application/json" };
}

function cookieHeader(header: string | string[] | undefined): string {
  const values = Array.isArray(header) ? header : header === undefined ? [] : [header];
  const cookies = values.flatMap((value) => value.split(/,(?=\s*[^;,]+=)/u));
  if (cookies.length < 2) throw new Error("Expected access and refresh cookies.");
  return cookies.map((cookie) => cookie.trim().split(";")[0]).join("; ");
}
