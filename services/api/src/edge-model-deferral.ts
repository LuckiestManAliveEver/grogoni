import type { Cp2StoreOptions } from "./cp2/store.js";
import {
  ModelRuntimeError,
  type ModelRuntimeAdapter,
  type ModelRuntimeContext,
  type ModelRuntimeGenerationResult,
  type ModelRuntimeHealthResult
} from "./inference/model-runtime.js";
import { isValidTurnId, turnContext } from "./inference/turn-stream.js";

/**
 * Model calls never run inside an Edge transaction (docs/deployment/supabase-edge-api.md, "Agent
 * turns"). Every Edge request attempt hands its store a deferring resolver from a ledger that
 * lives across the request's attempts:
 *
 * - inside an attempt, `generate` and `healthCheck` never reach a provider. A call whose recorded
 *   result is next in the ledger (same kind, same adapter, same input once UUIDs and timestamps
 *   are masked) gets that result back, or its recorded error thrown again. Any other call is
 *   recorded as pending and throws ModelCallDeferredError;
 * - the request pipeline checks `pending` after the route ran and before anything is saved or
 *   committed on the side. A pending call rolls the whole attempt back, then `callLive` makes the
 *   call with no transaction open and the request runs again with one more recorded result.
 *
 * Where the error is caught and turned into a "model unavailable" outcome (runtimeProviderFromAdapter
 * does that) nothing is lost: the pipeline reads `pending`, not the error.
 *
 * `canRun` passes through. On the Edge API every adapter comes from createOpenRouterRuntime, whose
 * canRun reads only its configuration (tests/edge-model-deferral.test.ts pins that).
 */

type Resolver = NonNullable<Cp2StoreOptions["modelRuntimeAdapterResolver"]>;
type ResolverInput = Parameters<Resolver>[0];
type CallKind = "generate" | "healthCheck";
type Outcome =
  | { ok: ModelRuntimeGenerationResult | ModelRuntimeHealthResult }
  | { error: { name: string; message: string; code: string | null; retryable: boolean } };

interface PendingCall {
  kind: CallKind;
  resolverInput: ResolverInput;
  /** The call's input without its abort signal. */
  input: Record<string, unknown>;
  fingerprint: string;
}

/** The most provider calls one request (or one background agent turn) may make. */
export const maxLiveModelCalls = 4;
/** One live call's limit; the OpenRouter adapter's own limit (120 s) is longer. */
export const liveModelCallTimeoutMs = 60_000;

export class ModelCallDeferredError extends Error {
  constructor() {
    super("This model call runs after the transaction ends.");
    this.name = "ModelCallDeferredError";
  }
}

/** Thrown by the pipeline to roll an attempt back once it needs a model call. */
export class AttemptNeedsModelCall extends Error {
  constructor(readonly independentWork: boolean) {
    super("The attempt needs a model call; it is rolled back and runs again after the call.");
    this.name = "AttemptNeedsModelCall";
  }
}

const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const isoTimePattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/gu;

/**
 * The same call in two attempts differs only in IDs and clocks minted per attempt (a turn id, the
 * request time). Anything else that differs (a product count, the conversation history) means the
 * data changed between attempts, so the recorded result does not answer this call.
 */
export function modelCallFingerprint(
  kind: CallKind,
  resolverInput: ResolverInput,
  input: Record<string, unknown>
): string {
  return JSON.stringify({ kind, resolverInput, input }, (_key, value: unknown) =>
    value instanceof AbortSignal ? undefined : value
  )
    .replace(uuidPattern, "<id>")
    .replace(isoTimePattern, "<time>");
}

function withoutSignal(input: Record<string, unknown>): Record<string, unknown> {
  const context = input.context as ModelRuntimeContext | undefined;
  if (context === undefined) return { ...input };
  const rest: Partial<ModelRuntimeContext> = { ...context };
  delete rest.signal;
  return { ...input, context: rest };
}

export class ModelCallLedger {
  private readonly recorded: { fingerprint: string; outcome: Outcome }[] = [];
  private cursor = 0;
  private live = 0;
  pending: PendingCall | null = null;
  /** Calls answered from the ledger, for the request's trace. */
  replayed = 0;
  /** Calls whose recording no longer matched (the data changed between attempts). */
  mismatched = 0;

  constructor(
    private readonly real: Resolver,
    private readonly options: { streamTurnId?: string | null; timeoutMs?: number } = {}
  ) {}

  /** Starts an attempt: replay from the first recorded call again. */
  beginAttempt(): void {
    this.cursor = 0;
    this.pending = null;
  }

  get liveCalls(): number {
    return this.live;
  }

  /** The resolver one attempt's store uses. */
  resolver(): Resolver {
    return (resolverInput) => {
      const adapter = this.real(resolverInput);
      if (adapter === undefined) return undefined;
      const deferred = (kind: CallKind, input: Record<string, unknown>) =>
        this.next(kind, resolverInput, withoutSignal(input));
      const wrapped: ModelRuntimeAdapter = {
        provider: adapter.provider,
        executionTarget: adapter.executionTarget,
        canRun: (context) => adapter.canRun(context),
        healthCheck: async (context) =>
          (await deferred("healthCheck", { context })) as ModelRuntimeHealthResult,
        generate: async (input) =>
          (await deferred("generate", {
            context: input.context,
            prompt: input.prompt
          })) as ModelRuntimeGenerationResult
      };
      return wrapped;
    };
  }

