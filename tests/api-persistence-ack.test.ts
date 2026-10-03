import { describe, expect, it, vi } from "vitest";
import { buildApi } from "../services/api/src/app";
import { AccountSyncPersistenceError } from "../services/api/src/cp2/postgres-store";
import { createCp2Store } from "../services/api/src/cp2/store";

describe("API persistence acknowledgement barrier", () => {
  it("waits for mutation persistence before returning success and leaves reads unblocked", async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const app = buildApi({
      cp2: { store: createCp2Store() },
      mutationPersistenceFlush: flush
    });

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(flush).not.toHaveBeenCalled();

    const response = await app.inject({
      method: "POST",
      url: "/auth/otp/request",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ channel: "email", destination: "persistence-one@example.test" })
    });

    expect(response.statusCode).toBe(200);
    expect(flush).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("does not acknowledge a mutation when persistence fails", async () => {
    const app = buildApi({
      cp2: { store: createCp2Store() },
      mutationPersistenceFlush: vi.fn().mockRejectedValue(new Error("database unavailable"))
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/otp/request",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ channel: "email", destination: "persistence-two@example.test" })
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      statusCode: 500,
      error: "Internal Server Error"
    });
    await app.close();
  });

  it("sanitizes account sync persistence failures without exposing PostgreSQL details", async () => {
    const rawDatabaseMessage =
      'new row for relation "account_sync_changes" violates check constraint';
    const app = buildApi({
      cp2: { store: createCp2Store() },
      mutationPersistenceFlush: vi
        .fn()
        .mockRejectedValue(
          new AccountSyncPersistenceError(
            "account-internal-id",
            "conversation_typing",
            "account_sync_changes_collection_check",
            { cause: new Error(rawDatabaseMessage) }
          )
        )
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/otp/request",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ channel: "email", destination: "sync-failure@example.test" })
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      code: "ACCOUNT_SYNC_INITIALIZATION_FAILED",
      message: "We could not finish setting up your account. Please try again."
    });
    expect(response.body).not.toContain(rawDatabaseMessage);
    expect(response.body).not.toContain("account_sync_changes");
    await app.close();
  });

  it("keeps PIN authentication available when only account sync persistence fails", async () => {
    const store = createCp2Store();
    const phone = "+254700200001";
    store.signupWithPhonePin({ destination: phone, pin: "1234" });
    const app = buildApi({
      cp2: { store },
      mutationPersistenceFlush: vi
        .fn()
        .mockRejectedValue(
          new AccountSyncPersistenceError(
            "account-internal-id",
            "conversation_typing",
            "account_sync_changes_collection_check"
          )
        )
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/pin/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ method: "phone", contact: phone, pin: "1234" })
    });

    expect(response.statusCode).toBe(200);
    expect(response.cookies.map((cookie) => cookie.name)).toEqual(
      expect.arrayContaining(["grogoni_session", "grogoni_refresh"])
    );
    expect(response.json()).toMatchObject({
      account: { primaryAuthDestination: phone },
      session: { id: expect.any(String) }
    });

    const authenticated = await app.inject({
      method: "GET",
      url: "/session",
      headers: {
        cookie: response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
      }
    });
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.json()).toMatchObject({
      account: { primaryAuthDestination: phone }
    });
    await app.close();
  });

  it("fails PIN authentication closed when critical session persistence fails", async () => {
    const store = createCp2Store();
    const phone = "+254700200003";
    store.signupWithPhonePin({ destination: phone, pin: "1234" });
    const app = buildApi({
      cp2: { store },
      mutationPersistenceFlush: vi.fn().mockRejectedValue(new Error("session table unavailable"))
    });

    const response = await app.inject({
      method: "POST",
      url: "/auth/pin/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ method: "phone", contact: phone, pin: "1234" })
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      code: "AUTH_PERSISTENCE_UNAVAILABLE",
      message: "Authentication could not be saved safely. Please try again."
    });
    expect(response.cookies.map((cookie) => cookie.name)).not.toContain("grogoni_session");
    expect(response.cookies.map((cookie) => cookie.name)).not.toContain("grogoni_refresh");
    expect(response.body).not.toContain("session table unavailable");
    await app.close();
  });

  it("does not hold a login response open forever behind a stalled persistence queue", async () => {
    process.env.PERSISTENCE_FLUSH_RESPONSE_DEADLINE_MS = "50";
    try {
      const store = createCp2Store();
      const phone = "+254700200002";
      store.signupWithPhonePin({ destination: phone, pin: "1234" });
      // A flush that never settles models a stuck/backlogged persistence queue (see
      // postgres-store.ts scheduleSaveRetry), not a failed one - the write is still running in
      // the background and may well complete a moment later. A deadline timeout is not itself a
      // persistence failure, so the response must not wait on it forever AND must not be treated
      // as though the write is known to have failed: the session this response's cookie points to
      // is already valid in memory on this single API instance (docs/single-instance-store-ceiling.md).
      const app = buildApi({
        cp2: { store },
        mutationPersistenceFlush: () => new Promise<void>(() => {})
      });

      const response = await app.inject({
        method: "POST",
        url: "/auth/pin/login",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ method: "phone", contact: phone, pin: "1234" })
      });

      expect(response.statusCode).toBe(200);
      expect(response.cookies.map((cookie) => cookie.name)).toEqual(
        expect.arrayContaining(["grogoni_session", "grogoni_refresh"])
      );

      const authenticated = await app.inject({
        method: "GET",
        url: "/session",
        headers: {
          cookie: response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
        }
      });
      expect(authenticated.statusCode).toBe(200);
      await app.close();
    } finally {
      delete process.env.PERSISTENCE_FLUSH_RESPONSE_DEADLINE_MS;
    }
  });
});
