import { retryWithBackoff } from "@grogoni/resource-control";

/**
 * Boot-time database steps (schema assertions, CP2 snapshot hydration) used to crash the process on
 * the first network blip. On a flaky resolver (a phone hotspot, a congested Wi-Fi DNS proxy) a
 * single `getaddrinfo EAI_AGAIN` for the Neon host killed `pnpm dev:local` even though the very
 * next lookup succeeded. Each step now retries transient connection failures with bounded,
 * jittered backoff and fails fast on everything else, so a schema mismatch or bad credentials still
 * surface immediately.
 */

/**
 * Node/libuv socket and resolver codes that describe a network condition likely to clear on its own.
 * ENOTFOUND is deliberately absent: it is NXDOMAIN, which means a wrong hostname in DATABASE_URL far
 * more often than a flaky resolver, and retrying it would only delay the real error.
 */
const TRANSIENT_NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT"
]);

/**
 * PostgreSQL SQLSTATEs that mean "the server could not take this connection right now":
 * connection_exception, connection_does_not_exist, connection_failure,
 * sqlclient_unable_to_establish_sqlconnection, admin/crash shutdown, a server still starting (Neon
 * compute waking from suspend answers 57P03) and connection-slot exhaustion. 08004 (server rejected
 * the connection) stays fail-fast. 08P01 is not listed: PgBouncer (Neon's `-pooler` endpoint) reports
 * nearly all of its own errors under it, transient and permanent alike, so it is only retried when
 * the message is one of the transient pooler texts below.
 */
const TRANSIENT_SQLSTATES = new Set([
  "08000",
  "08001",
  "08003",
  "08006",
  "57P01",
  "57P02",
  "57P03",
  "53300"
]);

/**
 * Matched on the message whatever the code: node-postgres raises its own timeouts and dropped
 * connections as plain Errors, PgBouncer sends its transient pooler errors as 08P01, and Neon's proxy
 * reports a compute it could not reach (typically while waking from suspend) or a connect
 * rate limit as XX000.
 */
const TRANSIENT_MESSAGES = [
  /connection terminated unexpectedly/i,
  /connection terminated due to connection timeout/i,
  /timeout exceeded when trying to connect/i,
  /^timeout expired$/i,
  /query read timeout/i,
  // PgBouncer (Neon's -pooler endpoint): pool or connection limits and pooler restarts.
  /query_wait_timeout/i,
  /^query_timeout$/i,
  /no more connections allowed/i,
  /client connections exceeded/i,
  /server shutting down/i,
  /pooler is shutting down/i,
  /client_login_timeout \(server down\)/i,
  // PgBouncer caches a failed server login for server_login_retry seconds and rejects new clients
  // with "server login has been failing, cached error: <cause> (server_login_retry)" meanwhile. The
  // cause is almost always a DNS or connect failure behind the pooler; a cached authentication
  // failure is excluded below so wrong credentials still fail fast.
  /\(server_login_retry\)/i,
  /couldn'?t connect to compute node/i,
  /failed to acquire permit to connect to the database/i
];

/**
 * Causes that are never transient even when a pattern above matches, e.g. a cached
 * `server_login_retry` whose cause is wrong credentials or an unknown database.
 */
const PERMANENT_MESSAGES = [/authentication failed/i, /no such database/i, /does not exist/i];

export function isTransientDatabaseError(error: unknown): boolean {
  return transientReason(error) !== null;
}

/** The code (or message) that makes `error` transient, or null when it should fail fast. */
export function transientReason(error: unknown): string | null {
  let reason: string | null = null;
  someErrorInChain(error, (candidate) => {
    const code = (candidate as { code?: unknown }).code;
    if (
      typeof code === "string" &&
      (TRANSIENT_NETWORK_CODES.has(code) || TRANSIENT_SQLSTATES.has(code))
    ) {
      reason = code;
      return true;
    }
    const message = (candidate as { message?: unknown }).message;
    if (
      typeof message === "string" &&
      TRANSIENT_MESSAGES.some((pattern) => pattern.test(message)) &&
      !PERMANENT_MESSAGES.some((pattern) => pattern.test(message))
    ) {
      // The code alone (08P01, XX000) is not what made this retryable, so log the message too.
      reason = `${typeof code === "string" ? `${code}: ` : ""}${message}`.slice(0, 120);
      return true;
    }
    return false;
  });
  return reason;
}

/** Walks `cause` chains and AggregateError members (Node's happy-eyeballs connect raises those). */
function someErrorInChain(error: unknown, predicate: (candidate: object) => boolean): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (candidate === null || typeof candidate !== "object" || seen.has(candidate)) continue;
    seen.add(candidate);
    if (predicate(candidate)) return true;
    pending.push((candidate as { cause?: unknown }).cause);
    const members = (candidate as { errors?: unknown }).errors;
    if (Array.isArray(members)) pending.push(...members);
  }
  return false;
}

