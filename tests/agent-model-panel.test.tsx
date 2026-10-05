// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentModelPanel } from "../apps/web/src/AgentModelPanel";
import { clearApiRequestCache } from "../apps/web/src/api-request-cache";
import type {
  ActiveBusiness,
  AgentSettings,
  AiModelSummary
} from "../apps/web/src/grogoni-application-shared";

// AgentModelPanel is the "advanced" counterpart to QuickRuntimeSwitcher.tsx and shares the exact
// same pre-existing gap this feature fixed: it sent costResponsibility: "merchant" to the model
// activation endpoint with no confirmation step at all. These tests cover only that gate - not the
// component's full discovery/search/removal surface, which predates this change and is untested
// elsewhere in the same way.
describe("AgentModelPanel merchant-funded activation confirmation", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    // Shop-independent paths this component also fetches (/v1/ai-models, /v1/ai-models/github,
    // /v1/ai-models/huggingface) are cached module-wide across tests in this file - see the
    // identical note in tests/quick-runtime-switcher.test.tsx.
    clearApiRequestCache();
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  function business(id: string): ActiveBusiness {
    return { id, role: "owner", grogoniId: `grogoni.${id}` } as unknown as ActiveBusiness;
  }

  function agent(): AgentSettings {
    return {
      name: "Shopkeeper",
      model: "smollm2-360m",
      agentDefinitionId: "builtin:shopkeeper",
      contextScripts: []
    } as unknown as AgentSettings;
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    });
  }

  function calledWithPath(fetchMock: ReturnType<typeof vi.fn>, path: string): boolean {
    return fetchMock.mock.calls.some((call) => {
      const input = call[0] as string | URL | Request;
      const url = typeof input === "string" ? input : input.toString();
      return new URL(url, "http://localhost").pathname === path;
    });
  }

  function backendModel(overrides: Partial<AiModelSummary> = {}): AiModelSummary {
    return {
      id: "smollm2-360m",
      label: "SmolLM2 360M",
      provider: "local",
      description: "",
      capabilities: [],
      available: true,
      source: "hosted",
      format: "remote",
      license: null,
      licenseUrl: null,
      modelCardUrl: null,
      downloadUrl: null,
      fileName: null,
      fileSizeBytes: null,
      minimumMemoryGb: null,
      recommended: true,
      contextWindow: 8_192,
      runtimeAvailability: { backend: "configured" },
      ...overrides
    };
  }

  function fixture(shopId: string) {
    const emptyDiscovery = {
      models: [],
      status: "unavailable" as const,
      connection: "public" as const,
      message: "unavailable"
    };
    return {
      [`/api/agents/${shopId}/model-binding`]: () => jsonResponse({ binding: null }),
      [`/businesses/${shopId}/runtime/effective`]: () =>
        jsonResponse({
          agent: { id: "builtin:shopkeeper", name: "Shopkeeper", runtimeAdapterId: "grogoni" },
          model: { id: "smollm2-360m", name: "SmolLM2 360M" },
          execution: { type: "backend", hostId: "host-1", ready: true },
          binding: { id: "binding-1" },
          source: "default",
          status: "READY",
          ready: true
        }),
      "/v1/ai-models": () =>
        jsonResponse({
          models: [
            backendModel(),
            backendModel({
              id: "qwen3-4b",
              label: "Qwen3-4B",
              provider: "huggingface",
              capabilities: ["chat", "reasoning"],
              contextWindow: 32_768
            })
          ]
        }),
      "/v1/ai-models/github": () => jsonResponse(emptyDiscovery),
      "/v1/ai-models/huggingface": () => jsonResponse(emptyDiscovery)
    };
  }

  function stubFetch(
    handlers: Record<string, (init: RequestInit | undefined) => Response>
  ): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = new URL(url, "http://localhost").pathname;
      const handler = handlers[path];
      if (handler === undefined) {
        throw new Error(`Unexpected fetch to ${path}`);
      }
      return handler(init);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  // AgentModelPanel takes aiModels/activeAiModelId as lifted state (owned by its parent in the real
  // app) rather than managing it internally, so the test harness must hold that state itself, the
  // same way the real host component does.
  function Harness({ shopId }: { shopId: string }) {
    const [aiModels, setAiModels] = useState<AiModelSummary[]>([]);
    const [activeAiModelId, setActiveAiModelId] = useState("smollm2-360m");
    const [profileMessage, setProfileMessage] = useState("");
    return (
      <AgentModelPanel
        accountId="account-1"
        business={business(shopId)}
        agent={agent()}
        isEditing={false}
        updateAgent={() => undefined}
        onAgentChange={() => undefined}
        profileMessage={profileMessage}
        setProfileMessage={setProfileMessage}
        pendingProfileAction={null}
        runProfileAction={async (_key, action) => {
          await action();
        }}
        copyStorefrontValue={async () => undefined}
        aiModels={aiModels}
        setAiModels={setAiModels}
        activeAiModelId={activeAiModelId}
        setActiveAiModelId={setActiveAiModelId}
      />
    );
  }

  async function openLibrary() {
    const openButton = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Open model library"
    ) as HTMLButtonElement;
    await act(async () => {
      openButton.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function useWithAgentButtonFor(modelLabel: string): HTMLButtonElement {
    const card = [...host.querySelectorAll("article.ai-model-card")].find((article) =>
      article.textContent?.includes(modelLabel)
    ) as HTMLElement;
    return [...card.querySelectorAll("button")].find(
      (button) => button.textContent === "Use with agent"
    ) as HTMLButtonElement;
  }

  it("asks for confirmation before activating a merchant-funded model, and never calls activate until confirmed", async () => {
    const shopId = "panel-shop-confirm";
    const fetchMock = stubFetch({
      ...fixture(shopId),
      [`/api/agents/${shopId}/models/qwen3-4b/activate`]: () =>
        jsonResponse({
          status: "active",
          binding: {
            id: "binding-1",
            agentId: shopId,
            modelId: "qwen3-4b",
            status: "active",
            executionTarget: "vercel",
            lastVerifiedAt: null
          },
          healthCheck: { latencyMs: 5, executionTarget: "vercel" }
        })
    });

    await act(async () => {
      root = createRoot(host);
      root.render(<Harness shopId={shopId} />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await openLibrary();
    expect(host.textContent).toContain("Qwen3-4B");

    await act(async () => {
      useWithAgentButtonFor("Qwen3-4B").click();
      await Promise.resolve();
    });

    expect(calledWithPath(fetchMock, `/api/agents/${shopId}/models/qwen3-4b/activate`)).toBe(false);
    expect(host.textContent).toContain("merchant-funded");
    expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();

    const confirmButton = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Confirm switch"
    ) as HTMLButtonElement;
    await act(async () => {
      confirmButton.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(calledWithPath(fetchMock, `/api/agents/${shopId}/models/qwen3-4b/activate`)).toBe(true);
  });

  it("cancelling the confirmation never calls activate", async () => {
    const shopId = "panel-shop-cancel";
    const fetchMock = stubFetch(fixture(shopId));

    await act(async () => {
      root = createRoot(host);
      root.render(<Harness shopId={shopId} />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await openLibrary();
    await act(async () => {
      useWithAgentButtonFor("Qwen3-4B").click();
      await Promise.resolve();
    });

    const cancelButton = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Cancel"
    ) as HTMLButtonElement;
    await act(async () => {
      cancelButton.click();
      await Promise.resolve();
    });

    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(calledWithPath(fetchMock, `/api/agents/${shopId}/models/qwen3-4b/activate`)).toBe(false);
  });

  it("activating the platform-included default never asks for confirmation", async () => {
    const shopId = "panel-shop-default";
    const fetchMock = stubFetch({
      ...fixture(shopId),
      [`/api/agents/${shopId}/models/smollm2-360m/activate`]: () =>
        jsonResponse({
          status: "active",
          binding: {
            id: "binding-1",
            agentId: shopId,
            modelId: "smollm2-360m",
            status: "active",
            executionTarget: "vercel",
            lastVerifiedAt: null
          },
          healthCheck: { latencyMs: 5, executionTarget: "vercel" }
        })
    });

    await act(async () => {
      root = createRoot(host);
      root.render(<Harness shopId={shopId} />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await openLibrary();
    await act(async () => {
      useWithAgentButtonFor("SmolLM2 360M").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(calledWithPath(fetchMock, `/api/agents/${shopId}/models/smollm2-360m/activate`)).toBe(
      true
    );
  });

  it("activates on the local Ollama target, never the retired hosted runtime", async () => {
    const shopId = "panel-shop-local-target";
    const activationBodies: unknown[] = [];
    stubFetch({
      ...fixture(shopId),
      [`/api/agents/${shopId}/models/smollm2-360m/activate`]: (init) => {
        activationBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({
          status: "active",
          binding: {
            id: "binding-1",
            agentId: shopId,
            modelId: "smollm2-360m",
            status: "active",
            executionTarget: "local",
            lastVerifiedAt: null
          },
          healthCheck: { latencyMs: 5, executionTarget: "local" }
        });
      }
    });

    await act(async () => {
      root = createRoot(host);
      root.render(<Harness shopId={shopId} />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await openLibrary();
    await act(async () => {
      useWithAgentButtonFor("SmolLM2 360M").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The fixture's catalog entry carries no hostedExecutionTarget (an older API response): the
    // panel must fall back to the API's local-mode default, not the retired "vercel" runtime.
    expect(activationBodies).toEqual([expect.objectContaining({ executionTarget: "local" })]);
  });

  it("treats an active binding on the local target as the agent's current model", async () => {
    const shopId = "panel-shop-local-binding";
    const localBinding = {
      id: "binding-1",
      agentId: shopId,
      modelId: "smollm2-360m",
      status: "active",
      executionTarget: "local",
      lastVerifiedAt: null
    };
    stubFetch({
      ...fixture(shopId),
      [`/api/agents/${shopId}/model-binding`]: () => jsonResponse({ binding: localBinding }),
      [`/businesses/${shopId}/runtime/effective`]: () =>
        jsonResponse({
          agent: { id: "builtin:shopkeeper", name: "Shopkeeper", runtimeAdapterId: "grogoni" },
          model: { id: "smollm2-360m", name: "SmolLM2 360M" },
          execution: { type: "local", hostId: "ollama", ready: true },
          binding: { id: "binding-1" },
          source: "binding",
          status: "READY",
          ready: true
        })
    });

    await act(async () => {
      root = createRoot(host);
      root.render(<Harness shopId={shopId} />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await openLibrary();

    expect(host.textContent).toContain("Running on: Ollama on the machine running Grogoni");
    const card = [...host.querySelectorAll("article.ai-model-card")].find((article) =>
      article.textContent?.includes("SmolLM2 360M")
    );
    expect(card?.textContent).toContain("Local · Active for Shopkeeper");
    expect(host.textContent).not.toContain("Grogoni backend");
  });
});
