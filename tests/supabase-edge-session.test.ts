import { describe, expect, it, vi } from "vitest";
import { createSessionRoutes } from "../supabase/functions/api/session-routes";
import { createHandler } from "../supabase/functions/api/handler";

const id = "00000000-0000-4000-8000-000000000001";
function request(path: string, method = "GET", cookie = `grogoni_session=${id}`) {
  return new Request(`https://example.com${path}`, { method, headers: { cookie } });
}

describe("native Edge sessions", () => {
  it("rejects missing, malformed and ambiguous session cookies without querying Neon", async () => {
    const transaction = vi.fn();
    const routes = createSessionRoutes(transaction);
    for (const cookie of [
      "",
      "grogoni_session=invalid",
      `grogoni_session=${id}; grogoni_session=${id}`
    ]) {
      const response = await routes(request("/session", "GET", cookie), "/session");
      expect(response?.status).toBe(401);
    }
    expect(transaction).not.toHaveBeenCalled();
  });
  it("rejects a session not returned by the database", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const routes = createSessionRoutes(async (action) => action({ query }));
    const response = await routes(request("/session"), "/session");
    expect(response?.status).toBe(401);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("s.revoked_at is null"), [id]);
  });
  it("returns only the public session view, without credential fields", async () => {
    const date = "2026-10-08T12:00:00.000Z";
    const query = vi.fn(async () => ({
      rows: [
        {
          account_id: id,
          primary_auth_channel: "phone",
          primary_auth_destination: "+254712345678",
          identity_level: "strong",
          status: "active",
          account_created_at: date,
          user_id: id,
          display_name: "Test user",
          language: "en",
          user_created_at: date,
          session_id: id,
          expires_at: date,
          inactivity_expires_at: date,
          absolute_expires_at: date,
          refresh_token_hash: "private",
          password_hash: "private"
        }
      ]
    }));
    const routes = createSessionRoutes(async (action) => action({ query }));
    const response = await routes(request("/session"), "/session");
    expect(response?.status).toBe(200);
    const body = await response!.json();
    expect(body.session).toEqual({
      id,
      expiresAt: date,
      inactivityExpiresAt: date,
      absoluteExpiresAt: date
    });
    expect(JSON.stringify(body)).not.toContain("private");
  });
  it("revokes the whole refresh family and mirrors revocation in the compatibility record", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ session_family_id: id }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id, revoked_at: new Date() }] })
      .mockResolvedValueOnce({ rows: [] });
    const routes = createSessionRoutes(async (action) => action({ query }));
    const response = await routes(request("/auth/logout", "POST"), "/auth/logout");
    expect(await response!.json()).toEqual({ revoked: true });
    expect(query.mock.calls[1][0]).toContain("pg_advisory_xact_lock");
    expect(query.mock.calls[2][0]).toContain("session_family_id");
    expect(query.mock.calls[3][0]).toContain("update cp2_sessions");
    expect(response!.headers.getSetCookie()).toHaveLength(2);
  });
  it("does not revoke a session when a browser origin is disallowed", async () => {
    const applicationRoutes = vi.fn();
    const handler = createHandler({
      checkDatabase: vi.fn(),
      allowedOrigins: [],
      applicationRoutes
    });
    const response = await handler(
      new Request("https://example.com/auth/logout", {
        method: "POST",
        headers: { origin: "https://attacker.example", cookie: `grogoni_session=${id}` }
      })
    );
    expect(response.status).toBe(403);
    expect(applicationRoutes).not.toHaveBeenCalled();
  });
  it("does not expose a database failure to the client", async () => {
    const handler = createHandler({
      checkDatabase: vi.fn(),
      allowedOrigins: [],
      applicationRoutes: async () => {
        throw new Error("secret DB credentials");
      }
    });
    const response = await handler(request("/session"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret");
  });
});
