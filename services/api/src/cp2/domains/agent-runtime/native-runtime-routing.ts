import {
  isModelExecutionTarget,
  type ModelExecutionTarget,
  type ResolvedNativeRuntimeBinding,
  type RuntimeModelTrace,
  type RuntimeModelProvider,
  type ShopAgentRuntime
} from "@grogoni/shared-types";

import {
  runtimeProviderFromAdapter,
  type ModelRuntimeAdapter
} from "../../../inference/model-runtime.js";
import { Cp2Error } from "../../cp2-error.js";

/**
 * Where a resolved execution target actually came from, for observability
 * (services/api/src/cp2/domains/agent-runtime/runtime-model-routing.ts logs this on every turn) and
 * for tests that need to assert the precedence rule fired correctly rather than just its output.
 */
export type ExecutionTargetResolutionSource =
  "explicit-native-configuration" | "explicit-native-host";

export interface ExecutionTargetResolution {
  target: ModelExecutionTarget;
  source: ExecutionTargetResolutionSource;
}

// Split out so it can be unit-tested against each precedence branch (native configuration, native
// host, terminal failure) directly, without needing a full adapter/provider to exercise it.
//
// Deliberately has no final "else" branch that returns a default target: a model or binding that
// never declared where it runs is a routing failure, not an implicit "backend" default. Backend
// execution requires a deliberately configured, reachable host - silently assuming one manufactures
// a network dependency ("cannot currently be reached") that may not even exist in this deployment.
// See docs/architecture/provider-neutral-runtime.md.
export function resolveExecutionTarget(input: {
  nativeResolution: ResolvedNativeRuntimeBinding | null;
  modelId: string;
  agentId: string;
}): ExecutionTargetResolution {
  // A model may be installed on more than one execution location. The selected host is therefore
  // authoritative; model.configuration.executionTarget is retained only as a compatibility
  // fallback for partially migrated rows without a concrete host.
  const hostType = input.nativeResolution?.selected.host?.type;
  if (isModelExecutionTarget(hostType)) {
    return { target: hostType, source: "explicit-native-host" };
  }
  const declaredTarget = input.nativeResolution?.selected.model.configuration.executionTarget;
  if (isModelExecutionTarget(declaredTarget)) {
    return { target: declaredTarget, source: "explicit-native-configuration" };
  }
  throw new Cp2Error(
    409,
    "NO_COMPATIBLE_EXECUTION_TARGET",
    "No execution target is configured for this model. Choose or reconfigure a model before sending an AI message.",
    false,
    {
      modelId: input.modelId,
      agentId: input.agentId,
      hasNativeResolution: input.nativeResolution !== null
    }
  );
}

