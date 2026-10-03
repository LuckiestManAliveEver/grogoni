// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QuickRuntimeSwitcher } from "../apps/web/src/QuickRuntimeSwitcher";
import { clearApiRequestCache } from "../apps/web/src/api-request-cache";
import type { ActiveBusiness, AgentSettings } from "../apps/web/src/grogoni-application-shared";

describe("quick runtime switcher", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    // /v1/ai-models and /v1/platform/agent-catalog are shop-independent paths cached in a
    // module-level Map (api-request-cache.ts) that otherwise persists across tests in this file,
    // serving an earlier test's stubbed model list to a later test that stubbed a different one.
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
      model: "gpt-6-luna",
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

  // fetch's first argument may be an absolute URL (with an app-configured origin) rather than the
  // bare path, so callers must check for the path as a suffix/substring, not exact equality.
  function calledWithPath(fetchMock: ReturnType<typeof vi.fn>, path: string): boolean {
    return fetchMock.mock.calls.some((call) => {
      const input = call[0] as string | URL | Request;
      const url = typeof input === "string" ? input : input.toString();
      return new URL(url, "http://localhost").pathname === path;
    });
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

  it("loads the registered agent definitions and hosted models, and shows the shop's current selection", async () => {
    stubFetch({
      "/v1/platform/agent-catalog": () =>
        jsonResponse({
          agents: [
            {
              id: "builtin:shopkeeper",
              displayName: "Shopkeeper",
              description: "The default agent."
            },
            {
              id: "builtin:pi-assistant",
              displayName: "Shopkeeper (Pi engine)",
              description: "Same behavior, running on Pi."
            }
          ]
        }),
      "/businesses/agent-shop/runtime/effective": () =>
        jsonResponse({
          agent: {
            id: "builtin:pi-assistant",
            name: "Shopkeeper (Pi engine)",
            runtimeAdapterId: "pi"
          },
          model: { id: "gpt-6-luna", name: "GPT-6 Luna" },
          execution: { type: "backend", hostId: "host-1", ready: true },
          binding: { id: "binding-1" },
          source: "default",
          status: "READY",
          ready: true
        }),
      "/v1/ai-models": () =>
        jsonResponse({
          models: [
            {
              id: "gpt-6-luna",
              label: "GPT-6 Luna",
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
              runtimeAvailability: { backend: "configured" }
            },
            {
              id: "qwen2.5-0.5b-android",
              label: "Qwen2.5 0.5B",
              provider: "local",
              description: "",
              capabilities: [],
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
              recommended: false
              // No runtimeAvailability.backend - a device-download model, must not appear here.
            }
          ]
        })
    });

    await act(async () => {
      root = createRoot(host);
      root.render(
        <QuickRuntimeSwitcher
          business={business("agent-shop")}
          agent={agent()}
          updateAgent={vi.fn()}
          onAgentChange={vi.fn()}
        />
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const agentSelect = host.querySelector<HTMLSelectElement>("select");
    expect(agentSelect?.value).toBe("builtin:pi-assistant");
    const selects = host.querySelectorAll<HTMLSelectElement>("select");
    const modelSelect = selects[1] as HTMLSelectElement;
    expect(modelSelect.value).toBe("gpt-6-luna");
    const modelOptionValues = [...modelSelect.options].map((option) => option.value);
    expect(modelOptionValues).toEqual(["gpt-6-luna"]);
  });

  it("activates an agent-definition change immediately and reports the new selection", async () => {
    const profileUpdateBodies: unknown[] = [];
    stubFetch({
      "/v1/platform/agent-catalog": () =>
        jsonResponse({
          agents: [
            { id: "builtin:shopkeeper", displayName: "Shopkeeper", description: "" },
            { id: "builtin:pi-assistant", displayName: "Shopkeeper (Pi engine)", description: "" }
          ]
        }),
      "/businesses/agent-shop-2/runtime/effective": () =>
        jsonResponse({
          agent: { id: "builtin:shopkeeper", name: "Shopkeeper", runtimeAdapterId: "grogoni" },
          model: { id: "gpt-6-luna", name: "GPT-6 Luna" },
          execution: { type: "backend", hostId: "host-1", ready: true },
          binding: { id: "binding-1" },
          source: "default",
          status: "READY",
          ready: true
        }),
      "/v1/ai-models": () =>
        jsonResponse({
          models: [
            {
              id: "gpt-6-luna",
              label: "GPT-6 Luna",
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
              runtimeAvailability: { backend: "configured" }
            }
          ]
        })
    });

    const updateAgent = vi.fn();
    const onAgentChange = vi.fn();
    await act(async () => {
      root = createRoot(host);
      root.render(
        <QuickRuntimeSwitcher
          business={business("agent-shop-2")}
          agent={agent()}
          updateAgent={updateAgent}
          onAgentChange={onAgentChange}
        />
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const fetchMock = stubFetch({
      "/businesses/agent-shop-2/agent-profile": (init) => {
        profileUpdateBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({
          agentDefinitionId: "builtin:pi-assistant",
          name: "Shopkeeper",
          description: "",
          modelId: "gpt-6-luna",
          role: "General shopkeeper",
          language: "en",
          personality: "Warm",
          instructions: "Handle one task at a time.",
          knowledge: "Use saved records.",
          tools: [],
          integrations: [],
          contextScripts: [],
          runtimeVersion: 2
        });
      }
    });

    const agentSelect = host.querySelector<HTMLSelectElement>("select") as HTMLSelectElement;
    await act(async () => {
      agentSelect.value = "builtin:pi-assistant";
      agentSelect.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(profileUpdateBodies[0]).toMatchObject({
      agentDefinitionId: "builtin:pi-assistant"
    });
    expect(updateAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentDefinitionId: "builtin:pi-assistant" })
    );
    expect(host.textContent).toContain("Shopkeeper (Pi engine)");
  });

  // Each caller must pass its own unique shop id: apps/web/src/api-request-cache.ts caches GET
  // responses in a module-level Map keyed by path, which persists across tests in this same file -
  // reusing a shop id across tests would silently serve a previous test's cached runtime/effective
  // or ai-models response instead of calling the stubbed fetch again.
  function merchantFundedModelsFixture(shopId: string) {
    return {
      "/v1/platform/agent-catalog": () =>
        jsonResponse({
          agents: [{ id: "builtin:shopkeeper", displayName: "Shopkeeper", description: "" }]
        }),
      [`/businesses/${shopId}/runtime/effective`]: () =>
        jsonResponse({
          agent: { id: "builtin:shopkeeper", name: "Shopkeeper", runtimeAdapterId: "grogoni" },
          model: { id: "gpt-6-luna", name: "GPT-6 Luna" },
          execution: { type: "backend", hostId: "host-1", ready: true },
          binding: { id: "binding-1" },
          source: "default",
          status: "READY",
          ready: true
        }),
      "/v1/ai-models": () =>
        jsonResponse({
          models: [
            {
              id: "gpt-6-luna",
              label: "GPT-6 Luna",
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
              runtimeAvailability: { backend: "configured" }
            },
            {
              id: "qwen3-4b",
              label: "Qwen3-4B",
              provider: "huggingface",
              description: "",
              capabilities: ["chat", "reasoning"],
              available: true,
              source: "hosted",
              format: "remote",
              license: "Apache-2.0",
              licenseUrl: null,
              modelCardUrl: null,
              downloadUrl: null,
              fileName: null,
              fileSizeBytes: null,
              minimumMemoryGb: null,
              recommended: true,
              runtimeAvailability: { backend: "configured" }
            }
          ]
        })
    };
  }

  it("asks for confirmation before switching to a merchant-funded model, and does not call activate until confirmed", async () => {
    const shopId = "agent-shop-confirm";
    const fetchMock = stubFetch({
      ...merchantFundedModelsFixture(shopId),
      [`/api/agents/${shopId}/models/qwen3-4b/activate`]: () =>
        jsonResponse({
          status: "active",
          binding: { id: "binding-1", agentId: shopId, modelId: "qwen3-4b" },
          healthCheck: { latencyMs: 5 }
        })
    });
    const updateAgent = vi.fn();
    await act(async () => {
      root = createRoot(host);
      root.render(
        <QuickRuntimeSwitcher
          business={business(shopId)}
          agent={agent()}
          updateAgent={updateAgent}
          onAgentChange={vi.fn()}
        />
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const modelSelect = host.querySelectorAll<HTMLSelectElement>("select")[1] as HTMLSelectElement;
    await act(async () => {
      modelSelect.value = "qwen3-4b";
      modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    // No activation request fired yet, and the dropdown still reflects the active model.
    expect(calledWithPath(fetchMock, `/api/agents/${shopId}/models/qwen3-4b/activate`)).toBe(false);
    expect(modelSelect.value).toBe("gpt-6-luna");
    expect(host.textContent).toContain("merchant-funded");
    expect(updateAgent).not.toHaveBeenCalled();

    const confirmButton = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Confirm switch"
    ) as HTMLButtonElement;
    await act(async () => {
      confirmButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(calledWithPath(fetchMock, `/api/agents/${shopId}/models/qwen3-4b/activate`)).toBe(true);
    expect(updateAgent).toHaveBeenCalledWith(expect.objectContaining({ model: "qwen3-4b" }));
  });

  it("cancelling the confirmation leaves the previous model active and never calls activate", async () => {
    const shopId = "agent-shop-cancel";
    const fetchMock = stubFetch(merchantFundedModelsFixture(shopId));
    await act(async () => {
      root = createRoot(host);
      root.render(
        <QuickRuntimeSwitcher
          business={business(shopId)}
          agent={agent()}
          updateAgent={vi.fn()}
          onAgentChange={vi.fn()}
        />
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const modelSelect = host.querySelectorAll<HTMLSelectElement>("select")[1] as HTMLSelectElement;
    await act(async () => {
      modelSelect.value = "qwen3-4b";
      modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
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
    expect(modelSelect.value).toBe("gpt-6-luna");
    expect(calledWithPath(fetchMock, `/api/agents/${shopId}/models/qwen3-4b/activate`)).toBe(false);
  });

  it("switching back to the platform default never asks for confirmation", async () => {
    const shopId = "agent-shop-default-return";
    const fetchMock = stubFetch({
      ...merchantFundedModelsFixture(shopId),
      [`/businesses/${shopId}/runtime/effective`]: () =>
        jsonResponse({
          agent: { id: "builtin:shopkeeper", name: "Shopkeeper", runtimeAdapterId: "grogoni" },
          model: { id: "qwen3-4b", name: "Qwen3-4B" },
          execution: { type: "backend", hostId: "host-1", ready: true },
          binding: { id: "binding-1" },
          source: "default",
          status: "READY",
          ready: true
        }),
      [`/api/agents/${shopId}/models/gpt-6-luna/activate`]: () =>
        jsonResponse({
          status: "active",
          binding: { id: "binding-1", agentId: shopId, modelId: "gpt-6-luna" },
          healthCheck: { latencyMs: 5 }
        })
    });
    await act(async () => {
      root = createRoot(host);
      root.render(
        <QuickRuntimeSwitcher
          business={business(shopId)}
          agent={agent()}
          updateAgent={vi.fn()}
          onAgentChange={vi.fn()}
        />
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const modelSelect = host.querySelectorAll<HTMLSelectElement>("select")[1] as HTMLSelectElement;
    await act(async () => {
      modelSelect.value = "gpt-6-luna";
      modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(calledWithPath(fetchMock, `/api/agents/${shopId}/models/gpt-6-luna/activate`)).toBe(
      true
    );
  });
});
