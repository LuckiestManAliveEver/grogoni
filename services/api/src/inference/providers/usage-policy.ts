import type { CredentialScope, InferenceUsage, ModelPricing } from "./contract.js";
import type { InferenceEnvironment } from "./environment.js";
import { InferenceError } from "./errors.js";
import type {
  InferenceFallbackPolicy,
  InferencePolicyRecord,
  InferencePolicyRepository,
  InferenceRunRepository
} from "./repositories.js";

/**
 * Estimated cost from normalized usage and catalog pricing. Cached input tokens are billed at the
 * cached rate when one is known, otherwise at the normal input rate. Returns undefined when the
 * model has no pricing metadata - unknown cost is recorded as null, never guessed.
 */
export function estimateCost(
  usage: InferenceUsage | undefined,
  pricing: ModelPricing | undefined,
  fallbackCurrency: string
): { currency: string; estimatedAmount: number } | undefined {
  if (usage === undefined || pricing === undefined) return undefined;
  const inputRate = pricing.inputPerMillionTokens;
  const outputRate = pricing.outputPerMillionTokens;
  if (inputRate === undefined && outputRate === undefined) return undefined;
  const input = usage.inputTokens ?? 0;
  const cached = Math.min(usage.cachedInputTokens ?? 0, input);
  const output = usage.outputTokens ?? 0;
  const amount =
    ((input - cached) * (inputRate ?? 0) +
      cached * (pricing.cachedInputPerMillionTokens ?? inputRate ?? 0) +
      output * (outputRate ?? 0)) /
    1_000_000;
  return {
    currency: (pricing.currency ?? fallbackCurrency).toUpperCase(),
    estimatedAmount: Math.round(amount * 1e8) / 1e8
  };
}

export interface EffectiveUsagePolicy {
  currency: string;
  /**
   * Grogoni's own spend caps (environment / global row). They apply only to Grogoni-funded requests,
   * measured against Grogoni-funded spend - a shop paying with its own key is not limited by them.
   */
  platformTenantDailyBudget: number | null;
  platformUserDailyBudget: number | null;
  providerMonthlyCeilings: ReadonlyMap<string, number>;
  /** A shop's / person's own caps (their policy row). They apply to all of their spend. */
  ownTenantDailyBudget: number | null;
  ownUserDailyBudget: number | null;
  maxRequestsPerMinute: number | null;
  maxTokensPerRequest: number | null;
  fallbackPolicy: InferenceFallbackPolicy;
  approvedProviderIds: readonly string[];
  fallbackModelIds: readonly string[];
}

/**
 * Counts requests in a fixed window. The default is in-process; with Redis configured the API uses
 * createRedisRequestRateLimiter so every API instance shares the same counters.
 */
export interface RequestRateLimiter {
  hit(
    key: string,
    limit: number,
    windowMs: number
  ): Promise<{ allowed: boolean; retryAfterMs: number }>;
}

export function createMemoryRequestRateLimiter(now: () => number = Date.now): RequestRateLimiter {
  const windows = new Map<string, number[]>();
  return {
    async hit(key, limit, windowMs) {
      const at = now();
      const recent = (windows.get(key) ?? []).filter((time) => time > at - windowMs);
      if (recent.length >= limit) {
        windows.set(key, recent);
        return { allowed: false, retryAfterMs: Math.max(0, (recent[0] ?? at) + windowMs - at) };
      }
      recent.push(at);
      windows.set(key, recent);
      return { allowed: true, retryAfterMs: 0 };
    }
  };
}