export function resolveNativeRuntimeModelProvider(input: {
  shopRuntime: ShopAgentRuntime;
  requestedModelId: string;
  nativeResolution: ResolvedNativeRuntimeBinding | null;
  requireAdapter: (input: {
    modelId: string;
    executionTarget: ModelExecutionTarget;
    agentId: string;
    businessId: string;
  }) => ModelRuntimeAdapter;
  adapterResolverConfigured: boolean;
  runtimeModelProvider?: RuntimeModelProvider;
  runtimeModelProviderResolver?: (modelId: string) => RuntimeModelProvider | undefined;
  attemptedRuntimeKeys?: ReadonlySet<string>;
  eligibleExecutionTargets?: ReadonlySet<ModelExecutionTarget>;
  /**
   * The account on whose behalf this turn executes - present whenever the caller has one (every
   * real chat turn does; some direct unit tests of this function do not). Combined with
   * `resolveInferenceCredential`, this is the whole BYO-credential mechanism: both are optional and
   * a no-op unless the resolved model's own `configuration.billingMode` opts in, so every existing
   * caller that omits them keeps its exact prior behavior.
   */
  accountId?: string;
  /**
   * Synchronous by design - see ExternalConnectionsDomain.resolveInferenceToken and
   * decryptOAuthToken, both plain in-memory/CPU operations with no I/O. Keeping this function a
   * pure, synchronous precedence resolver (an existing, deliberate property this file's own
   * comments call out) means the credential lookup must be injected as a value-returning callback
   * rather than awaited here.
   */
  resolveInferenceCredential?: (accountId: string, provider: string) => { token: string } | null;
}): {
  provider: RuntimeModelProvider | undefined;
  executionTarget: ModelExecutionTarget | undefined;
  resolutionSource: ExecutionTargetResolutionSource | null;
  runtimeKey: string | null;
  runtimeBindingId: string | null;
  resolvedModelId: string;
  executionHostId: string | null;
  fallbackIndex: number;
} {
  const nativeResolution = selectUnattemptedNativeResolution(
    input.nativeResolution,
    input.attemptedRuntimeKeys,
    input.eligibleExecutionTargets
  );
  const { shopRuntime } = input;
  const modelId = nativeResolution?.selected.model.id ?? input.requestedModelId;
  const agentId = nativeResolution?.agent.id ?? shopRuntime.agentId;
  const shopId = nativeResolution?.binding.businessId ?? shopRuntime.shopId;
  // Identical regardless of which branch below actually routes the request - computed once so a
  // future field addition/rename only needs one call site instead of two kept in lockstep by hand.
  const runtimeBindingId = nativeResolution?.binding.id ?? null;
  const executionHostId = nativeResolution?.selected.host?.id ?? null;
  const fallbackIndex =
    nativeResolution?.selected.bindingModel.role === "fallback"
      ? nativeResolution.fallbacks.findIndex(
          (candidate) => candidate.bindingModel.id === nativeResolution.selected.bindingModel.id
        ) + 1
      : 0;

  if (!input.adapterResolverConfigured) {
    // No adapter-based execution path is wired up at all - callers in this shape (a handful of
    // tests driving `runtimeModelProvider`/`runtimeModelProviderResolver` directly, bypassing the
    // execution-target/adapter system entirely) never consult the resolved target to route
    // anything, so there is nothing to fail routing over. Still resolve it best-effort, since it
    // only feeds observability (telemetry, trace) here, never a real network call.
    const provider =
      input.runtimeModelProviderResolver === undefined
        ? input.runtimeModelProvider
        : input.runtimeModelProviderResolver(modelId);
    const bestEffort = tryResolveExecutionTarget({ nativeResolution, modelId, agentId });
    return {
      provider,
      executionTarget: bestEffort?.target,
      resolutionSource: bestEffort?.source ?? null,
      runtimeKey:
        bestEffort === null
          ? null
          : runtimeCandidateKey(modelId, executionHostId, bestEffort.target),
      runtimeBindingId,
      resolvedModelId: modelId,
      executionHostId,
      fallbackIndex
    };
  }

  const { target: executionTarget, source: resolutionSource } = resolveExecutionTarget({
    nativeResolution,
    modelId,
    agentId
  });
  const runtimeKey = runtimeCandidateKey(modelId, executionHostId, executionTarget);
  if (input.attemptedRuntimeKeys?.has(runtimeKey)) {
    throw new Cp2Error(
      503,
      "RUNTIME_MODELS_UNAVAILABLE",
      "No unattempted compatible runtime remains for this request.",
      true
    );
  }
  const adapter = input.requireAdapter({ modelId, executionTarget, agentId, businessId: shopId });
  const providerCredential = resolveOwnAccountCredential(input, nativeResolution);
  const provider = runtimeProviderFromAdapter({
    adapter,
    context: {
      modelId,
      agentId,
      shopId,
      ...(runtimeBindingId === null ? {} : { runtimeBindingId }),
      ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
      ...(providerCredential === undefined ? {} : { providerCredential })
    }
  });
  return {
    provider,
    executionTarget,
    resolutionSource,
    runtimeKey,
    runtimeBindingId,
    resolvedModelId: modelId,
    executionHostId,
    fallbackIndex
  };
}

/**
 * Resolves a business's own connected provider credential for this turn, but only when every one
 * of these is true: the caller passed both `accountId` and `resolveInferenceCredential` (omitted by
 * every caller that doesn't need this - a pure no-op for them), the resolved native model's
 * `configuration.billingMode` is explicitly `"own-account"` (never inferred - see
 * ExternalRegistryConnection.inferenceAuthorized's own doc comment on the same principle), and that
 * account actually has a usable, inference-authorized connection for the model's provider. Any
 * missing piece falls through to `undefined`, meaning "use the platform's own credential" - this
 * function never fails a turn or throws; a misconfigured own-account preference degrades to the
 * platform default rather than blocking the chat.
 */
