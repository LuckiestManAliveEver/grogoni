import { createCp2Store as createStore } from "../../services/api/src/cp2/store";

/**
 * The repository default is Grogoni + GPT-6 Luna through OpenRouter (backend). Suites that
 * exercise the local-first path pin the explicit local deployment default instead; hosted-default
 * behaviour is covered in tests/openrouter-runtime.test.ts. Options passed in still win.
 */
export const localDefaultRuntime = {
  agentId: "builtin:shopkeeper:v1",
  agentName: "Shopkeeper",
  agentRuntimeAdapterId: "grogoni",
  modelId: "smollm2-360m",
  executionTarget: "local"
} as const;

export function createLocalDefaultCp2Store(options: Parameters<typeof createStore>[0] = {}) {
  return createStore({ platformDefaultRuntime: localDefaultRuntime, ...options });
}
