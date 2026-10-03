import {
  assertStorage,
  cacheVerifiedArtifacts,
  OfflineError,
  type InstalledRuntimeAdapter,
  type RuntimeBinding
} from "@grogoni/offline-runtime";
// Type-only: erased at compile time, so this does not pull the ~6 MB webllm bundle into the main
// chunk. The real module is always loaded lazily via the dynamic import()s below.
import type * as WebLLM from "@mlc-ai/web-llm";
import { WEBLLM_PINNED_MODEL, webllmManifestPath } from "./webllm-model-manifest";

export interface OfflineAssistantRequest {
  prompt: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}
export interface OfflineAssistantReply {
  reply: string;
  modelId: string;
  modelVersion: string;
  engine: "webllm";
  answeredOffline: true;
}

const cacheName = "grogoni-webllm-runtime-v1";
type MLCEngine = Awaited<ReturnType<typeof WebLLM.CreateMLCEngine>>;
let enginePromise: Promise<MLCEngine> | null = null;
let loadedModelId: string | null = null;

function isWebGpuAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    (navigator as unknown as { gpu?: unknown }).gpu !== undefined
  );
}

function assertPinnedBinding(binding: RuntimeBinding): void {
  if (
    binding.agentId !== WEBLLM_PINNED_MODEL.agentId ||
    binding.modelId !== WEBLLM_PINNED_MODEL.modelId
  )
    throw new OfflineError(
      "DEVICE_NOT_SUPPORTED",
      "This device's pinned runtime does not match the offline assistant this build supports."
    );
}

/**
 * Resolves the RuntimeBinding this build pins for on-device inference. The manifest hash is
 * computed from whatever bytes are actually served right now; pinning that hash (via
 * pinCurrentRuntime) freezes it, so a later deploy that changes the pinned model fails integrity
 * re-verification on an already-offline device's frozen pin instead of silently switching models
 * underneath the user - see cacheVerifiedArtifacts in install() below.
 */
export async function resolveWebLLMRuntimeBinding(): Promise<RuntimeBinding> {
  // validateBinding requires an absolute https artifact URL - a bare root-relative path fails
  // `new URL()` with no base in both a real browser and here, so resolve it against the page
  // origin once, up front.
  const manifestUrl = new URL(webllmManifestPath, location.href).toString();
  const response = await fetch(manifestUrl, { cache: "no-store" });
  if (!response.ok)
    throw new OfflineError(
      "MODEL_NOT_INSTALLED",
      "The offline assistant manifest is unavailable on this device."
    );
  const buffer = await response.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const sha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return {
    agentId: WEBLLM_PINNED_MODEL.agentId,
    agentVersion: WEBLLM_PINNED_MODEL.agentVersion,
    modelId: WEBLLM_PINNED_MODEL.modelId,
    modelVersion: WEBLLM_PINNED_MODEL.modelVersion,
    artifacts: [{ url: manifestUrl, sha256, bytes: buffer.byteLength }]
  };
}

/** Test-only: clears the in-memory engine singleton so each test starts from a clean adapter. */
export function resetWebLLMRuntimeForTests(): void {
  enginePromise = null;
  loadedModelId = null;
}

/**
 * Finds the pinned model's real record in webllm's own shipped model list and restricts the
 * engine to exactly that one entry - this is the origin/content pin: the adapter never passes
 * webllm's full prebuiltAppConfig to CreateMLCEngine, only this single filtered record, so nothing
 * else in that catalogue is ever reachable through this adapter.
 */
async function pinnedModelRecord(webllm: typeof WebLLM): Promise<WebLLM.ModelRecord> {
  const record = webllm.prebuiltAppConfig.model_list.find(
    (candidate) => candidate.model_id === WEBLLM_PINNED_MODEL.modelId
  );
  if (!record || !record.model.startsWith(WEBLLM_PINNED_MODEL.modelOrigin))
    throw new OfflineError(
      "DEVICE_NOT_SUPPORTED",
      "The pinned offline model is not available from this build's approved runtime origin."
    );
  return record;
}

