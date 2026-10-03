import type { DeviceInferenceRuntime } from "@grogoni/shared-types";

/**
 * Lightweight on-device model facts that the chat and model switcher need synchronously. Kept
 * separate from device-model-engine.ts so loading them never pulls the engine (or WebLLM) into the
 * owner route chunk; the engine is imported lazily only when a model is installed or run.
 */
const installedModelsStorageKey = "grogoni.device-models.v1";

export function isDeviceInferenceSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    (navigator as unknown as { gpu?: unknown }).gpu !== undefined
  );
}

/** "installed-app" when Grogoni runs as an installed app (standalone display), else "browser-local". */
export function currentDeviceRuntime(): DeviceInferenceRuntime {
  const standalone =
    typeof window !== "undefined" &&
    (window.matchMedia?.("(display-mode: standalone)").matches === true ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true);
  return standalone ? "installed-app" : "browser-local";
}

export function listInstalledDeviceModels(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(installedModelsStorageKey) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string").slice(0, 20)
      : [];
  } catch {
    return [];
  }
}

export function writeInstalledDeviceModels(ids: string[]): void {
  try {
    localStorage.setItem(installedModelsStorageKey, JSON.stringify([...new Set(ids)]));
  } catch {
    // Storage blocked (private mode): the model still works for this page session.
  }
}
