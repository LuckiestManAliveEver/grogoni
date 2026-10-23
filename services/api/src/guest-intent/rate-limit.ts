import { createHash } from "node:crypto";

/**
 * Per-session limit on guest intent calls: each one is a paid model call, so a script holding a
 * session cannot run up the bill. The global per-IP limits (300/min on Node, cp2_edge_rate_limits
 * on the Edge) still apply on top. A refused call gets 429 and the client answers by rules.
 */
export interface GuestIntentLimiter {
  consume(sessionId: string): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

export interface GuestIntentRatePolicy {
  max: number;
  windowMs: number;
}

/** A guest types a message every few seconds at most; 20 a minute leaves room for quick retries. */
export const defaultGuestIntentRatePolicy: GuestIntentRatePolicy = { max: 20, windowMs: 60_000 };

/** The counter key: a digest, so the table never holds a session ID. */
export function guestIntentRateKey(sessionId: string): string {
  return `guest-intent:${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`;
}

/** One process (the Node API): a fixed window per session, pruned as windows end. */
export function createMemoryGuestIntentLimiter(
  policy: GuestIntentRatePolicy = defaultGuestIntentRatePolicy,
  now: () => number = Date.now
): GuestIntentLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    async consume(sessionId) {
      const at = now();
      const start = at - (at % policy.windowMs);
      if (windows.size > 10_000)
        for (const [key, window] of windows) if (window.start < start) windows.delete(key);
      const key = guestIntentRateKey(sessionId);
      const window = windows.get(key);
      const count = window !== undefined && window.start === start ? window.count + 1 : 1;
      windows.set(key, { start, count });
      return {
        allowed: count <= policy.max,
        retryAfterSeconds: Math.max(1, Math.ceil((start + policy.windowMs - at) / 1000))
      };
    }
  };
}

interface Queryable {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Edge isolates share nothing, so the window lives in cp2_edge_rate_limits (migration 110), the
 * table the per-IP limiter uses, under its own key prefix; the hourly rate-limit sweep prunes
 * both. One autocommit statement, no transaction and no store lock. Fails open like the per-IP
 * limiter: if counting fails, the call proceeds and the failure is logged.
 */
export function createPostgresGuestIntentLimiter(
  database: Queryable,
  policy: GuestIntentRatePolicy = defaultGuestIntentRatePolicy
): GuestIntentLimiter {
  return {
    async consume(sessionId) {
      try {
        const row = (
          await database.query(
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
            [guestIntentRateKey(sessionId), policy.windowMs]
          )
        ).rows[0];
        return {
          allowed: Number(row?.request_count ?? 0) <= policy.max,
          retryAfterSeconds: Math.max(1, Number(row?.retry_after ?? 1))
        };
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "guest_intent_rate_limit_unavailable",
            code:
              typeof error === "object" && error !== null && "code" in error
                ? String(error.code)
                : null
          })
        );
        return { allowed: true, retryAfterSeconds: 0 };
      }
    }
  };
}
