import type { DeviceInferenceBroker } from "../device-inference-broker.js";
import type { InferenceProvider } from "./contract.js";
import { createLocalInferenceProvider } from "./local-provider.js";
import {
  isInferenceProviderType,
  type InferenceProviderConfig,
  type InferenceProviderView
} from "./provider-config.js";
import type { ProviderConfigRepository } from "./repositories.js";

export interface ProviderAdapterDeps {
  deviceBroker?: DeviceInferenceBroker;
  now?: () => number;
}

/** The only provider type left: generation on the requesting member's own device. */
function createProvider(config: InferenceProviderConfig, deps: ProviderAdapterDeps) {
  return createLocalInferenceProvider(config, {
    ...(deps.deviceBroker === undefined ? {} : { broker: deps.deviceBroker }),
    ...(deps.now === undefined ? {} : { now: deps.now })
  });
}

export interface RegisteredProvider {
  config: InferenceProviderConfig;
  provider: InferenceProvider;
}

/**
 * Configured provider instances: the built-in local provider, overridden or extended by
 * operator-managed database rows (inference_providers). Rows of retired hosted types never load.
 */
export class InferenceProviderRegistry {
  private entries = new Map<string, RegisteredProvider>();

  constructor(
    private readonly deps: {
      builtinProviders: readonly InferenceProviderConfig[];
      repository: ProviderConfigRepository;
      adapterDeps: ProviderAdapterDeps;
      /** Tests only: replaces the adapter for an id while keeping its configuration. */
      providerOverrides?: ReadonlyMap<string, InferenceProvider>;
    }
  ) {
    this.install(deps.builtinProviders);
  }

  /** Reloads database rows. Safe to call periodically; failures keep the last good set. */
  async refresh(): Promise<void> {
    const databaseRows = await this.deps.repository.list();
    this.install(mergeProviderConfigs(this.deps.builtinProviders, databaseRows));
  }

  get(providerId: string): RegisteredProvider | undefined {
    return this.entries.get(providerId);
  }

  list(): RegisteredProvider[] {
    return [...this.entries.values()];
  }

  views(): InferenceProviderView[] {
    return this.list().map(({ config }) => ({
      id: config.id,
      displayName: config.displayName,
      type: config.type,
      executionTarget: config.executionTarget,
      enabled: config.enabled
    }));
  }

  private install(configs: readonly InferenceProviderConfig[]): void {
    const next = new Map<string, RegisteredProvider>();
    for (const config of configs) {
      // Rows of retired hosted types (openai, anthropic, ...) never load, whatever their source.
      if (!isInferenceProviderType(config.type)) continue;
      const override = this.deps.providerOverrides?.get(config.id);
      next.set(config.id, {
        config,
        provider: override ?? createProvider(config, this.deps.adapterDeps)
      });
    }
    this.entries = next;
  }
}

export function mergeProviderConfigs(
  builtinProviders: readonly InferenceProviderConfig[],
  databaseRows: readonly InferenceProviderConfig[]
): InferenceProviderConfig[] {
  const merged = new Map<string, InferenceProviderConfig>();
  for (const config of builtinProviders) merged.set(config.id, config);
  // A row of a retired hosted type must not shadow (and so remove) a built-in provider of the
  // same id, so it is dropped before merging.
  for (const row of databaseRows.filter((candidate) => isInferenceProviderType(candidate.type))) {
    const existing = merged.get(row.id);
    merged.set(row.id, existing === undefined ? row : { ...existing, ...row, source: "database" });
  }
  return [...merged.values()];
}
