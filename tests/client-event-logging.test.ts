// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildClientLogPayload,
  logAuthenticationLifecycle,
  logClientEvent,
  sanitizeClientLogMetadata
} from "../apps/web/src/chat-message-plumbing";
import type { SessionResponse } from "../apps/web/src/grogoni-application-shared";

function fakeSession(): SessionResponse {
  return {
    account: { id: "account-1" },
    session: { id: "session-secret-1" }
  } as unknown as SessionResponse;
}

describe("sanitizeClientLogMetadata", () => {
  it("drops authentication/session credential keys", () => {
    const sanitized = sanitizeClientLogMetadata({
      accountId: "account-1",
      sessionId: "session-secret-1",
      sessionToken: "tok",
      accessToken: "tok",
      refreshToken: "tok",
      authorization: "Bearer tok",
      cookie: "grogoni_session=abc",
      password: "hunter2",
      pin: "1234",
      passkey: "blob",
      secret: "shh"
    });

    expect(sanitized).toEqual({ accountId: "account-1" });
  });

  it("keeps non-sensitive keys untouched", () => {
    const sanitized = sanitizeClientLogMetadata({
      accountId: "account-1",
      businessId: "business-1",
      attempts: 3
    });

    expect(sanitized).toEqual({ accountId: "account-1", businessId: "business-1", attempts: 3 });
  });
});

describe("buildClientLogPayload", () => {
  // Regression test: the client console used to print raw accountId/sessionId on every
  // auth lifecycle transition (session_response_received, authenticated_user_loaded, etc.)
  // and on agent runtime restore, in production as well as development.
  it("in production, emits only the event name and drops every metadata field", () => {
    const payload = buildClientLogPayload(
      "auth.authenticated_user_loaded",
      { accountId: "account-1", sessionId: "session-secret-1", businessId: "business-1" },
      true
    );

    expect(payload).toEqual({ event: "auth.authenticated_user_loaded" });
  });

  it("in development, keeps debugging metadata but still drops credential keys", () => {
    const payload = buildClientLogPayload(
      "auth.authenticated_user_loaded",
      { accountId: "account-1", sessionId: "session-secret-1", businessId: "business-1" },
      false
    );

    expect(payload).toEqual({
      event: "auth.authenticated_user_loaded",
      accountId: "account-1",
      businessId: "business-1"
    });
  });
});

describe("logClientEvent / logAuthenticationLifecycle console output", () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it("never prints a real sessionId, even under vitest's non-production mode", () => {
    logAuthenticationLifecycle("authenticated_user_loaded", fakeSession());

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const printed = String(infoSpy.mock.calls[0]?.[0]);
    expect(printed).not.toContain("session-secret-1");
    expect(JSON.parse(printed)).toEqual({
      event: "auth.authenticated_user_loaded",
      accountId: "account-1"
    });
  });

  it("passes extra non-sensitive details through untouched", () => {
    logClientEvent("agent.runtime_restore_completed", {
      accountId: "account-1",
      businessId: "business-1",
      runtimeSessionId: "runtime-1"
    });

    const printed = JSON.parse(String(infoSpy.mock.calls[0]?.[0]));
    expect(printed).toEqual({
      event: "agent.runtime_restore_completed",
      accountId: "account-1",
      businessId: "business-1",
      runtimeSessionId: "runtime-1"
    });
  });
});