function resolveOwnAccountCredential(
  input: Pick<
    Parameters<typeof resolveNativeRuntimeModelProvider>[0],
    "accountId" | "resolveInferenceCredential"
  >,
  nativeResolution: ResolvedNativeRuntimeBinding | null
): { token: string } | undefined {
  if (input.accountId === undefined || input.resolveInferenceCredential === undefined) {
    return undefined;
  }
  // Read from the *binding* (genuinely scoped to one business+account+agent -
  // NativeRuntimeBindingStore keys it by a UUID derived from all three), never from the model row:
  // cp2_native_runtime_models is a single shared catalog entry per model id, reused by every
  // business that activates that model, so a billing-mode preference stored there would leak across
  // unrelated businesses the moment more than one activates the same model.
  const model = nativeResolution?.selected.model;
  const billingMode = nativeResolution?.binding.configuration.billingMode;
  if (model === undefined || billingMode !== "own-account") {
    return undefined;
  }
  return input.resolveInferenceCredential(input.accountId, model.provider) ?? undefined;
}

function selectUnattemptedNativeResolution(
  resolution: ResolvedNativeRuntimeBinding | null,
  attempted: ReadonlySet<string> | undefined,
  eligibleTargets: ReadonlySet<ModelExecutionTarget> | undefined
): ResolvedNativeRuntimeBinding | null {
  if (resolution === null) return null;
  const candidates = [resolution.primary, ...resolution.fallbacks].filter(
    (candidate, index, all) =>
      candidate.available &&
      all.findIndex((other) => other.bindingModel.id === candidate.bindingModel.id) === index
  );
  const selected = candidates.find((candidate) => {
    const target = candidate.host?.type ?? candidate.model.configuration.executionTarget;
    return (
      isModelExecutionTarget(target) &&
      (eligibleTargets === undefined || eligibleTargets.has(target)) &&
      !attempted?.has(runtimeCandidateKey(candidate.model.id, candidate.host?.id ?? null, target))
    );
  });
  if (selected === undefined) {
    // No unattempted/eligible native candidate remains - the native runtime graph is now the only
    // source of truth (the retired legacy-binding escape hatch is gone), so there is nothing left
    // to try. This also stops the "no adapter resolver configured" test-bypass branch above's retry
    // loop from re-invoking the exact same provider after it already failed once (that branch has
    // no attemptedRuntimeKeys check of its own and relies entirely on this throw).
    throw new Cp2Error(
      503,
      "RUNTIME_MODELS_UNAVAILABLE",
      "No unattempted compatible runtime remains for this request.",
      true
    );
  }
  return {
    ...resolution,
    selected,
    fallbackUsed: selected.bindingModel.role === "fallback",
    fallbackReason:
      selected.bindingModel.role === "fallback"
        ? attempted !== undefined && attempted.size > 0
          ? "PREVIOUS_EXECUTION_ATTEMPT_FAILED"
          : "PRIMARY_EXECUTION_TARGET_NOT_REACHABLE_FROM_SERVER"
        : resolution.fallbackReason
  };
}

function runtimeCandidateKey(
  modelId: string,
  executionHostId: string | null,
  target: ModelExecutionTarget
): string {
  return `${modelId}:${executionHostId ?? "unbound"}:${target}`;
}

function tryResolveExecutionTarget(
  input: Parameters<typeof resolveExecutionTarget>[0]
): ExecutionTargetResolution | null {
  try {
    return resolveExecutionTarget(input);
  } catch (error) {
    if (error instanceof Cp2Error) return null;
    throw error;
  }
}

export function assertResolvedRuntimeAvailable(
  resolution: ResolvedNativeRuntimeBinding | null,
  trace: RuntimeModelTrace | null
): void {
  if (resolution === null || trace === null || trace.status === "available") {
    return;
  }
  throw new Cp2Error(
    trace.status === "timeout" ? 504 : 503,
    "AGENT_MODEL_UNAVAILABLE",
    "The resolved runtime model could not complete this message.",
    true,
    {
      runtimeBindingId: resolution.binding.id,
      agentId: resolution.agent.id,
      modelId: resolution.selected.model.id,
      executionHostId: resolution.selected.host?.id ?? null,
      installationId: resolution.selected.installation?.id ?? null,
      fallbackReason: resolution.fallbackReason,
      runtimeErrorCode: trace.errorCode
    }
  );
}
