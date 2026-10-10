import { describe, expect, it } from "vitest";
import {
  RateLimitExceededError,
  createRateLimiter,
  rateLimitScope,
  rateLimitedResponse,
  readRateLimitPolicy
} from "../supabase/functions/api/rate-limit";

// Applies the limiter's upsert the way Postgres would, with a controllable database clock: the
// window is the clock binned to windowMs; same window increments, a newer window resets to 1, and
// an older window never moves the stored one back.
function fakeDatabase(clock: () => number = () => 0) {
  const rows = new Map<string, { windowStart: number; count: number }>();
  const queries: unknown[][] = [];
  return {
    rows,
    queries,
    client: {
      async query(_sql: string, values: unknown[] = []) {
        queries.push(values);
        const [key, windowMs] = values as [string, number];
        const now = clock();
        const windowStart = Math.floor(now / windowMs) * windowMs;
        const row = rows.get(key);
        const stored =
          row === undefined
            ? { windowStart, count: 1 }
            : row.windowStart >= windowStart
              ? { windowStart: row.windowStart, count: row.count + 1 }
              : { windowStart, count: 1 };
        rows.set(key, stored);
        return {
          rows: [
            {
              request_count: stored.count,
              retry_after: Math.ceil((stored.windowStart + windowMs - now) / 1000)
            }
          ]
        };
      }
    }
  };
}

const policy = { enabled: true, windowMs: 60_000, authMax: 3, defaultMax: 5 };
const request = (ip: string) =>
  new Request("https://grogoni.com/api/v1/conversations", {
    headers: { "x-forwarded-for": `${ip}, 10.0.0.1` }
  });

async function hit(
  limiter: ReturnType<typeof createRateLimiter>,
  db: ReturnType<typeof fakeDatabase>,
  ip: string,
  path = "/v1/conversations"
) {
  return limiter.run(request(ip), path, async () => {
    await limiter.check(db.client);
    return "ok";
  });
}

describe("Edge API rate limit", () => {
  it("allows the configured number of requests per window, then answers with retry timing", async () => {
    let now = Date.parse("2026-10-09T12:00:10.000Z");
    const db = fakeDatabase(() => now);
    const limiter = createRateLimiter(policy);

    for (let index = 0; index < 5; index++)
      await expect(hit(limiter, db, "41.90.1.1")).resolves.toBe("ok");
    const rejected = await hit(limiter, db, "41.90.1.1").catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(RateLimitExceededError);
    expect((rejected as RateLimitExceededError).retryAfterSeconds).toBe(50);

    now = Date.parse("2026-10-09T12:01:00.000Z");
    await expect(hit(limiter, db, "41.90.1.1")).resolves.toBe("ok");
  });

  it("limits each client separately and gives /auth/* the stricter limit", async () => {
    const db = fakeDatabase();
    const limiter = createRateLimiter(policy);
    for (let index = 0; index < 3; index++) await hit(limiter, db, "41.90.1.1", "/auth/pin/login");
    await expect(hit(limiter, db, "41.90.1.1", "/auth/pin/login")).rejects.toBeInstanceOf(
      RateLimitExceededError
    );
    await expect(hit(limiter, db, "41.90.2.2", "/auth/pin/login")).resolves.toBe("ok");
    await expect(hit(limiter, db, "41.90.1.1", "/v1/conversations")).resolves.toBe("ok");
  });

  it("counts a request once even when it opens several transactions", async () => {
    const db = fakeDatabase();
    const limiter = createRateLimiter(policy);
    await limiter.run(request("41.90.1.1"), "/v1/conversations", async () => {
      await limiter.check(db.client);
      await limiter.check(db.client);
      await limiter.check(db.client);
    });
    expect(db.queries).toHaveLength(1);
  });

  it("keeps concurrent requests' identities apart", async () => {
    const db = fakeDatabase();
    const limiter = createRateLimiter(policy);
    await Promise.all(
      ["41.90.1.1", "41.90.2.2", "41.90.1.1"].map((ip) =>
        limiter.run(request(ip), "/v1/conversations", async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          await limiter.check(db.client);
        })
      )
    );
    expect([...db.rows.values()].map((row) => row.count).sort()).toEqual([1, 2]);
  });

  it("never counts health checks or token-guarded job triggers", async () => {
    const db = fakeDatabase();
    const limiter = createRateLimiter(policy);
    for (const path of ["/health", "/health/ready", "/internal/jobs/notification_delivery/run"]) {
      expect(rateLimitScope(request("41.90.1.1"), path, policy)).toBeNull();
      await limiter.run(request("41.90.1.1"), path, () => limiter.check(db.client));
    }
    expect(db.queries).toHaveLength(0);
  });

  it("stores a digest of the client address, never the address", () => {
    const scope = rateLimitScope(request("41.90.216.229"), "/v1/conversations", policy);
    expect(scope?.key).toMatch(/^client:[0-9a-f]{32}$/u);
    expect(scope?.key).not.toContain("41.90.216.229");
  });

  it("answers 429 with a Retry-After header", async () => {
    const response = rateLimitedResponse(new RateLimitExceededError(12));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("12");
    expect(await response.json()).toMatchObject({ code: "rate_limited" });
  });

  it("keeps one counter per client, with /auth/* refused past the lower limit, like Node", async () => {
    const db = fakeDatabase();
    const limiter = createRateLimiter(policy);
    for (let index = 0; index < 3; index++)
      await hit(limiter, db, "41.90.3.3", "/v1/conversations");
    await expect(hit(limiter, db, "41.90.3.3", "/auth/pin/login")).rejects.toBeInstanceOf(
      RateLimitExceededError
    );
    await expect(hit(limiter, db, "41.90.3.3", "/v1/conversations")).resolves.toBe("ok");
    expect(db.rows.size).toBe(1);
  });

  it("never puts clients without a forwarded address into one shared bucket", async () => {
    const db = fakeDatabase();
    const limiter = createRateLimiter(policy);
    const anonymous = new Request("https://grogoni.com/api/v1/conversations");
    expect(rateLimitScope(anonymous, "/v1/conversations", policy)).toBeNull();
    for (let index = 0; index < 20; index++)
      await limiter.run(anonymous, "/v1/conversations", () => limiter.check(db.client));
    expect(db.queries).toHaveLength(0);
  });

  it("fails open when the counter cannot be written, like Node's skipOnError", async () => {
    const limiter = createRateLimiter(policy);
    const broken = {
      query: async () => {
        throw Object.assign(new Error('relation "cp2_edge_rate_limits" does not exist'), {
          code: "42P01"
        });
      }
    };
    await expect(
      limiter.run(request("41.90.1.1"), "/v1/conversations", async () => {
        await limiter.check(broken);
        return "served";
      })
    ).resolves.toBe("served");
  });

  it("reads its limits and an off switch from the environment", () => {
    const env = (values: Record<string, string>) => (name: string) => values[name];
    expect(readRateLimitPolicy(env({}))).toEqual({
      enabled: true,
      windowMs: 60_000,
      authMax: 60,
      defaultMax: 300
    });
    expect(
      readRateLimitPolicy(env({ EDGE_RATE_LIMIT_MAX: "900", EDGE_RATE_LIMIT_AUTH_MAX: "abc" }))
    ).toMatchObject({ defaultMax: 900, authMax: 60 });
    const off = readRateLimitPolicy(env({ EDGE_RATE_LIMIT_ENABLED: "false" }));
    expect(rateLimitScope(request("41.90.1.1"), "/v1/conversations", off)).toBeNull();
  });
});
