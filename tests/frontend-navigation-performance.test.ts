import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearApiRequestCache,
  getCachedJson,
  invalidateApiCacheForMutation,
  subscribeToApiMutations
} from "../apps/web/src/api-request-cache";
import { catalogueRepository, clearAllLocalData } from "../apps/web/src/local-data-repository";
import { likelyNextOwnerViews } from "../apps/web/src/prefetch";

afterEach(async () => {
  clearApiRequestCache();
  await clearAllLocalData();
  vi.unstubAllGlobals();
});

describe("frontend navigation performance contracts", () => {
  it("deduplicates concurrent reads and reuses stable cached data", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ models: ["small"] }), {
          headers: { "content-type": "application/json" },
          status: 200
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const [first, second] = await Promise.all([
      getCachedJson<{ models: string[] }>("/v1/ai-models"),
      getCachedJson<{ models: string[] }>("/v1/ai-models")
    ]);
    const third = await getCachedJson<{ models: string[] }>("/v1/ai-models");

    expect(first).toEqual({ models: ["small"] });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps navigation, model discovery, and runtime initialization decoupled", () => {
    const navigationState = readFileSync("apps/web/src/hooks/useNavigationState.ts", "utf8");
    const agentModelPanel = readFileSync("apps/web/src/AgentModelPanel.tsx", "utf8");
    const navigationBlock = sourceFunction(navigationState, "navigateToView");
    const settingsEffectStart = agentModelPanel.indexOf(
      "setInferencePreferences(readClientInferencePreferences(accountId, business.id));"
    );
    const settingsMountEffect = agentModelPanel.slice(
      settingsEffectStart,
      agentModelPanel.indexOf("}, [accountId, business.id]);", settingsEffectStart)
    );

    expect(navigationBlock).toContain("navigateToOwnerRoute");
    expect(navigationBlock).not.toContain("window.history.pushState");
    expect(navigationBlock).not.toContain("window.location.assign");
    expect(navigationBlock).not.toContain("window.location.reload");
    expect(navigationBlock).not.toContain("ensureRuntimeSession");
    expect(settingsMountEffect).not.toContain("loadAiModels(");
    expect(settingsMountEffect).not.toContain("inspectDeviceModelCapability(");
    expect(settingsMountEffect).not.toContain("loadBrowserInferenceState(");
    expect(agentModelPanel).toContain('setProfileMessage("Opening model settings…")');
  });

  it("does not precache model files and enables route/API performance measurements", () => {
    const serviceWorker = readFileSync("apps/web/public/sw.js", "utf8");
    const performanceSource = readFileSync("apps/web/src/performance.ts", "utf8");

    expect(serviceWorker).not.toMatch(/APP_SHELL[\s\S]*\.gguf/i);
    expect(performanceSource).toContain("[GROGONI_PERF]");
    expect(performanceSource).toContain("performance.mark");
    expect(performanceSource).toContain("performance.measure");
    expect(performanceSource).toContain('"longtask"');
  });

  it("boots directly without a second entrypoint request waterfall", () => {
    const html = readFileSync("apps/web/index.html", "utf8");
    const budgetCheck = readFileSync("scripts/check-web-bundle-budgets.mjs", "utf8");

    expect(html).toContain('src="/src/main.tsx"');
    expect(html).not.toContain('src="/src/bootstrap.ts"');
    expect(budgetCheck).not.toContain("bootstrapImport");
  });

  it("batches streamed model tokens to animation frames", () => {
    const chatState = readFileSync("apps/web/src/hooks/useChatRuntimeState.ts", "utf8");
    const start = chatState.indexOf("const updateStreamingMessage");
    const end = chatState.indexOf("async function runRoutedRuntimeTurn", start);
    const streamingBlock = chatState.slice(start, end);

    expect(streamingBlock).toContain("window.requestAnimationFrame");
    expect(streamingBlock).toContain("if (streamingFrame !== null) return");
    expect(streamingBlock).not.toContain(
      "browserTokenListener = (token) => {\n        setStatusMessage"
    );
  });

  it("warms likely follow-up modules while keeping the conversation mounted", () => {
    const chatSurface = readFileSync("apps/web/src/ChatSurface.tsx", "utf8");

    expect(likelyNextOwnerViews("chat")).toEqual(["products", "invoices"]);
    expect(likelyNextOwnerViews("invoices")).toEqual(["payments", "logistics"]);
    expect(chatSurface).toContain("const showMessageThread = true;");
    expect(chatSurface).toContain("const visibleConversations = showMessageThread");
    expect(chatSurface).toContain("showMessageThread && isInboxOpen");
    expect(chatSurface).toContain('behavior: "auto"');
  });

  it("invalidates related active-model reads after either model selection changes", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL) =>
        new Response(
          JSON.stringify({
            path: typeof input === "string" ? input : input.toString(),
            request: fetchMock.mock.calls.length
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200
          }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    await getCachedJson("/businesses/business-1/agent-model?deviceId=device-1");
    await getCachedJson("/businesses/business-1/ai-model");
    await getCachedJson("/businesses/business-1/agent-profile");
    invalidateApiCacheForMutation("/businesses/business-1/agent-model?deviceId=device-1");
    await getCachedJson("/businesses/business-1/agent-model?deviceId=device-1");
    await getCachedJson("/businesses/business-1/ai-model");
    await getCachedJson("/businesses/business-1/agent-profile");

    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("clears persistent business data and notifies mounted surfaces after a mutation", async () => {
    const productsPath = "/businesses/business-1/products";
    const repository = catalogueRepository<string[]>("business:business-1");
    const listener = vi.fn();
    const unsubscribe = subscribeToApiMutations(listener);
    await repository.writeCached(productsPath, ["Old product"]);

    await invalidateApiCacheForMutation(`${productsPath}/product-1?source=editor`);

    expect(await repository.readCached(productsPath)).toMatchObject({
      status: "empty",
      value: null
    });
    expect(listener).toHaveBeenCalledWith(`${productsPath}/product-1`);

    unsubscribe();
  });
});

function sourceFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf("\n  function ", start + 1);
  return source.slice(start, end);
}
