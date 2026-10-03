import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type {
  DeviceInferenceJob,
  DeviceInferenceResultInput,
  DeviceInferenceRuntime
} from "@grogoni/shared-types";

import { InferenceError } from "./providers/errors.js";

/**
 * Hands generation for device-local models (browser-local / installed-app) to the chatting
 * member's own device, and waits for the result (ADR-explicit-device-local-models.md).
 *
 *   turn pipeline ── dispatch() ──► pending job ◄── claim() long-poll ── member's device
 *        ▲                                                                   │ runs WebLLM
 *        └────────────── resolved ◄── complete(jobId, one-time token, text) ─┘
 *
 * Rules that keep this safe:
 * - A job is only ever visible to authenticated sessions of the account whose turn it is.
 * - A device only receives a job for a model it says it has installed and a runtime it offers.
 * - Results require the one-time token handed to the claiming device, are size-bounded, and are
 *   still plain model output: the turn pipeline parses, validates, authorizes and confirmation-gates
 *   them exactly as it does for a hosted model.
 * - No device answering within the claim window is a clear LOCAL_DEVICE_UNAVAILABLE failure, never
 *   a silent switch to a different model.
 *
 * In-process, like the owner-node broker: the API runs as one authoritative writer.
 */
export interface DeviceInferenceDispatch {
  accountId: string;
  turnId: string | null;
  modelId: string;
  providerModelId: string;
  executionTarget: DeviceInferenceRuntime;
  messages: DeviceInferenceJob["messages"];
  generation: DeviceInferenceJob["generation"];
  signal?: AbortSignal;
}

export interface DeviceInferenceOutcome {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  latencyMs?: number;
  firstTokenMs?: number;
}

interface ClaimFilter {
  accountId: string;
  runtime: DeviceInferenceRuntime;
  availableModelIds: ReadonlySet<string>;
  turnId?: string;
}

interface Job {
  view: Omit<DeviceInferenceJob, "token">;
  accountId: string;
  token: Buffer | null;
  state: "pending" | "claimed" | "settled";
  resolve: (outcome: DeviceInferenceOutcome) => void;
  reject: (error: InferenceError) => void;
  timers: NodeJS.Timeout[];
}

interface Waiter {
  filter: ClaimFilter;
  resolve: (job: DeviceInferenceJob | null) => void;
}

const maxResultChars = 64_000;

export class DeviceInferenceBroker {
  private readonly jobs = new Map<string, Job>();
  private readonly waiters = new Set<Waiter>();
  private readonly claimTimeoutMs: number;
  private readonly completionTimeoutMs: number;

  constructor(options: { claimTimeoutMs?: number; completionTimeoutMs?: number } = {}) {
    this.claimTimeoutMs = options.claimTimeoutMs ?? 20_000;
    this.completionTimeoutMs = options.completionTimeoutMs ?? 180_000;
  }

  dispatch(input: DeviceInferenceDispatch): Promise<DeviceInferenceOutcome> {
    return new Promise<DeviceInferenceOutcome>((resolve, reject) => {
      if (input.signal?.aborted === true) {
        reject(
          new InferenceError("REQUEST_CANCELLED", { providerId: "local", modelId: input.modelId })
        );
        return;
      }
      const id = randomUUID();
      const job: Job = {
        view: {
          id,
          turnId: input.turnId,
          modelId: input.modelId,
          providerModelId: input.providerModelId,
          executionTarget: input.executionTarget,
          messages: input.messages,
          generation: input.generation,
          expiresAt: new Date(
            Date.now() + this.claimTimeoutMs + this.completionTimeoutMs
          ).toISOString()
        },
        accountId: input.accountId,
        token: null,
        state: "pending",
        resolve,
        reject,
        timers: []
      };
      this.jobs.set(id, job);
      job.timers.push(
        setTimeout(() => {
          if (job.state === "pending") {
            this.settle(
              job,
              new InferenceError("LOCAL_DEVICE_UNAVAILABLE", {
                providerId: "local",
                modelId: input.modelId
              })
            );
          }
        }, this.claimTimeoutMs)
      );
      input.signal?.addEventListener(
        "abort",
        () =>
          this.settle(
            job,
            new InferenceError("REQUEST_CANCELLED", { providerId: "local", modelId: input.modelId })
          ),
        { once: true }
      );
      for (const waiter of this.waiters) {
        if (this.matches(job, waiter.filter)) {
          this.waiters.delete(waiter);
          waiter.resolve(this.hand(job));
          return;
        }
      }
    });
  }

