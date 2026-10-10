import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

/**
 * Per-client request rate limit for the Edge API, the counterpart of the Fastify API's global
 * @fastify/rate-limit (services/api/src/app.ts: 300 requests/min, 60 for /auth/*, keyed by IP).
 *
 * Isolates share nothing, so the window counter lives in Postgres (cp2_edge_rate_limits). It is
 * counted on the connection the request already opens, in autocommit, before BEGIN and before the
 * request waits on any advisory lock: a flooding client is turned away without queueing behind
 * other requests, and without paying for a second connection (a cross-region connect costs ~2s).
 * A request that never opens a transaction (health checks) is never counted; it does no database
 * work to protect.
 *
 * One counter per client, as in Node: every request counts against it, and an /auth/* request is
 * refused once the count passes the lower auth limit.
 *
 * The client is the first x-forwarded-for entry, the address Vercel's /api rewrite reports for the
 * browser. A request without that header is not limited: one shared "unknown" bucket would let a
 * few clients lock everyone out. A caller that skips Vercel and calls the Supabase function URL
 * directly can choose the header, so this limit protects the production origin, not the raw
 * function URL. GET /internal/edge/domain-startup (operator token) reports the forwarding headers
 * the function receives, to confirm the first entry is the browser's address after a deploy.
 *
 * Like Node's limiter (skipOnError), it fails open: if counting itself fails (missing table,
 * timeout), the request proceeds and the failure is logged.
 */

export interface RateLimitPolicy {
  enabled: boolean;
  windowMs: number;
  authMax: number;
  defaultMax: number;
}

export const defaultRateLimitPolicy: RateLimitPolicy = {
  enabled: true,
  windowMs: 60_000,
  authMax: 60,
  defaultMax: 300
};

/** EDGE_RATE_LIMIT_ENABLED=false turns it off; EDGE_RATE_LIMIT_MAX and _AUTH_MAX set the limits. */
export function readRateLimitPolicy(read: (name: string) => string | undefined): RateLimitPolicy {
  const positive = (name: string, fallback: number) => {
    const value = Number(read(name));
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  };
  return {
    enabled: read("EDGE_RATE_LIMIT_ENABLED") !== "false",
    windowMs: defaultRateLimitPolicy.windowMs,
    authMax: positive("EDGE_RATE_LIMIT_AUTH_MAX", defaultRateLimitPolicy.authMax),
    defaultMax: positive("EDGE_RATE_LIMIT_MAX", defaultRateLimitPolicy.defaultMax)
  };
}

export class RateLimitExceededError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("Too many requests.");
    this.name = "RateLimitExceededError";
  }
}

interface RateLimitClient {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

interface RequestScope {
  key: string;
  max: number;
  checked: boolean;
}

/** Paths that are never limited: liveness probes and the token-guarded job trigger. */
function exempt(path: string): boolean {
  return path === "/health" || path.startsWith("/health/") || path.startsWith("/internal/jobs/");
}

export function rateLimitScope(
  request: Request,
  path: string,
  policy: RateLimitPolicy = defaultRateLimitPolicy
): { key: string; max: number } | null {
  if (!policy.enabled || exempt(path)) return null;
  const client = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (!client) return null;
  // Store a digest, not the address: the counter needs identity, not the IP itself.
  const digest = createHash("sha256").update(client).digest("hex").slice(0, 32);
  return {
    key: `client:${digest}`,
    max: path.startsWith("/auth/") ? policy.authMax : policy.defaultMax
  };
}

export function createRateLimiter(policy: RateLimitPolicy = defaultRateLimitPolicy) {
  const storage = new AsyncLocalStorage<RequestScope>();

  return {
    /** Runs one request's handling with its rate-limit identity attached. */
    run<T>(request: Request, path: string, handle: () => Promise<T>): Promise<T> {
      const scope = rateLimitScope(request, path, policy);
      return scope === null ? handle() : storage.run({ ...scope, checked: false }, handle);
    },

    /**
     * Counts the current request once, on its first database connection. Call before BEGIN.
     * Throws RateLimitExceededError when the client is over its limit for this window.
     */
    async check(client: RateLimitClient): Promise<void> {
      const scope = storage.getStore();
      if (scope === undefined || scope.checked) return;
      scope.checked = true;
      let row: Record<string, unknown> | undefined;
      try {
        // The window comes from the database clock, the one clock every isolate shares, and
        // never moves backwards: a late request from an earlier window counts toward the
        // current one instead of resetting it.
        row = (
          await client.query(
            `with bucket as (
              select date_bin(make_interval(secs => $2::double precision / 1000), now(),
                timestamptz 'epoch') as start
            )
            insert into cp2_edge_rate_limits (rate_key, window_start, request_count)
            select $1, start, 1 from bucket
            on conflict (rate_key) do update set
              request_count = case
                when cp2_edge_rate_limits.window_start >= excluded.window_start
                  then cp2_edge_rate_limits.request_count + 1
                else 1
              end,
              window_start = greatest(cp2_edge_rate_limits.window_start, excluded.window_start)
            returning request_count,
              ceil(extract(epoch from window_start
                + make_interval(secs => $2::double precision / 1000) - now()))::int as retry_after`,
            [scope.key, policy.windowMs]
          )
        ).rows[0];
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "edge_rate_limit_unavailable",
            code:
              typeof error === "object" && error !== null && "code" in error
                ? String(error.code)
                : null
          })
        );
        return;
      }
      if (Number(row?.request_count ?? 0) > scope.max)
        throw new RateLimitExceededError(Math.max(1, Number(row?.retry_after ?? 1)));
    }
  };
}

/** Forwarding headers as the function receives them, for the operator diagnostic. */
export function forwardingHeaders(request: Request): Record<string, string | null> {
  return Object.fromEntries(
    ["x-forwarded-for", "x-real-ip", "x-vercel-forwarded-for", "forwarded", "cf-connecting-ip"].map(
      (name) => [name, request.headers.get(name)]
    )
  );
}

export function rateLimitedResponse(error: RateLimitExceededError): Response {
  return Response.json(
    {
      code: "rate_limited",
      message: `Too many requests. Please retry after ${error.retryAfterSeconds} seconds.`
    },
    { status: 429, headers: { "retry-after": String(error.retryAfterSeconds) } }
  );
}
