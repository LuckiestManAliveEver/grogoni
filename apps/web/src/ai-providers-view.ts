import type {
  InferenceProviderConnectionSummary,
  InferenceProviderSummary
} from "@grogoni/shared-types";

/**
 * Pure presentation rules for the AI providers settings card (AiProvidersPanel.tsx). Everything
 * here is derived from backend summaries; the browser never holds, stores, or displays a key.
 */
export interface ProviderCardState {
  status: string;
  detail: string;
  /** The connection this card manages, if any (the shop's key takes precedence over the person's). */
  connection: InferenceProviderConnectionSummary | null;
  canConnect: boolean;
}

export function providerCardState(input: {
  provider: InferenceProviderSummary;
  connections: readonly InferenceProviderConnectionSummary[];
  businessId: string;
  deviceLocalAvailable: boolean;
}): ProviderCardState {
  const { provider } = input;
  if (provider.type === "local") {
    return {
      status: input.deviceLocalAvailable
        ? "Available on this device"
        : "Not available on this device",
      detail: "Runs privately on this phone or computer. Nothing is sent to a cloud provider.",
      connection: null,
      canConnect: false
    };
  }
  if (!provider.enabled) {
    return {
      status: "Unavailable",
      detail: "Turned off for this deployment.",
      connection: null,
      canConnect: false
    };
  }
  const owned = input.connections.filter(
    (connection) => connection.providerId === provider.id && connection.status !== "REVOKED"
  );
  // Same precedence the server uses: the shop's key, then the person's own key, then Grogoni's.
  const connection =
    owned.find((entry) => entry.scope === "tenant" && entry.businessId === input.businessId) ??
    owned.find((entry) => entry.scope === "user") ??
    null;
  if (connection !== null) {
    return {
      status: connection.status === "INVALID" ? "Key rejected" : "Connected",
      detail:
        connection.status === "INVALID"
          ? "The provider rejected this key. Replace it to keep using this provider."
          : connection.scope === "tenant"
            ? "Using this shop's own API key. Usage is billed to the shop's provider account."
            : "Using your own API key. Usage is billed to your provider account.",
      connection,
      canConnect: provider.byokAllowed
    };
  }
  if (provider.managedCredentialConfigured) {
    return {
      status: "Available",
      detail: provider.byokAllowed
        ? "Provided by Grogoni. You can also connect your own key."
        : "Provided by Grogoni.",
      connection: null,
      canConnect: provider.byokAllowed
    };
  }
  return {
    status: "Not connected",
    detail: provider.byokAllowed ? "Connect an API key to use this provider." : "Not configured.",
    connection: null,
    canConnect: provider.byokAllowed
  };
}

/** "••••••••••••••••x7K2" - only the server-provided hint, never anything derived locally. */
export function maskedKey(secretHint: string | null): string {
  return `${"•".repeat(16)}${secretHint ?? ""}`;
}

export function isDeviceLocalInferenceAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    (navigator as unknown as { gpu?: unknown }).gpu !== undefined
  );
}
