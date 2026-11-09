import { describe, expect, it } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import { signupPhone } from "./fixtures/account-auth";

const passkey = { rpId: "localhost", origin: "http://localhost" };
const password = "secure first password";

async function fixture() {
  const store = createCp2Store();
  const app = buildApi({ cp2: { store } });
  const { response, cookie } = await signupPhone(app, "passkey-step-up");
  const sessionId = response.json<{ session: { id: string } }>().session.id;
  const now = new Date();
  store.createPassword({ sessionId, password, currentPin: "3927", now });
  // A refreshed session stays valid but keeps the time its credential was last proven.
  const proven = new Date(now.getTime() - 20 * 60_000).toISOString();
  const snapshot = store.snapshot();
  Object.assign(
    snapshot.sessions.find((session) => session.id === sessionId)!,
    {
      authenticatedAt: proven,
      pinVerifiedAt: proven
    }
  );
  store.hydrateSnapshot(snapshot);
  return { app, store, cookie, sessionId, later: now };
}

describe("passkey enrollment from an old session", () => {
  it("needs the password, then allows enrollment", async () => {
    const { app, store, sessionId, later } = await fixture();
    const begin = () => store.beginPasskeyRegistration({ sessionId, ...passkey, now: later });

    await expect(begin()).rejects.toMatchObject({ code: "recent_authentication_required" });
    expect(() =>
      store.verifyAccountPassword({ sessionId, password: "not the password", now: later })
    ).toThrowError(expect.objectContaining({ code: "password_incorrect" }));
    await expect(begin()).rejects.toMatchObject({ code: "recent_authentication_required" });

    store.verifyAccountPassword({ sessionId, password, now: later });
    await expect(begin()).resolves.toHaveProperty("ceremonyId");
    await app.close();
  });

  it("limits password guesses from a stolen session", async () => {
    const { app, store, sessionId, later } = await fixture();
    const codes = Array.from({ length: 12 }, () => {
      try {
        store.verifyAccountPassword({ sessionId, password: "guess", now: later });
        return "verified";
      } catch (error) {
        return (error as { code: string }).code;
      }
    });
    expect(codes[0]).toBe("password_incorrect");
    expect(new Set(codes).size).toBe(2);
    expect(codes).not.toContain("verified");
    expect(() => store.verifyAccountPassword({ sessionId, password, now: later })).toThrow();
    await app.close();
  });

  it("serves the step-up over HTTP and needs a session", async () => {
    const { app, cookie } = await fixture();
    const verify = (body: unknown, headers: Record<string, string> = {}) =>
      app.inject({
        method: "POST",
        url: "/auth/password/verify",
        payload: body as object,
        headers
      });

    expect((await verify({ password }, { cookie })).statusCode).toBe(200);
    expect((await verify({ password: "wrong password" }, { cookie })).statusCode).toBe(401);
    expect((await verify({ password })).statusCode).toBe(401);
    await app.close();
  });

  it("reports password_not_set for a PIN-only account", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const { cookie } = await signupPhone(app, "passkey-step-up-pin-only");
    const response = await app.inject({
      method: "POST",
      url: "/auth/password/verify",
      headers: { cookie },
      payload: { password }
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ code: string }>().code).toBe("password_not_set");
    await app.close();
  });
});
