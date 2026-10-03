import type { DeviceInferenceJob } from "@grogoni/shared-types";
// Type-only: erased at compile time, so the ~6 MB webllm bundle is never in the main chunk. The real
// module is always loaded lazily through loadWebLLM() below.
import type * as WebLLM from "@mlc-ai/web-llm";

import {
  isDeviceInferenceSupported,
  listInstalledDeviceModels,
  writeInstalledDeviceModels
} from "./device-models";

export { isDeviceInferenceSupported, listInstalledDeviceModels };

/**
 * On-device model engine for the device-local models reinstated by
 * ADR-explicit-device-local-models.md. It runs generations the server delegates to this member's
 * device (see inference/device-inference-worker.ts) and nothing else.
 *
 * Model provenance is pinned the same way as the offline assistant (webllm-runtime.ts): a model is
 * loadable only if it is an entry of the installed @mlc-ai/web-llm package's own prebuilt list AND
 * its weights come from the approved origin below. The catalog can name a model; it cannot point
 * the browser at an arbitrary URL.
 */
export const approvedDeviceModelOrigin = "https://huggingface.co/mlc-ai/";

type MLCEngine = Awaited<ReturnType<typeof WebLLM.CreateMLCEngine>>;
type ModelRecord = WebLLM.ModelRecord;

let loadedEngine: { modelId: string; engine: Promise<MLCEngine> } | null = null;
let webllmModule: Promise<typeof WebLLM> | null = null;

function loadWebLLM(): Promise<typeof WebLLM> {
  webllmModule ??= import("@mlc-ai/web-llm");
  return webllmModule;
}

async function approvedRecord(providerModelId: string): Promise<ModelRecord> {
  const webllm = await loadWebLLM();
  const record = webllm.prebuiltAppConfig.model_list.find(
    (candidate) => candidate.model_id === providerModelId
  );
  if (record === undefined || !record.model.startsWith(approvedDeviceModelOrigin)) {
    throw new DeviceModelError(
      "MODEL_NOT_APPROVED",
      "This on-device model is not available from Grogoni's approved model source."
    );
  }
  return record;
}

export class DeviceModelError extends Error {
  constructor(
    readonly code:
      | "DEVICE_NOT_SUPPORTED"
      | "MODEL_NOT_APPROVED"
      | "MODEL_NOT_INSTALLED"
      | "INSUFFICIENT_STORAGE"
      | "GENERATION_FAILED",
    message: string
  ) {
    super(message);
    this.name = "DeviceModelError";
  }
}

async function engineFor(
  providerModelId: string,
  onProgress?: (fraction: number) => void
): Promise<MLCEngine> {
  if (loadedEngine?.modelId === providerModelId) return loadedEngine.engine;
  if (!isDeviceInferenceSupported()) {
    throw new DeviceModelError(
      "DEVICE_NOT_SUPPORTED",
      "This device's browser does not support on-device AI (WebGPU)."
    );
  }
  const webllm = await loadWebLLM();
  const record = await approvedRecord(providerModelId);
  const previous = loadedEngine;
  const engine = webllm.CreateMLCEngine(providerModelId, {
    appConfig: { model_list: [record] },
    initProgressCallback: (report) => onProgress?.(Math.max(0, Math.min(1, report.progress)))
  });
  loadedEngine = { modelId: providerModelId, engine };
  try {
    const ready = await engine;
    // One model in memory at a time: phones cannot hold two.
    if (previous !== null) void previous.engine.then((old) => old.unload()).catch(() => undefined);
    return ready;
  } catch (error) {
    loadedEngine = null;
    throw error;
  }
}

/** Approximate download size from webllm's own record, for the confirmation prompt. */
export async function deviceModelDownloadBytes(providerModelId: string): Promise<number | null> {
  try {
    const record = await approvedRecord(providerModelId);
    return record.vram_required_MB === undefined
      ? null
      : Math.round(record.vram_required_MB * 1024 * 1024);
  } catch {
    return null;
  }
}

/** Downloads (once, into the browser cache) and loads a model on this device. */
export async function installDeviceModel(
  providerModelId: string,
  onProgress: (fraction: number) => void
): Promise<void> {
  const bytes = await deviceModelDownloadBytes(providerModelId);
  if (bytes !== null && typeof navigator.storage?.estimate === "function") {
    const estimate = await navigator.storage.estimate();
    const free = (estimate.quota ?? Infinity) - (estimate.usage ?? 0);
    if (free < bytes) {
      throw new DeviceModelError(
        "INSUFFICIENT_STORAGE",
        "This device does not have enough free storage for this model."
      );
    }
  }
  await engineFor(providerModelId, onProgress);
  writeInstalledDeviceModels([...listInstalledDeviceModels(), providerModelId]);
}

export async function removeDeviceModel(providerModelId: string): Promise<void> {
  writeInstalledDeviceModels(listInstalledDeviceModels().filter((id) => id !== providerModelId));
  if (loadedEngine?.modelId === providerModelId) {
    const engine = loadedEngine.engine;
    loadedEngine = null;
    await engine.then((ready) => ready.unload()).catch(() => undefined);
  }
  try {
    const webllm = await loadWebLLM();
    const record = await approvedRecord(providerModelId);
    await webllm.deleteModelAllInfoInCache(providerModelId, { model_list: [record] });
  } catch {
    // Already gone, or storage unavailable: nothing else to remove.
  }
}

export interface DeviceGenerationResult {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  latencyMs: number;
  firstTokenMs?: number;
}

/**
 * Runs one server-delegated generation. The messages are exactly what the server built; this
 * device adds nothing and executes nothing - the output goes back to the server, which parses,
 * validates and confirmation-gates it like any other model's output.
 */
export async function runDeviceGeneration(
  job: Pick<DeviceInferenceJob, "providerModelId" | "messages" | "generation">,
  onDelta: (text: string) => void,
  signal?: AbortSignal
): Promise<DeviceGenerationResult> {
  if (!listInstalledDeviceModels().includes(job.providerModelId)) {
    throw new DeviceModelError(
      "MODEL_NOT_INSTALLED",
      "This on-device model is not installed on this device."
    );
  }
  const startedAt = performance.now();
  const engine = await engineFor(job.providerModelId);
  const stream = await engine.chat.completions.create({
    stream: true,
    stream_options: { include_usage: true },
    messages: job.messages,
    max_tokens: job.generation.maxOutputTokens,
    temperature: job.generation.temperature,
    ...(job.generation.jsonOutput ? { response_format: { type: "json_object" as const } } : {})
  });
  let text = "";
  let firstTokenMs: number | undefined;
  let usage: DeviceGenerationResult["usage"];
  for await (const chunk of stream) {
    if (signal?.aborted === true) {
      engine.interruptGenerate();
      throw new DeviceModelError("GENERATION_FAILED", "Generation was cancelled.");
    }
    const delta = chunk.choices[0]?.delta?.content ?? "";
    if (delta !== "") {
      firstTokenMs ??= Math.round(performance.now() - startedAt);
      text += delta;
      onDelta(delta);
    }
    if (chunk.usage !== undefined && chunk.usage !== null) {
      usage = {
        inputTokens: chunk.usage.prompt_tokens,
        outputTokens: chunk.usage.completion_tokens
      };
    }
  }
  return {
    text,
    ...(usage === undefined ? {} : { usage }),
    latencyMs: Math.round(performance.now() - startedAt),
    ...(firstTokenMs === undefined ? {} : { firstTokenMs })
  };
}

/** Test-only reset of module state. */
export function resetDeviceModelEngineForTests(): void {
  loadedEngine = null;
  webllmModule = null;
}
