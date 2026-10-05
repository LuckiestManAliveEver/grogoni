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
   * real chat turn does; some direct unit tests of this function do not). Forwarded to the
   * adapter, which uses it to address the account's live reply stream and device jobs.
   */
  accountId?: string;
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
  const provider = runtimeProviderFromAdapter({
    adapter,
    context: {
      modelId,
      agentId,
      shopId,
      ...(runtimeBindingId === null ? {} : { runtimeBindingId }),
      ...(input.accountId === undefined ? {} : { accountId: input.accountId })
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
