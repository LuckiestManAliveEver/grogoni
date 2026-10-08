// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InferenceProviderSummary } from "@grogoni/shared-types";

const fetchFreshJson = vi.fn();
const putJson = vi.fn();

vi.mock("../apps/web/src/api-helpers", () => ({
  fetchFreshJson: (...args: unknown[]) => fetchFreshJson(...args),
  putJson: (...args: unknown[]) => putJson(...args)
}));

const { AiProvidersPanel } = await import("../apps/web/src/AiProvidersPanel");
const { providerCardState } = await import("../apps/web/src/ai-providers-view");
const { normalizeLocalInferenceReply } =
  await import("../apps/web/src/inference/local-inference-response");

function provider(overrides: Partial<InferenceProviderSummary> = {}): InferenceProviderSummary {
  return {
    id: "local",
    displayName: "Local AI (this device)",
    type: "local",
    executionTarget: "browser-local",
    enabled: true,
    ...overrides
  };
}

describe("AI providers settings view rules", () => {
  it("reports device-local availability and disabled providers", () => {
    expect(providerCardState({ provider: provider(), deviceLocalAvailable: false }).status).toBe(
      "Not available on this device"
    );
    expect(providerCardState({ provider: provider(), deviceLocalAvailable: true }).status).toBe(
      "Available on this device"
    );
    expect(
      providerCardState({ provider: provider({ enabled: false }), deviceLocalAvailable: true })
    ).toEqual({ status: "Unavailable", detail: "Turned off for this deployment." });
  });

  it("normalizes an on-device reply into the canonical response shape", () => {
    expect(
      normalizeLocalInferenceReply({
        requestId: "r1",
        totalMs: 812.4,
        reply: {
          reply: "Habari",
          modelId: "smollm2",
          modelVersion: "1",
          engine: "webllm",
          answeredOffline: true
        }
      })
    ).toEqual({
      requestId: "r1",
      providerId: "local",
      modelId: "smollm2",
      output: { text: "Habari", toolCalls: [] },
      finishReason: "stop",
      latency: { totalMs: 812 },
      executionTarget: "browser-local"
    });
  });
});

describe("AiProvidersPanel", () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    fetchFreshJson.mockReset();
    putJson.mockReset();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("lists the configured providers read-only, with no key connection", async () => {
    fetchFreshJson.mockImplementation(async (path: string) =>
      path === "/v1/ai/providers" ? { providers: [provider()] } : { models: [] }
    );
    const root = createRoot(host);
    await act(async () => root.render(<AiProvidersPanel businessId="shop-1" />));

    expect(fetchFreshJson).toHaveBeenCalledWith("/v1/ai/providers");
    expect(fetchFreshJson).not.toHaveBeenCalledWith(
      expect.stringContaining("/v1/ai/provider-connections")
    );
    const article = host.querySelector("article.ai-provider-card");
    expect(article?.textContent).toContain("Local AI (this device)");
    expect(article?.textContent).toContain("Nothing is sent to a cloud provider.");
    expect(host.querySelector("input[type='password']")).toBeNull();
    for (const label of ["Connect", "Replace", "Test", "Disconnect", "Save key"]) {
      expect(
        Array.from(host.querySelectorAll("button")).some((button) => button.textContent === label)
      ).toBe(false);
    }

    await act(async () => root.unmount());
  });

  it("shows the load error instead of an empty list", async () => {
    fetchFreshJson.mockRejectedValue(new Error("Providers could not be loaded."));
    const root = createRoot(host);
    await act(async () => root.render(<AiProvidersPanel businessId="shop-1" />));

    expect(host.textContent).toContain("Providers could not be loaded.");
    expect(host.querySelector("article.ai-provider-card")).toBeNull();

    await act(async () => root.unmount());
  });
});
