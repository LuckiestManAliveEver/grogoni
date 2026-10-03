// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InferenceProviderConnectionSummary,
  InferenceProviderSummary
} from "@grogoni/shared-types";

const fetchFreshJson = vi.fn();
const postJson = vi.fn();
const deleteJson = vi.fn();

vi.mock("../apps/web/src/api-helpers", () => ({
  fetchFreshJson: (...args: unknown[]) => fetchFreshJson(...args),
  postJson: (...args: unknown[]) => postJson(...args),
  deleteJson: (...args: unknown[]) => deleteJson(...args)
}));

const { AiProvidersPanel } = await import("../apps/web/src/AiProvidersPanel");
const { providerCardState, maskedKey } = await import("../apps/web/src/ai-providers-view");
const { normalizeLocalInferenceReply } =
  await import("../apps/web/src/inference/local-inference-response");

function provider(overrides: Partial<InferenceProviderSummary>): InferenceProviderSummary {
  return {
    id: "openai",
    displayName: "OpenAI",
    type: "openai",
    executionTarget: "remote-inference",
    enabled: true,
    managedCredentialConfigured: false,
    byokAllowed: true,
    allowCredentialEndpoint: false,
    billingProduct: "openai-api",
    ...overrides
  };
}

function connection(
  overrides: Partial<InferenceProviderConnectionSummary> = {}
): InferenceProviderConnectionSummary {
  return {
    id: "conn-1",
    providerId: "openai",
    scope: "tenant",
    businessId: "shop-1",
    connected: true,
    status: "ACTIVE",
    secretHint: "x7K2",
    customEndpoint: null,
    lastVerifiedAt: null,
    lastVerificationStatus: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides
  };
}

const providers = [
  provider({}),
  provider({ id: "anthropic", displayName: "Anthropic", type: "anthropic" }),
  provider({
    id: "zai-general",
    displayName: "Z.ai",
    type: "zai",
    managedCredentialConfigured: true
  }),
  provider({
    id: "grogoni-llama",
    displayName: "Grogoni Cloud",
    type: "openai-compatible",
    byokAllowed: false,
    managedCredentialConfigured: true
  }),
  provider({
    id: "local",
    displayName: "Local AI (this device)",
    type: "local",
    executionTarget: "browser-local",
    byokAllowed: false
  })
];

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
    input,
    value
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(host: HTMLElement, label: string, withinProvider?: string): HTMLButtonElement {
  const scope =
    withinProvider === undefined
      ? host
      : (Array.from(host.querySelectorAll("article")).find((article) =>
          article.textContent?.startsWith(withinProvider)
        ) as HTMLElement);
  return Array.from(scope.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label
  )!;
}

describe("AI providers settings view rules", () => {
  it("derives provider status from backend summaries with server-side precedence", () => {
    const base = { businessId: "shop-1", deviceLocalAvailable: false };
    expect(providerCardState({ ...base, provider: providers[0]!, connections: [] }).status).toBe(
      "Not connected"
    );
    expect(providerCardState({ ...base, provider: providers[2]!, connections: [] }).status).toBe(
      "Available"
    );
    expect(providerCardState({ ...base, provider: providers[3]!, connections: [] })).toMatchObject({
      status: "Available",
      canConnect: false
    });
    expect(providerCardState({ ...base, provider: providers[4]!, connections: [] }).status).toBe(
      "Not available on this device"
    );
    expect(
      providerCardState({
        ...base,
        deviceLocalAvailable: true,
        provider: providers[4]!,
        connections: []
      }).status
    ).toBe("Available on this device");
    const both = [
      connection({ id: "user-key", scope: "user", businessId: null }),
      connection({ id: "shop-key" })
    ];
    expect(
      providerCardState({ ...base, provider: providers[0]!, connections: both }).connection?.id
    ).toBe("shop-key");
    expect(
      providerCardState({
        ...base,
        provider: providers[0]!,
        connections: [connection({ status: "INVALID" })]
      }).status
    ).toBe("Key rejected");
    expect(maskedKey("x7K2")).toBe("••••••••••••••••x7K2");
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
    postJson.mockReset();
    deleteJson.mockReset();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  function respond(connections: InferenceProviderConnectionSummary[]) {
    fetchFreshJson.mockImplementation(async (path: string) =>
      path === "/v1/ai/providers" ? { providers } : { connections }
    );
  }

  it("lists every configured provider and shows only the masked key hint", async () => {
    respond([connection()]);
    const root = createRoot(host);
    await act(async () => root.render(<AiProvidersPanel businessId="shop-1" />));

    expect(fetchFreshJson).toHaveBeenCalledWith("/v1/ai/provider-connections?businessId=shop-1");
    const cards = Array.from(host.querySelectorAll("article")).map(
      (article) => article.querySelector("strong")?.textContent
    );
    expect(cards).toEqual([
      "Connected",
      "Not connected",
      "Available",
      "Available",
      expect.stringContaining("device")
    ]);
    expect(host.textContent).toContain("••••••••••••••••x7K2");
    expect(host.querySelector("input[type='password']")).toBeNull();
    expect(button(host, "Replace", "OpenAI")).toBeDefined();
    expect(button(host, "Test", "OpenAI")).toBeDefined();
    expect(button(host, "Disconnect", "OpenAI")).toBeDefined();

    await act(async () => root.unmount());
  });

  it("connects a key for the shop, then forgets the typed key", async () => {
    respond([]);
    postJson.mockResolvedValue(connection({ providerId: "anthropic" }));
    const root = createRoot(host);
    await act(async () => root.render(<AiProvidersPanel businessId="shop-1" />));

    await act(async () => button(host, "Connect", "Anthropic").click());
    const input = host.querySelector("input[type='password']") as HTMLInputElement;
    expect(input.getAttribute("autocomplete")).toBe("off");
    await act(async () => setInputValue(input, "sk-ant-typed-key-0000000000"));
    respond([connection({ providerId: "anthropic" })]);
    await act(async () => button(host, "Save key").click());

    expect(postJson).toHaveBeenCalledWith("/v1/ai/provider-connections", {
      providerId: "anthropic",
      apiKey: "sk-ant-typed-key-0000000000",
      scope: "tenant",
      businessId: "shop-1"
    });
    expect(host.textContent).not.toContain("sk-ant-typed-key");
    expect(host.querySelector("input[type='password']")).toBeNull();
    expect(host.textContent).toContain("Anthropic connected.");

    await act(async () => root.unmount());
  });

  it("tests and disconnects by connection id", async () => {
    respond([connection()]);
    postJson.mockResolvedValue({
      connection: connection(),
      health: {
        status: "AVAILABLE",
        checkedAt: "now",
        latencyMs: 20,
        errorCode: null,
        message: null
      }
    });
    deleteJson.mockResolvedValue({ disconnected: true, id: "conn-1" });
    const root = createRoot(host);
    await act(async () => root.render(<AiProvidersPanel businessId="shop-1" />));

    await act(async () => button(host, "Test", "OpenAI").click());
    expect(postJson).toHaveBeenCalledWith("/v1/ai/provider-connections/conn-1/test", {});
    expect(host.textContent).toContain("OpenAI key works.");

    respond([]);
    await act(async () => button(host, "Disconnect", "OpenAI").click());
    expect(deleteJson).toHaveBeenCalledWith("/v1/ai/provider-connections/conn-1");
    expect(host.textContent).toContain("Its key was deleted.");

    await act(async () => root.unmount());
  });
});
