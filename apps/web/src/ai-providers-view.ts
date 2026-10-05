import type { InferenceProviderSummary } from "@grogoni/shared-types";

/**
 * Pure presentation rules for the AI providers settings card (AiProvidersPanel.tsx). Inference is
 * local-only, so every provider is a device-local one and there are no keys to connect.
 */
export interface ProviderCardState {
  status: string;
  detail: string;
}

export function providerCardState(input: {
  provider: InferenceProviderSummary;
  deviceLocalAvailable: boolean;
}): ProviderCardState {
  if (!input.provider.enabled) {
    return { status: "Unavailable", detail: "Turned off for this deployment." };
  }
  return {
    status: input.deviceLocalAvailable
      ? "Available on this device"
      : "Not available on this device",
    detail: "Runs privately on this phone or computer. Nothing is sent to a cloud provider."
  };
}

export function isDeviceLocalInferenceAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    (navigator as unknown as { gpu?: unknown }).gpu !== undefined
  );
}