export interface DatabaseStartupRetryOptions {
  /** Total attempts including the first. */
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  log?: (event: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export const DEFAULT_DATABASE_STARTUP_RETRY: DatabaseStartupRetryOptions = {
  maxAttempts: 6,
  initialDelayMs: 500,
  maxDelayMs: 8000
};

/**
 * Runs one boot step, retrying only transient connection failures. Every retry logs one JSON line
 * `db.startup_retry` (with the backoff it is about to wait) and a boot step that needed retries logs
 * `db.startup_recovered`, so a flaky network leaves a trace instead of silently stretching boot.
 */
export async function retryDatabaseStartup<T>(
  step: string,
  run: () => Promise<T>,
  options: DatabaseStartupRetryOptions = DEFAULT_DATABASE_STARTUP_RETRY
): Promise<T> {
  const log = options.log ?? ((event) => console.warn(JSON.stringify(event)));
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts));
  let failedAttempts = 0;
  let lastError: unknown;
  const result = await retryWithBackoff(
    async () => {
      try {
        return await run();
      } catch (error) {
        failedAttempts += 1;
        lastError = error;
        throw error;
      }
    },
    {
      maxAttempts,
      initialDelayMs: options.initialDelayMs,
      maxDelayMs: options.maxDelayMs,
      isRetryable: isTransientDatabaseError,
      // retryWithBackoff only sleeps when it is about to retry, so this is the one place that sees
      // exactly the retried failures and the delay chosen for each.
      sleep: (ms) => {
        log({
          event: "db.startup_retry",
          step,
          attempt: failedAttempts,
          maxAttempts,
          code: transientReason(lastError) ?? "unknown",
          delayMs: Math.round(ms)
        });
        return sleep(ms);
      },
      ...(options.random === undefined ? {} : { random: options.random })
    }
  );
  if (failedAttempts > 0) {
    log({ event: "db.startup_recovered", step, failedAttempts });
  }
  return result;
}

export interface BackgroundRetryOptions {
  initialDelayMs: number;
  maxDelayMs: number;
  log?: (event: Record<string, unknown>) => void;
  random?: () => number;
  setTimer?: (run: () => void, ms: number) => { cancel: () => void };
}

/**
 * For a boot step that is allowed to fail (the inference provider refresh): after its startup
 * retries are exhausted, keep retrying in the background with capped, jittered backoff until it
 * succeeds, so a long outage at boot ends in recovery instead of a process that silently runs
 * degraded until restart. Every error is retried, not only transient ones: boot already passed the
 * schema checks, and a step that fails for another reason (for example a migration applied while
 * the API runs) still recovers. Logs `db.background_retry` per failure and `db.startup_recovered`
 * (with `background: true`) on success. Returns a stop function for shutdown.
 */
export function retryInBackground(
  step: string,
  run: () => Promise<unknown>,
  options: BackgroundRetryOptions
): () => void {
  const log = options.log ?? ((event) => console.warn(JSON.stringify(event)));
  const random = options.random ?? Math.random;
  const setTimer =
    options.setTimer ??
    ((callback, ms) => {
      const timer = setTimeout(callback, ms);
      timer.unref();
      return { cancel: () => clearTimeout(timer) };
    });
  let stopped = false;
  let pending: { cancel: () => void } | undefined;
  let failedAttempts = 0;
  const nextDelayMs = () =>
    Math.round(
      random() * Math.min(options.maxDelayMs, options.initialDelayMs * 2 ** failedAttempts)
    );
  const schedule = (delayMs: number) => {
    pending = setTimer(() => {
      pending = undefined;
      if (stopped) return;
      run().then(
        () => {
          if (!stopped)
            log({ event: "db.startup_recovered", step, failedAttempts, background: true });
        },
        (error: unknown) => {
          // Stopped while this attempt was in flight (shutdown): the pools are closing, so neither
          // log the failure nor schedule another attempt.
          if (stopped) return;
          failedAttempts += 1;
          const delayMs = nextDelayMs();
          log({
            event: "db.background_retry",
            step,
            attempt: failedAttempts,
            code: transientReason(error) ?? errorCode(error),
            delayMs
          });
          schedule(delayMs);
        }
      );
    }, delayMs);
  };
  schedule(nextDelayMs());
  return () => {
    stopped = true;
    pending?.cancel();
  };
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return error instanceof Error ? error.message.slice(0, 120) : "unknown";
}