/** Minimal slice of an ioredis client, so tests can fake it. */
export interface RateLimitRedisPipeline {
  incr(key: string): RateLimitRedisPipeline;
  pexpire(key: string, ms: number): RateLimitRedisPipeline;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

export interface RateLimitRedis {
  multi(): RateLimitRedisPipeline;
}

/**
 * Shared fixed-window counter in Redis (one key per window). If Redis is unreachable the request is
 * admitted by the in-process fallback, matching how the API's HTTP rate limiter skips on Redis
 * errors instead of taking the API down.
 */
export function createRedisRequestRateLimiter(
  redis: RateLimitRedis,
  options: { now?: () => number; fallback?: RequestRateLimiter } = {}
): RequestRateLimiter {
  const now = options.now ?? Date.now;
  const fallback = options.fallback ?? createMemoryRequestRateLimiter(now);
  return {
    async hit(key, limit, windowMs) {
      const at = now();
      const window = Math.floor(at / windowMs);
      const redisKey = `grogoni:inference:rate:${key}:${window}`;
      try {
        const result = await redis
          .multi()
          .incr(redisKey)
          .pexpire(redisKey, windowMs * 2)
          .exec();
        const count = Number(result?.[0]?.[1]);
        if (!Number.isFinite(count)) throw new Error("Unexpected Redis reply.");
        return count > limit
          ? { allowed: false, retryAfterMs: (window + 1) * windowMs - at }
          : { allowed: true, retryAfterMs: 0 };
      } catch {
        return fallback.hit(key, limit, windowMs);
      }
    }
  };
}

/**
 * Budgets, per-request token ceilings, rate limits and the explicit fallback policy.
 *
 * - Rate limits and token ceilings: the strictest defined value across environment, global,
 *   tenant and user rows - no row can loosen a stricter one.
 * - Budgets come in two kinds that are checked independently (both must pass): Grogoni's own caps
 *   on Grogoni-funded spend, and a shop's/person's own caps on all of their spend.
 * - Fallback policy: the most specific row that sets one (tenant, then user, then global).
 */
export class InferenceUsageGuard {
  private readonly limiter: RequestRateLimiter;

  constructor(
    private readonly deps: {
      runs: InferenceRunRepository;
      policies: InferencePolicyRepository;
      environment: InferenceEnvironment["budgets"];
      now?: () => Date;
      limiter?: RequestRateLimiter;
    }
  ) {
    this.limiter =
      deps.limiter ?? createMemoryRequestRateLimiter(() => (deps.now?.() ?? new Date()).getTime());
  }

  async effectivePolicy(owner: {
    tenantId: string | null;
    userId: string | null;
  }): Promise<EffectiveUsagePolicy> {
    const [global, tenant, user] = await Promise.all([
      this.deps.policies.get({ scope: "global" }),
      owner.tenantId === null
        ? Promise.resolve(undefined)
        : this.deps.policies.get({ scope: "tenant", tenantId: owner.tenantId }),
      owner.userId === null
        ? Promise.resolve(undefined)
        : this.deps.policies.get({ scope: "user", userId: owner.userId })
    ]);
    const env = this.deps.environment;
    const ceilings = new Map(env.providerMonthlyCeilings);
    for (const [providerId, amount] of Object.entries(global?.providerMonthlyCeilings ?? {})) {
      ceilings.set(providerId, amount);
    }
    const fallbackSource: InferencePolicyRecord | undefined = tenant ?? user ?? global;
    return {
      currency: (global?.currency ?? env.currency).toUpperCase(),
      platformTenantDailyBudget: global?.dailyBudget ?? env.tenantDailyBudget,
      platformUserDailyBudget: env.userDailyBudget,
      providerMonthlyCeilings: ceilings,
      ownTenantDailyBudget: tenant?.dailyBudget ?? null,
      ownUserDailyBudget: user?.dailyBudget ?? null,
      maxRequestsPerMinute: strictest(
        env.maxRequestsPerMinute,
        global?.maxRequestsPerMinute,
        tenant?.maxRequestsPerMinute,
        user?.maxRequestsPerMinute
      ),
      maxTokensPerRequest: strictest(
        env.maxTokensPerRequest,
        global?.maxTokensPerRequest,
        tenant?.maxTokensPerRequest,
        user?.maxTokensPerRequest
      ),
      fallbackPolicy: fallbackSource?.fallbackPolicy ?? "NONE",
      approvedProviderIds: fallbackSource?.approvedProviderIds ?? [],
      fallbackModelIds: fallbackSource?.fallbackModelIds ?? []
    };
  }

