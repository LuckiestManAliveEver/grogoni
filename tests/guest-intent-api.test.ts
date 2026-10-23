import { generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import {
  createGuestIntentService,
  type GuestIntentService
} from "../services/api/src/guest-intent/service";
import {
  createMemoryGuestIntentLimiter,
  createPostgresGuestIntentLimiter
} from "../services/api/src/guest-intent/rate-limit";

/**
 * POST /v1/guest/intent on the Node API, with a real guest session from /auth/continue and a
 * fake classifier (no network). The Edge route and the service rules are in
 * services/api/src/guest-intent/service.test.ts.
 */
const fakeService = () =>
  createGuestIntentService({
    classifier: {
      modelId: "gpt-6-luna",
      classify: vi.fn(async () => ({
        ok: true as const,
        intent: "search" as const,
        query: "sugar",
        modelId: "gpt-6-luna",
        latencyMs: 9
      }))
    },
    limiter: createMemoryGuestIntentLimiter({ max: 2, windowMs: 60_000 }),
    report: () => undefined
  });

async function guestApp(service: GuestIntentService | null = fakeService()) {
  const app = buildApi({
    cp2: { store: createCp2Store() },
    webRoot: false,
    ...(service === null ? {} : { guestIntent: service })
  });
  const signedIn = await app.inject({
    method: "POST",
    url: "/auth/continue",
    headers: {
      "idempotency-key": `guest-intent-api-${Math.random().toString(16).slice(2).padEnd(24, "0")}`,
      "x-grogoni-device-id": "guest-intent-device",
      "x-grogoni-client": "web"
    },
    payload: {
      devicePublicKeyJwk: generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({
        format: "jwk"
      })
    }
  });
  expect(signedIn.statusCode).toBe(200);
  const header = signedIn.headers["set-cookie"];
  const cookie = (Array.isArray(header) ? header : [String(header)])
    .find((value) => value.startsWith("grogoni_session="))!
    .split(";")[0]!;
  return { app, cookie };
}

describe("guest intent on the Node API", () => {
  it("classifies a signed-in guest's message and limits the session", async () => {
    const { app, cookie } = await guestApp();
    const send = () =>
      app.inject({
        method: "POST",
        url: "/v1/guest/intent",
        headers: { cookie, "content-type": "application/json" },
        payload: { message: "do you have sugar" }
      });
    const first = await send();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      intent: "search",
      query: "sugar",
      modelId: "gpt-6-luna",
      latencyMs: 9
    });
    expect(first.headers["cache-control"]).toBe("no-store");
    expect((await send()).statusCode).toBe(200);
    const limited = await send();
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    await app.close();
  });

  it("refuses a caller without a session and an oversized body", async () => {
    const { app } = await guestApp();
    const anonymous = await app.inject({
      method: "POST",
      url: "/v1/guest/intent",
      payload: { message: "sugar" }
    });
    expect(anonymous.statusCode).toBe(401);
    const huge = await app.inject({
      method: "POST",
      url: "/v1/guest/intent",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ message: "a".repeat(10_000) })
    });
    expect(huge.statusCode).toBe(413);
    await app.close();
  });

  it("answers 503 when the API was built without a classifier", async () => {
    const { app, cookie } = await guestApp(null);
    const response = await app.inject({
      method: "POST",
      url: "/v1/guest/intent",
      headers: { cookie },
      payload: { message: "sugar" }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "guest_intent_unavailable" });
    await app.close();
  });

  it("fails open when the Edge counter cannot be written", async () => {
    const broken = createPostgresGuestIntentLimiter({
      query: async () => {
        throw Object.assign(new Error("relation missing"), { code: "42P01" });
      }
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await broken.consume("s")).allowed).toBe(true);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("guest_intent_rate_limit_unavailable")
    );
    error.mockRestore();
  });
});

const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const requireApiDependency = createRequire(resolve(process.cwd(), "services/api/package.json"));

describePostgres("guest intent limiter on PostgreSQL (the Edge counter)", () => {
  it("counts one session across calls in cp2_edge_rate_limits and refuses past the limit", async () => {
    const { Pool } = requireApiDependency("pg") as {
      Pool: new (options: { connectionString: string }) => {
        query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
        end(): Promise<void>;
      };
    };
    const pool = new Pool({ connectionString: databaseUrl! });
    try {
      // The limiter fails open, so an unreachable database must fail here, not pass as "allowed".
      await pool.query("select 1 from cp2_edge_rate_limits limit 1");
      const sessionId = `pg-guest-intent-${Date.now()}`;
      // Two limiters, as two Edge isolates: they share the database counter.
      const first = createPostgresGuestIntentLimiter(pool, { max: 2, windowMs: 60_000 });
      const second = createPostgresGuestIntentLimiter(pool, { max: 2, windowMs: 60_000 });
      expect((await first.consume(sessionId)).allowed).toBe(true);
      expect((await second.consume(sessionId)).allowed).toBe(true);
      const refused = await first.consume(sessionId);
      expect(refused.allowed).toBe(false);
      expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect((await first.consume(`${sessionId}-other`)).allowed).toBe(true);
      const rows = await pool.query(
        "select rate_key from cp2_edge_rate_limits where rate_key like 'guest-intent:%'"
      );
      expect(rows.rows.every((row) => !String(row.rate_key).includes(sessionId))).toBe(true);
    } finally {
      await pool.end();
    }
  });
});
