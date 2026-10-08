import { describe, expect, it, vi } from "vitest";
import { createHandler } from "../supabase/functions/api/handler";

describe("Supabase Edge migration entry point", () => {
  it("permits the frontend's session and request headers in a browser preflight", async () => {
    const handler = createHandler({
      checkDatabase: vi.fn(),
      allowedOrigins: ["https://grogoni-frontend.vercel.app"]
    });
    const response = await handler(
      new Request("https://example.com/api/auth/logout", {
        method: "OPTIONS",
        headers: {
          origin: "https://grogoni-frontend.vercel.app",
          "access-control-request-method": "POST",
          "access-control-request-headers": "x-grogoni-device-id,x-request-id"
        }
      })
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")).toContain("x-grogoni-device-id");
    expect(response.headers.get("access-control-allow-headers")).toContain("x-request-id");
  });
  it("handles the path forwarded by the hosted gateway", async () => {
    const handler = createHandler({ checkDatabase: vi.fn(), allowedOrigins: [] });
    const response = await handler(new Request("https://example.com/api/health/live"));
    expect(response.status).toBe(200);
    expect((await response.json()).runtime).toBe("supabase-edge");
  });
  it("checks Neon without reporting an unfinished API as ready", async () => {
    const checkDatabase = vi.fn(async () => {});
    const handler = createHandler({ checkDatabase, allowedOrigins: [] });
    const db = await handler(new Request("https://example.com/functions/v1/api/health/db"));
    expect(db.status).toBe(200);
    expect((await db.json()).database).toEqual({ provider: "neon", ok: true });
    const ready = await handler(new Request("https://example.com/functions/v1/api/health/ready"));
    expect(ready.status).toBe(503);
    expect((await ready.json()).code).toBe("api_migration_incomplete");
    expect(checkDatabase).toHaveBeenCalledTimes(2);
  });
  it("does not expose connection errors", async () => {
    const handler = createHandler({
      checkDatabase: async () => {
        throw new Error("private connection details");
      },
      allowedOrigins: []
    });
    const response = await handler(new Request("https://example.com/health/db"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private");
  });
  it("allows configured origins and rejects other browser origins", async () => {
    const handler = createHandler({
      checkDatabase: vi.fn(),
      allowedOrigins: ["http://localhost:5173"]
    });
    const allowed = await handler(
      new Request("https://example.com/health/live", {
        headers: { origin: "http://localhost:5173" }
      })
    );
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    const denied = await handler(
      new Request("https://example.com/health/live", {
        headers: { origin: "https://other.example" }
      })
    );
    expect(denied.status).toBe(403);
  });
});
