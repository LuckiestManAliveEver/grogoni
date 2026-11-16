/**
 * Bounded exponential backoff with full jitter (AWS's "Exponential Backoff And Jitter": each
 * delay is drawn uniformly from [0, min(maxDelayMs, initialDelayMs * 2^(attempt-1))]), the
 * standard defense against synchronized retry storms (resource-isolation.md §9). Replaces the
 * immediate, no-delay retry loop that used to live in
 * the retired server OCR adapter's `process()`.
 */
export interface RetryOptions {
  /** Total attempts including the first, so 1 means "no retry." Must be a positive integer. */
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  /**
   * 1 = full jitter (default, recommended), 0 = no jitter (fixed exponential delay). Values in
   * between blend a fixed floor with jitter on the remainder.
   */
  jitterRatio?: number;
  /** Classifies whether a failure should be retried at all; defaults to "always retryable" -
   *  callers with a mix of retryable/non-retryable failures (e.g. auth vs. transient 503) must
   *  supply this, since retrying a non-retryable failure is exactly what this module exists to
   *  prevent elsewhere in the codebase. */
  isRetryable?: (error: unknown) => boolean;
  /** Injectable for deterministic tests; defaults to `Math.random`. */
  random?: () => number;
  /** Injectable for deterministic tests; defaults to a real `setTimeout`-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts));
  const jitterRatio = options.jitterRatio ?? 1;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;

  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await fn(attempt);
    } catch (error) {
      const retryable = options.isRetryable?.(error) ?? true;
      if (!retryable || attempt >= maxAttempts) {
        throw error;
      }
      const cappedBase = Math.min(options.maxDelayMs, options.initialDelayMs * 2 ** (attempt - 1));
      const delay = cappedBase * (1 - jitterRatio) + cappedBase * jitterRatio * random();
      await sleep(delay);
    }
  }
}