  private async next(
    kind: CallKind,
    resolverInput: ResolverInput,
    input: Record<string, unknown>
  ): Promise<ModelRuntimeGenerationResult | ModelRuntimeHealthResult> {
    // After one deferred call the rest of the attempt is discarded: answer nothing more.
    if (this.pending !== null) throw new ModelCallDeferredError();
    const fingerprint = modelCallFingerprint(kind, resolverInput, input);
    const entry = this.recorded[this.cursor];
    if (entry !== undefined && entry.fingerprint === fingerprint) {
      this.cursor += 1;
      this.replayed += 1;
      if ("ok" in entry.outcome) return structuredClone(entry.outcome.ok);
      const failure = entry.outcome.error;
      throw failure.name === "ModelRuntimeError"
        ? new ModelRuntimeError(
            failure.code ?? "INFERENCE_FAILED",
            failure.message,
            failure.retryable
          )
        : Object.assign(new Error(failure.message), { name: failure.name });
    }
    if (entry !== undefined) {
      // The data changed since the call was recorded: that result and every later one are void.
      this.mismatched += 1;
      this.recorded.length = this.cursor;
    }
    this.pending = { kind, resolverInput, input, fingerprint };
    throw new ModelCallDeferredError();
  }

  /**
   * Makes the pending call, outside any transaction, and records its outcome. Throws a
   * ModelRuntimeError (retryable) once the request has used its live calls: the data kept
   * changing under it.
   */
  async callLive(signal?: AbortSignal): Promise<void> {
    const call = this.pending;
    if (call === null) return;
    this.pending = null;
    if (this.live >= maxLiveModelCalls)
      throw new ModelRuntimeError(
        "AGENT_TURN_UNSTABLE",
        "The shop data kept changing while the agent worked. Try again.",
        true
      );
    this.live += 1;
    const adapter = this.real(call.resolverInput);
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? liveModelCallTimeoutMs);
    const callSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const context = { ...(call.input.context as ModelRuntimeContext), signal: callSignal };
    // A provider that ignores its signal must not keep the run past its limit.
    const stopped = new Promise<never>((_resolve, reject) => {
      const stop = () => reject(callSignal.reason ?? new Error("The model call was stopped."));
      if (callSignal.aborted) stop();
      else callSignal.addEventListener("abort", stop, { once: true });
    });
    stopped.catch(() => {});
    const run = async (): Promise<Outcome> => {
      try {
        if (adapter === undefined)
          throw new ModelRuntimeError(
            "RUNTIME_NOT_CONFIGURED",
            "The selected model runtime is not configured for this deployment.",
            false
          );
        return {
          ok:
            call.kind === "generate"
              ? await Promise.race([
                  stopped,
                  adapter.generate({
                    context,
                    prompt: call.input.prompt as Parameters<
                      ModelRuntimeAdapter["generate"]
                    >[0]["prompt"]
                  })
                ])
              : await Promise.race([stopped, adapter.healthCheck(context)])
        };
      } catch (error) {
        const timedOut = timeout.aborted && !(signal?.aborted ?? false);
        return {
          error: {
            name:
              error instanceof ModelRuntimeError || timedOut
                ? "ModelRuntimeError"
                : error instanceof Error
                  ? error.name
                  : "Error",
            message: timedOut
              ? "The model did not answer in time."
              : error instanceof Error
                ? error.message
                : "The model call failed.",
            code: timedOut
              ? "INFERENCE_TIMEOUT"
              : error instanceof ModelRuntimeError
                ? error.code
                : null,
            retryable: timedOut || (error instanceof ModelRuntimeError ? error.retryable : true)
          }
        };
      }
    };
    const streamTurnId = this.options.streamTurnId;
    const outcome = isValidTurnId(streamTurnId)
      ? await turnContext.run({ turnId: streamTurnId }, run)
      : await run();
    this.recorded.push({ fingerprint: call.fingerprint, outcome });
  }
}

/**
 * Wraps the store's outbound senders so that, once an attempt has a pending model call, they send
 * nothing more: that attempt is rolled back and runs again, and its sends would repeat.
 */
export function suppressAfterDeferral<T extends object>(
  dependency: T,
  ledger: { readonly pending: unknown }
): T {
  if (typeof dependency === "function") {
    return ((...args: unknown[]) => {
      if (ledger.pending !== null) throw new ModelCallDeferredError();
      return (dependency as (...values: unknown[]) => unknown)(...args);
    }) as T;
  }
  return new Proxy(dependency, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (ledger.pending !== null) throw new ModelCallDeferredError();
        return (value as (...values: unknown[]) => unknown).apply(target, args);
      };
    }
  });
}
