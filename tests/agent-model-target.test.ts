// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  isServerExecutionTarget,
  servedExecutionTarget
} from "../apps/web/src/agent-model-panel-utils";
import type { AiModelSummary } from "../apps/web/src/grogoni-application-shared";
import { isAgentModel } from "../apps/web/src/owner-app-bootstrap";

function model(overrides: Partial<AiModelSummary> = {}): AiModelSummary {
  return { id: "smollm2-360m", label: "SmolLM2 360M", ...overrides } as AiModelSummary;
}

describe("served execution target", () => {
  it("uses the target the API reports for the model", () => {
    expect(servedExecutionTarget(model({ hostedExecutionTarget: "local" }))).toBe("local");
    expect(servedExecutionTarget(model({ hostedExecutionTarget: "browser-local" }))).toBe(
      "browser-local"
    );
  });

  it("falls back to the local Ollama target, never the retired hosted runtime", () => {
    expect(servedExecutionTarget(model())).toBe("local");
    expect(servedExecutionTarget(undefined)).toBe("local");
  });

  it("classifies server-run targets, including legacy hosted bindings", () => {
    expect(isServerExecutionTarget("local")).toBe(true);
    expect(isServerExecutionTarget("backend")).toBe(true);
    expect(isServerExecutionTarget("vercel")).toBe(true);
    expect(isServerExecutionTarget("browser-local")).toBe(false);
    expect(isServerExecutionTarget("installed-app")).toBe(false);
    expect(isServerExecutionTarget("remote-shop-device")).toBe(false);
  });

  it("accepts the local platform default as a saved agent model", () => {
    // Regression: the panel only syncs the agent profile when isAgentModel accepts the effective
    // model, and the local default smollm2-360m was missing from the list.
    expect(isAgentModel("smollm2-360m")).toBe(true);
    expect(isAgentModel("openai-fast")).toBe(true);
    expect(isAgentModel("not a model")).toBe(false);
  });
});
