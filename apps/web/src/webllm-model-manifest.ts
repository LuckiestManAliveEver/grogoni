/**
 * Single source of truth for the one model this build pins for on-device offline inference.
 *
 * `modelId` must name an entry in the installed `@mlc-ai/web-llm` package's own
 * `prebuiltAppConfig.model_list` (tests/webllm-runtime.test.ts asserts this so an upgrade that
 * drops or renames the entry fails CI instead of silently breaking offline installs). The adapter
 * never loads webllm's full prebuilt catalogue - only this one modelId, filtered from webllm's own
 * real model list - so the approved-origin restriction described in docs/offline/README.md holds
 * regardless of what else ships in that catalogue.
 *
 * `public/webllm-runtime/manifest.json` mirrors these fields for humans inspecting the served
 * asset; the adapter itself only reads this module and the live model list, and hashes whatever
 * bytes are actually served at that path to build the pinned RuntimeBinding artifact.
 */
export const WEBLLM_PINNED_MODEL = {
  engine: "webllm",
  engineVersion: "0.2.85",
  agentId: "grogoni-offline-assistant",
  agentVersion: "1",
  modelId: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
  modelVersion: "q4f16_1",
  modelOrigin: "https://huggingface.co/mlc-ai/",
  contextWindowTokens: 4096
} as const;

export const webllmManifestPath = "/webllm-runtime/manifest.json";
