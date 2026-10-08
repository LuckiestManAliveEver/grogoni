import {
  isDeviceExecutionTarget,
  type AiModelSummary,
  type ModelExecutionTarget
} from "@grogoni/shared-types";

import { DeviceInferenceBroker } from "../device-inference-broker.js";
import type { ModelRuntimeAdapter } from "../model-runtime.js";
import type { InferenceProvider, ModelDefinition } from "./contract.js";
import { readInferenceEnvironment, type InferenceEnvironment } from "./environment.js";
import {
  InferenceRouter,
  type InferenceLogger,
  type InferenceMetricsSink
} from "./inference-router.js";
import { modelDefinitionFromCatalog, nativeExecutionTargetFor } from "./model-definitions.js";
import { InferenceProviderRegistry } from "./provider-registry.js";
import { createMemoryInferenceRepositories, type InferenceRepositories } from "./repositories.js";
import { createRoutedModelRuntimeAdapter } from "./routed-model-adapter.js";
import { InferenceUsageGuard, type RequestRateLimiter } from "./usage-policy.js";

/**
 * Everything the device-local inference layer needs, assembled once per process. Cp2Store owns the only
 * reference used by request handling; services/api/src/index.ts constructs it with Postgres
 * repositories and the environment, tests construct it with memory repositories and fake transports.
 */
export interface InferencePlatform {
  readonly environment: InferenceEnvironment;
  readonly registry: InferenceProviderRegistry;
  readonly router: InferenceRouter;
  readonly repositories: InferenceRepositories;
  /** Delivers device-local generations to members' own devices. */
  readonly deviceBroker: DeviceInferenceBroker;
  /** Late-bound catalog source (the store's own cp2_model_catalog view). */
  setModelCatalog(source: () => readonly AiModelSummary[]): void;
  resolveModelDefinition(modelId: string): ModelDefinition | null;
  /** Router-backed ModelRuntimeAdapter for a provider-routed catalog model, if it has one. */
  adapterFor(input: {
    modelId: string;
    executionTarget: ModelExecutionTarget;
  }): ModelRuntimeAdapter | undefined;
  /** Native target a configured, enabled provider serves this model on, if any. */
  hostedExecutionTargetFor(modelId: string): ModelExecutionTarget | undefined;
  refresh(): Promise<void>;
  /**
   * Hard-deletes usage rows and any encrypted keys left by the retired BYOK connections for a
   * deleted account or shop.
   */
  purgeOwner(input: { tenantId?: string; userId?: string }): Promise<void>;
}

export interface CreateInferencePlatformOptions {
  environment?: InferenceEnvironment;
  repositories?: InferenceRepositories;
  metrics?: InferenceMetricsSink;
  log?: InferenceLogger;
  providerOverrides?: ReadonlyMap<string, InferenceProvider>;
  now?: () => number;
  deviceBroker?: DeviceInferenceBroker;
  /** Shared (Redis) request counter; defaults to in-process. */
  rateLimiter?: RequestRateLimiter;
}

export function createInferencePlatform(
  options: CreateInferencePlatformOptions = {}
): InferencePlatform {
  const environment = options.environment ?? readInferenceEnvironment({});
  const repositories = options.repositories ?? createMemoryInferenceRepositories();
  let catalogSource: () => readonly AiModelSummary[] = () => [];
  const deviceBroker = options.deviceBroker ?? new DeviceInferenceBroker();

  const resolveModelDefinition = (modelId: string): ModelDefinition | null => {
    const summary = catalogSource().find((model) => model.id === modelId);
    return summary === undefined ? null : modelDefinitionFromCatalog(summary);
  };

  const registry = new InferenceProviderRegistry({
    builtinProviders: environment.providers,
    repository: repositories.providers,
    adapterDeps: {
      deviceBroker,
      ...(options.now === undefined ? {} : { now: options.now })
    },
    ...(options.providerOverrides === undefined
      ? {}
      : { providerOverrides: options.providerOverrides })
  });
  const usage = new InferenceUsageGuard({
    runs: repositories.runs,
    policies: repositories.policies,
    environment: environment.budgets,
    ...(options.rateLimiter === undefined ? {} : { limiter: options.rateLimiter }),
    ...(options.now === undefined ? {} : { now: () => new Date((options.now as () => number)()) })
  });
  const router = new InferenceRouter({
    registry,
    resolveModel: resolveModelDefinition,
    usage,
    runs: repositories.runs,
    defaults: {
      timeoutMs: environment.requestTimeoutMs,
      maxOutputTokens: environment.maxOutputTokens,
      defaultModelId: environment.defaultModelId,
      currency: environment.budgets.currency
    },
    ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.now === undefined ? {} : { now: options.now })
  });
  const servedTarget = (model: ModelDefinition): ModelExecutionTarget | undefined => {
    const registered = registry.get(model.providerId);
    if (registered === undefined || !registered.config.enabled || !model.enabled) return undefined;
    const target = nativeExecutionTargetFor(model.executionTarget);
    // The router serves only device-local models. Shop devices keep the owner-node broker and
    // server-side models run through local Ollama (inference/model-runtime.ts).
    return isDeviceExecutionTarget(target) ? target : undefined;
  };

  return {
    environment,
    registry,
    router,
    repositories,
    deviceBroker,
    setModelCatalog(source) {
      catalogSource = source;
    },
    resolveModelDefinition,
    adapterFor(input) {
      const model = resolveModelDefinition(input.modelId);
      if (model === null) return undefined;
      const target = servedTarget(model);
      if (target === undefined || target !== input.executionTarget) return undefined;
      return createRoutedModelRuntimeAdapter({ router, model, executionTarget: target });
    },
    hostedExecutionTargetFor(modelId) {
      const model = resolveModelDefinition(modelId);
      return model === null ? undefined : servedTarget(model);
    },
    async refresh() {
      await registry.refresh();
    },
    async purgeOwner(input) {
      await repositories.credentials.deleteForOwner(input);
      await repositories.runs.deleteForOwner(input);
    }
  };
}
