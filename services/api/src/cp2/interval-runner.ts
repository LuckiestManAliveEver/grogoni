/**
 * The one shared implementation of the "setInterval + single-flight guard" shape that
 * notification-delivery-runner.ts, connected-mailbox-sync-runner.ts,
 * conversation-recycle-bin-runner.ts, agent-owner-correction-retention-runner.ts,
 * grogoniid-cooldown-runner.ts, and account-deletion-runner.ts each hand-rolled independently
 * (docs/architecture/resource-isolation-audit.md §11: "six runners, identical shape"). Extracting
 * it means the scheduled-job timing/failure telemetry this module adds
 * (resource-isolation.md §17, `scheduled_job_duration_seconds`/`scheduled_job_failure_total`)
 * exists in one place instead of six, and any future overlap-prevention change applies to every
 * runner at once. Each call site keeps its own domain-specific interval validation and store call
 * - only the timer/single-flight/timing plumbing moved here.
 */
export interface IntervalRunnerOptions<T> {
  /** Low-cardinality job name used as the `job` label on scheduled_job_duration_seconds. */
  job: string;
  intervalMs: number;
  runOnStart?: boolean;
  run: () => Promise<T>;
  onResult?: (result: T) => void;
  onError?: (error: unknown) => void;
  /** Typically `metrics.timeScheduledJob` (@grogoni/observability); omitted in tests that don't
   *  construct a Metrics instance, in which case the job still runs, just unmeasured. */
  timeScheduledJob?: <R>(job: string, fn: () => Promise<R>) => Promise<R>;
}

export interface IntervalRunner<T> {
  runNow: () => Promise<T | null>;
  stop: () => Promise<void>;
}

export function createIntervalRunner<T>(options: IntervalRunnerOptions<T>): IntervalRunner<T> {
  let stopped = false;
  let inFlight: Promise<T | null> | null = null;
  const timeScheduledJob =
    options.timeScheduledJob ?? (<R>(_job: string, fn: () => Promise<R>) => fn());

  const runNow = (): Promise<T | null> => {
    if (stopped) return Promise.resolve(null);
    if (inFlight !== null) return inFlight;
    inFlight = timeScheduledJob(options.job, options.run)
      .then((result) => {
        options.onResult?.(result);
        return result;
      })
      .catch((error: unknown) => {
        options.onError?.(error);
        return null;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const timer = setInterval(() => void runNow(), options.intervalMs);
  timer.unref();
  if (options.runOnStart !== false) void runNow();

  return {
    runNow,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    }
  };
}
