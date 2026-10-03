const backendRuntimeStatusMessages: Readonly<Record<string, string>> = {
  RUNTIME_NOT_CONFIGURED: "Backend inference is not configured for this deployment.",
  RUNTIME_UNAVAILABLE: "The backend model runtime is currently unavailable.",
  INFERENCE_DISABLED: "Backend inference is disabled for this deployment.",
  MODEL_NOT_INSTALLED: "The model is not installed on the inference service.",
  MODEL_LOADING: "The backend model is still loading. Try again shortly.",
  MODEL_NOT_LOADED: "The backend model is not loaded. Try again after it finishes starting.",
  MODEL_STORAGE_NOT_DURABLE: "The inference service does not have durable model storage.",
  INFERENCE_TIMEOUT: "The backend model did not respond before the request timed out.",
  INFERENCE_AUTHENTICATION_FAILED: "The API could not authenticate with the inference service.",
  INFERENCE_ENGINE_UNREACHABLE:
    "The inference service is online, but its model engine cannot be reached.",
  INFERENCE_SERVICE_UNREACHABLE: "The Grogoni inference service cannot currently be reached.",
  INVALID_INFERENCE_RESPONSE: "The inference service returned an invalid response.",
  MODEL_PROBE_FAILED: "The backend model failed its inference test.",
  MODEL_HEALTH_CHECK_FAILED: "The backend model failed its health check."
};

export function backendModelRuntimeStatusMessage(errorCode: string | null): string {
  if (errorCode === null) {
    return "The backend model test failed before the service returned a diagnosis.";
  }
  return backendRuntimeStatusMessages[errorCode] ?? "The backend model is currently unavailable.";
}
