import type { Cp2Store } from "./store.js";
import { createIntervalRunner } from "./interval-runner.js";

// Mirrors agent-owner-correction-retention-runner.ts's interval/shape exactly - a daily sweep is
// frequent enough that no experience outlives its business's configured memoryPolicy.retentionDays
// by more than a day.
const defaultIntervalMs = 24 * 60 * 60 * 1000;

export interface RuntimeExperienceRetentionRunnerOptions {
  store: Pick<Cp2Store, "purgeExpiredRuntimeExperiences"> &
    Partial<Pick<Cp2Store, "purgeExpiredRuntimeApprovals">>;
  intervalMs?: number;
  runOnStart?: boolean;
  now?: () => Date;
  onResult?: (deprecated: number) => void;
  onError?: (error: unknown) => void;
  timeScheduledJob?: <R>(job: string, fn: () => Promise<R>) => Promise<R>;
}

export interface RuntimeExperienceRetentionRunner {
  runNow: () => Promise<number | null>;
  stop: () => Promise<void>;
}

export function startRuntimeExperienceRetentionRunner(
  options: RuntimeExperienceRetentionRunnerOptions
): RuntimeExperienceRetentionRunner {
  return createIntervalRunner({
    job: "runtime_experience_retention",
    intervalMs: normalizeInterval(options.intervalMs),
    run: async () => {
      const now = options.now?.() ?? new Date();
      await options.store.purgeExpiredRuntimeApprovals?.(now);
      return options.store.purgeExpiredRuntimeExperiences(now);
    },
    ...(options.runOnStart === undefined ? {} : { runOnStart: options.runOnStart }),
    ...(options.onResult === undefined ? {} : { onResult: options.onResult }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    ...(options.timeScheduledJob === undefined
      ? {}
      : { timeScheduledJob: options.timeScheduledJob })
  });
}

function normalizeInterval(value: number | undefined): number {
  if (value === undefined) return defaultIntervalMs;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Runtime experience retention runner interval must be a positive integer.");
  }
  return value;
}