  /**
   * Rejects (never silently reroutes) when a budget or rate limit is already exhausted. Budgets
   * are checked against recorded spend *before* the call; a single call can overshoot by at most
   * its own cost, which the per-request token ceiling bounds.
   */
  async admit(input: {
    tenantId: string | null;
    userId: string | null;
    providerId: string;
    /** Who pays for this request: Grogoni's caps apply only when it is "platform". */
    credentialScope: CredentialScope | null;
    policy: EffectiveUsagePolicy;
  }): Promise<void> {
    const now = this.deps.now?.() ?? new Date();
    const { policy } = input;
    if (policy.maxRequestsPerMinute !== null) {
      const verdict = await this.limiter.hit(
        `${input.tenantId ?? "-"}|${input.userId ?? "-"}`,
        policy.maxRequestsPerMinute,
        60_000
      );
      if (!verdict.allowed) {
        throw new InferenceError("RATE_LIMITED", {
          providerId: input.providerId,
          retryAfterMs: verdict.retryAfterMs,
          diagnostic: "Grogoni per-minute request limit reached."
        });
      }
    }
    const dayStart = startOfUtcDay(now);
    const spent = (filter: {
      tenantId?: string;
      userId?: string;
      providerId?: string;
      platformOnly: boolean;
      since: string;
    }) =>
      this.deps.runs.sumCost({
        since: filter.since,
        currency: policy.currency,
        ...(filter.tenantId === undefined ? {} : { tenantId: filter.tenantId }),
        ...(filter.userId === undefined ? {} : { userId: filter.userId }),
        ...(filter.providerId === undefined ? {} : { providerId: filter.providerId }),
        ...(filter.platformOnly ? { credentialScope: "platform" as const } : {})
      });
    const platformFunded = input.credentialScope === "platform";
    if (input.tenantId !== null) {
      if (
        policy.ownTenantDailyBudget !== null &&
        (await spent({ since: dayStart, tenantId: input.tenantId, platformOnly: false })) >=
          policy.ownTenantDailyBudget
      ) {
        throw budgetExceeded(input.providerId, "shop daily budget");
      }
      if (
        platformFunded &&
        policy.platformTenantDailyBudget !== null &&
        (await spent({ since: dayStart, tenantId: input.tenantId, platformOnly: true })) >=
          policy.platformTenantDailyBudget
      ) {
        throw budgetExceeded(input.providerId, "platform daily budget for this shop");
      }
    }
    if (input.userId !== null) {
      if (
        policy.ownUserDailyBudget !== null &&
        (await spent({ since: dayStart, userId: input.userId, platformOnly: false })) >=
          policy.ownUserDailyBudget
      ) {
        throw budgetExceeded(input.providerId, "personal daily budget");
      }
      if (
        platformFunded &&
        policy.platformUserDailyBudget !== null &&
        (await spent({ since: dayStart, userId: input.userId, platformOnly: true })) >=
          policy.platformUserDailyBudget
      ) {
        throw budgetExceeded(input.providerId, "platform daily budget for this person");
      }
    }
    const ceiling = policy.providerMonthlyCeilings.get(input.providerId);
    if (platformFunded && ceiling !== undefined) {
      const total = await spent({
        since: startOfUtcMonth(now),
        providerId: input.providerId,
        platformOnly: true
      });
      if (total >= ceiling) throw budgetExceeded(input.providerId, "provider monthly ceiling");
    }
  }
}

function strictest(...values: Array<number | null | undefined>): number | null {
  const defined = values.filter((value): value is number => typeof value === "number" && value > 0);
  return defined.length === 0 ? null : Math.min(...defined);
}

function budgetExceeded(providerId: string, which: string): InferenceError {
  return new InferenceError("BUDGET_EXCEEDED", { providerId, diagnostic: `${which} reached` });
}

function startOfUtcDay(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  ).toISOString();
}

function startOfUtcMonth(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}