async function ensureEngine(
  binding: RuntimeBinding,
  progress: (downloaded: number, total: number) => void
): Promise<MLCEngine> {
  if (enginePromise && loadedModelId === binding.modelId) return enginePromise;
  const webllm = await import("@mlc-ai/web-llm");
  const record = await pinnedModelRecord(webllm);
  // vram_required_MB is copied straight from webllm's own shipped record for this model - it
  // approximates total device memory footprint, not exact download bytes, but it is real,
  // package-sourced data rather than a guessed figure, and is good enough to size progress and a
  // pre-download storage check.
  const totalBytes = Math.round((record.vram_required_MB ?? 1024) * 1024 * 1024);
  const promise = webllm.CreateMLCEngine(WEBLLM_PINNED_MODEL.modelId, {
    appConfig: { model_list: [record] },
    initProgressCallback: (report) => {
      progress(
        Math.max(0, Math.min(totalBytes, Math.round(report.progress * totalBytes))),
        totalBytes
      );
    }
  });
  enginePromise = promise;
  loadedModelId = binding.modelId;
  try {
    return await promise;
  } catch (error) {
    enginePromise = null;
    loadedModelId = null;
    throw error;
  }
}

async function supports(binding: RuntimeBinding): Promise<boolean> {
  if (!isWebGpuAvailable()) return false;
  if (
    binding.agentId !== WEBLLM_PINNED_MODEL.agentId ||
    binding.modelId !== WEBLLM_PINNED_MODEL.modelId
  )
    return false;
  try {
    const webllm = await import("@mlc-ai/web-llm");
    await pinnedModelRecord(webllm);
    return true;
  } catch {
    return false;
  }
}

async function install(
  binding: RuntimeBinding,
  progress: (downloaded: number, total: number) => void
): Promise<void> {
  assertPinnedBinding(binding);
  const manifestArtifact = binding.artifacts[0];
  if (!manifestArtifact)
    throw new OfflineError("MODEL_NOT_INSTALLED", "This pinned runtime has no manifest artifact.");
  await cacheVerifiedArtifacts([manifestArtifact], await caches.open(cacheName), () => undefined);
  const webllm = await import("@mlc-ai/web-llm");
  const record = await pinnedModelRecord(webllm);
  assertStorage(
    await navigator.storage.estimate(),
    Math.round((record.vram_required_MB ?? 1024) * 1024 * 1024)
  );
  await ensureEngine(binding, progress);
}

async function infer(binding: RuntimeBinding, args: unknown): Promise<unknown> {
  assertPinnedBinding(binding);
  const request = args as OfflineAssistantRequest;
  if (typeof request?.prompt !== "string" || !request.prompt.trim())
    throw new OfflineError("VALIDATION_FAILED", "A message is required.");
  const engine = await ensureEngine(binding, () => undefined);
  const completion = await engine.chat.completions.create({
    stream: false,
    messages: [
      {
        role: "system",
        content:
          "You are Grogoni's offline shop assistant, answering entirely on-device while this device " +
          "has no connection. You have no access to live catalogue, order, customer or account " +
          "data while offline - never claim otherwise, and tell the merchant to reconnect for " +
          "anything that needs current data."
      },
      ...(request.history ?? []).map((message) => ({
        role: message.role,
        content: message.content
      })),
      { role: "user", content: request.prompt }
    ]
  });
  const reply: OfflineAssistantReply = {
    reply: completion.choices[0]?.message?.content ?? "",
    modelId: binding.modelId,
    modelVersion: binding.modelVersion,
    engine: "webllm",
    answeredOffline: true
  };
  return reply;
}

export function createWebLLMRuntimeAdapter(): InstalledRuntimeAdapter {
  return { supports, install, infer };
}