  /** Long-poll: resolves with a matching job, or null after `waitMs`. */
  claim(
    filter: ClaimFilter & { waitMs: number; signal?: AbortSignal }
  ): Promise<DeviceInferenceJob | null> {
    for (const job of this.jobs.values()) {
      if (this.matches(job, filter)) return Promise.resolve(this.hand(job));
    }
    return new Promise((resolve) => {
      const waiter: Waiter = { filter, resolve };
      this.waiters.add(waiter);
      const done = () => {
        if (this.waiters.delete(waiter)) resolve(null);
      };
      const timer = setTimeout(done, Math.max(0, Math.min(filter.waitMs, 25_000)));
      filter.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          done();
        },
        { once: true }
      );
    });
  }

  complete(accountId: string, jobId: string, result: DeviceInferenceResultInput): void {
    const job = this.requireClaimed(accountId, jobId, result.token);
    if (typeof result.text !== "string" || result.text.length > maxResultChars) {
      throw new DeviceInferenceBrokerError(
        400,
        "device_inference_result_invalid",
        "The result is invalid."
      );
    }
    const count = (value: unknown) =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000
        ? value
        : undefined;
    const inputTokens = count(result.usage?.inputTokens);
    const outputTokens = count(result.usage?.outputTokens);
    const latencyMs = count(result.latencyMs);
    const firstTokenMs = count(result.firstTokenMs);
    this.settle(job, {
      text: result.text,
      ...(inputTokens === undefined && outputTokens === undefined
        ? {}
        : {
            usage: {
              ...(inputTokens === undefined ? {} : { inputTokens }),
              ...(outputTokens === undefined ? {} : { outputTokens })
            }
          }),
      ...(latencyMs === undefined ? {} : { latencyMs }),
      ...(firstTokenMs === undefined ? {} : { firstTokenMs })
    });
  }

  fail(accountId: string, jobId: string, token: string): void {
    const job = this.requireClaimed(accountId, jobId, token);
    this.settle(
      job,
      new InferenceError(
        "INFERENCE_FAILED",
        {
          providerId: "local",
          modelId: job.view.modelId,
          diagnostic: "Device reported a failure."
        },
        "The on-device model could not complete this request."
      )
    );
  }

  /** Test/diagnostic view: number of jobs not yet settled. */
  openJobCount(): number {
    return [...this.jobs.values()].filter((job) => job.state !== "settled").length;
  }

  private matches(job: Job, filter: ClaimFilter): boolean {
    return (
      job.state === "pending" &&
      job.accountId === filter.accountId &&
      filter.availableModelIds.has(job.view.providerModelId) &&
      // An installed-app model needs an installed-app device; a browser-local model runs on either.
      (job.view.executionTarget === "browser-local" || filter.runtime === "installed-app") &&
      (filter.turnId === undefined || job.view.turnId === filter.turnId)
    );
  }

  private hand(job: Job): DeviceInferenceJob {
    const token = randomBytes(32);
    job.token = token;
    job.state = "claimed";
    job.timers.push(
      setTimeout(() => {
        if (job.state === "claimed") {
          this.settle(
            job,
            new InferenceError("REQUEST_TIMEOUT", {
              providerId: "local",
              modelId: job.view.modelId
            })
          );
        }
      }, this.completionTimeoutMs)
    );
    return { ...job.view, token: token.toString("base64url") };
  }

  private requireClaimed(accountId: string, jobId: string, token: string): Job {
    const job = this.jobs.get(jobId);
    // Every mismatch looks identical, so job ids cannot be probed across accounts.
    const notFound = new DeviceInferenceBrokerError(
      404,
      "device_inference_job_not_found",
      "Job not found."
    );
    if (
      job === undefined ||
      job.accountId !== accountId ||
      job.state !== "claimed" ||
      job.token === null
    ) {
      throw notFound;
    }
    const presented = Buffer.from(typeof token === "string" ? token : "", "base64url");
    if (presented.length !== job.token.length || !timingSafeEqual(presented, job.token))
      throw notFound;
    return job;
  }

  private settle(job: Job, outcome: DeviceInferenceOutcome | InferenceError): void {
    if (job.state === "settled") return;
    job.state = "settled";
    job.token = null;
    for (const timer of job.timers) clearTimeout(timer);
    this.jobs.delete(job.view.id);
    if (outcome instanceof InferenceError) job.reject(outcome);
    else job.resolve(outcome);
  }
}

export class DeviceInferenceBrokerError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "DeviceInferenceBrokerError";
  }
}
