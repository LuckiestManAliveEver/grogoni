import { describe, expect, it } from "vitest";
import { applyDeploymentRuntimeAvailability } from "../apps/web/src/agent-model-panel-utils";
import type { AiModelSummary } from "../apps/web/src/grogoni-application-shared";

const modelId = "qwen2.5-0.5b-android";

describe("agent model catalogue runtime availability", () => {
  it("overlays API-owned backend capability onto the offline catalogue duplicate", () => {
    const offline = model();
    const configured = model({ runtimeAvailability: { backend: "configured" } });
    const unconfigured = model({ runtimeAvailability: { backend: "unconfigured" } });

    expect(
      applyDeploymentRuntimeAvailability([offline], [configured])[0]?.runtimeAvailability
    ).toEqual({ backend: "configured" });
    expect(
      applyDeploymentRuntimeAvailability([offline], [unconfigured])[0]?.runtimeAvailability
    ).toEqual({ backend: "unconfigured" });
    expect(
      applyDeploymentRuntimeAvailability([offline], [])[0]?.runtimeAvailability
    ).toBeUndefined();
  });

  it("never transfers availability between different model IDs", () => {
    const offline = model();
    const anotherModel = model({
      id: "another-model",
      runtimeAvailability: { backend: "configured" }
    });

    expect(
      applyDeploymentRuntimeAvailability([offline], [anotherModel])[0]?.runtimeAvailability
    ).toBeUndefined();
  });
});

function model(patch: Partial<AiModelSummary> = {}): AiModelSummary {
  return {
    id: modelId,
    label: "Qwen",
    provider: "local",
    description: "Test model",
    capabilities: ["chat"],
    available: true,
    source: "huggingface",
    format: "GGUF",
    license: null,
    licenseUrl: null,
    modelCardUrl: null,
    downloadUrl: null,
    fileName: null,
    fileSizeBytes: null,
    minimumMemoryGb: null,
    recommended: true,
    ...patch
  };
}
