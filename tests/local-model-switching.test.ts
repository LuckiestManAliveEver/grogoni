import { describe, expect, it, vi } from "vitest";

import type { AgentModelActivationResult, AiModelSummary } from "../packages/shared-types/src";
import { isPlatformIncludedModel } from "../packages/shared-types/src";
import { buildApi } from "../services/api/src/app";
import { createPostgresCp2Store } from "../services/api/src/cp2/postgres-store";
import { createLocalDefaultCp2Store as createCp2Store } from "./fixtures/local-default-store";
import {
  createOllamaInferenceClient,
  createOllamaModelAdapter,
  type ModelRuntimeAdapter
} from "../services/api/src/inference/model-runtime";
import {
  createLocalModelAdapterResolver,
  createOllamaModelCatalog,
  ollamaCatalogModelId
} from "../services/api/src/inference/ollama-model-catalog";
import { ollamaFetch } from "./fixtures/ollama-fakes";

// Switching models is picking one from the model tab: every model installed in local Ollama is
// listed, activates without a cost step, and serves the next chat. These tests wire the catalog and
// adapter resolver exactly as services/api/src/index.ts does, against a fake Ollama.

const defaultTag = "smollm2:360m";

function ollamaClient(model: string, request: ReturnType<typeof ollamaFetch>) {
  return createOllamaInferenceClient({
    baseUrl: "http://127.0.0.1:11434",
    model,
    timeoutMs: 1_000,
    request: request as unknown as typeof fetch
  });
}

async function localModelApi(installed: string[]) {
  const ollama = ollamaFetch({
    installed,
    chunks: ['{"type":"response","message":"Habari! Nitakusaidia."}']
  });
  const catalog = createOllamaModelCatalog({
    client: ollamaClient(defaultTag, ollama),
    excludeTags: [defaultTag]
  });
  await catalog.refresh();
  const registered = new Map<string, ModelRuntimeAdapter>([
    [
      "local:smollm2-360m",
      createOllamaModelAdapter({
        modelId: "smollm2-360m",
        ollamaModel: defaultTag,
        client: ollamaClient(defaultTag, ollama)
      })
    ]
  ]);
  const store = createCp2Store({
    localModelCatalog: catalog,
    modelRuntimeAdapterResolver: createLocalModelAdapterResolver({
      registered,
      catalog,
      createAdapter: ({ modelId, ollamaTag }) =>
        createOllamaModelAdapter({
          modelId,
          ollamaModel: ollamaTag,
          client: ollamaClient(ollamaTag, ollama)
        })
    })
  });
  return { app: buildApi({ cp2: { store } }), ollama, catalog };
}

async function owner(app: ReturnType<typeof buildApi>) {
  const contact = `+2547${String(Date.now()).slice(-8)}`;
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ method: "phone", contact, pin: "1234" })
  });
  expect(signup.statusCode, signup.body).toBe(200);
  const setCookie = signup.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0] as string;
  const business = await app.inject({
    method: "POST",
    url: "/businesses",
    headers: { "content-type": "application/json", cookie },
    payload: JSON.stringify({ name: "Switching Shop", language: "en" })
  });
  expect(business.statusCode, business.body).toBe(200);
  return { cookie, businessId: business.json<{ business: { id: string } }>().business.id };
}

describe("local Ollama model catalog", () => {
  it("turns installed tags into portable ids and leaves out the configured default", async () => {
    const catalog = createOllamaModelCatalog({
      client: ollamaClient(
        defaultTag,
        ollamaFetch({ installed: ["qwen2.5:3b", defaultTag, "llama3.2:3b"] })
      ),
      excludeTags: [defaultTag]
    });
    await expect(catalog.refresh()).resolves.toEqual({ ok: true, count: 2 });
    expect(catalog.list().map((model) => model.id)).toEqual([
      "ollama-llama3.2-3b",
      "ollama-qwen2.5-3b"
    ]);
    expect(catalog.list()[1]).toMatchObject({
      label: "qwen2.5:3b (local)",
      provider: "ollama",
      canonicalModelId: "qwen2.5:3b",
      available: true
    });
    expect(catalog.ollamaTagFor("ollama-qwen2.5-3b")).toBe("qwen2.5:3b");
    expect(catalog.ollamaTagFor(ollamaCatalogModelId(defaultTag))).toBeUndefined();
    expect(isPlatformIncludedModel(catalog.list()[0]!)).toBe(true);
  });

  it("keeps the last good list when Ollama stops answering", async () => {
    let up = true;
    const request = vi.fn(async (input: URL | RequestInfo) => {
      if (!up) throw new TypeError("connect ECONNREFUSED");
      return ollamaFetch({ installed: ["qwen2.5:3b"] })(input);
    });
    const logs: string[] = [];
    const catalog = createOllamaModelCatalog({
      client: ollamaClient(defaultTag, request as unknown as ReturnType<typeof ollamaFetch>),
      log: (event) => logs.push(event)
    });
    await catalog.refresh();
    up = false;
    await expect(catalog.refresh()).resolves.toEqual({ ok: false, count: 1 });
    expect(catalog.list().map((model) => model.id)).toEqual(["ollama-qwen2.5-3b"]);
    expect(logs).toEqual(["inference.ollama_catalog_refresh_failed"]);
  });
});

describe("switching models from the model tab", () => {
  it("lists installed models, activates one without a cost step, and chats on it", async () => {
    const { app, ollama } = await localModelApi([defaultTag, "qwen2.5:3b"]);
    try {
      const shop = await owner(app);
      const listed = await app.inject({
        method: "GET",
        url: "/v1/ai-models",
        headers: { cookie: shop.cookie }
      });
      const models = listed.json<{ models: AiModelSummary[] }>().models;
      expect(models.find((model) => model.id === "ollama-qwen2.5-3b")).toMatchObject({
        provider: "ollama",
        costResponsibility: "platform-included",
        hostedExecutionTarget: "local",
        runtimeAvailability: { backend: "configured" }
      });
      expect(models.some((model) => model.id === "ollama-smollm2-360m")).toBe(false);

      // Exactly what the model tab sends for an included model: no costResponsibility.
      const activation = await app.inject({
        method: "POST",
        url: `/api/agents/${shop.businessId}/models/ollama-qwen2.5-3b/activate`,
        headers: { "content-type": "application/json", cookie: shop.cookie },
        payload: JSON.stringify({
          shopId: shop.businessId,
          executionTarget: "local",
          executionMode: "LOCAL_FIRST",
          permissions: { allowRemoteShopDevice: false }
        })
      });
      expect(activation.statusCode, activation.body).toBe(200);
      expect(activation.json<AgentModelActivationResult>().binding).toMatchObject({
        modelId: "ollama-qwen2.5-3b",
        executionTarget: "local",
        status: "active"
      });

      ollama.mockClear();
      const turn = await app.inject({
        method: "POST",
        url: `/businesses/${shop.businessId}/runtime/turns`,
        headers: { "content-type": "application/json", cookie: shop.cookie },
        payload: JSON.stringify({ message: "Habari, una sukari?" })
      });
      expect(turn.statusCode, turn.body).toBe(200);
      expect(turn.json()).toMatchObject({
        turn: { response: "Habari! Nitakusaidia.", model: { modelId: "ollama-qwen2.5-3b" } }
      });
      const chat = ollama.mock.calls.find(([url]) => String(url).endsWith("/api/chat"));
      expect(JSON.parse(String(chat?.[1]?.body)).model).toBe("qwen2.5:3b");
    } finally {
      await app.close();
    }
  });

  it("refuses a model that is not installed in Ollama", async () => {
    const { app } = await localModelApi([defaultTag]);
    try {
      const shop = await owner(app);
      const activation = await app.inject({
        method: "POST",
        url: `/api/agents/${shop.businessId}/models/ollama-llama3.2-3b/activate`,
        headers: { "content-type": "application/json", cookie: shop.cookie },
        payload: JSON.stringify({
          shopId: shop.businessId,
          executionTarget: "local",
          executionMode: "LOCAL_FIRST",
          permissions: { allowRemoteShopDevice: false }
        })
      });
      expect(activation.statusCode).toBe(404);
      expect(activation.json()).toMatchObject({ code: "MODEL_NOT_FOUND" });
    } finally {
      await app.close();
    }
  });
});

const databaseUrl = process.env.CP2_POSTGRES_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

describePostgres("Postgres-backed API store", () => {
  it("receives every injected option, including the local model catalog and platform default", async () => {
    // Regression: createPostgresCp2Store forwarded a hand-picked subset of options and silently
    // dropped the local model catalog (and the configured default, channel gateway, mailbox client
    // and workspace settings), so the real API listed no local models.
    const catalog = createOllamaModelCatalog({
      client: ollamaClient(defaultTag, ollamaFetch({ installed: ["qwen2.5:3b"] })),
      excludeTags: [defaultTag]
    });
    await catalog.refresh();
    const store = await createPostgresCp2Store({
      databaseUrl: databaseUrl as string,
      localModelCatalog: catalog,
      platformDefaultRuntime: {
        agentId: "builtin:shopkeeper:v1",
        agentName: "Shopkeeper",
        agentRuntimeAdapterId: "grogoni",
        modelId: "ollama-qwen2.5-3b",
        executionTarget: "local"
      }
    });
    try {
      expect(store.listModelCatalog().map((model) => model.id)).toContain("ollama-qwen2.5-3b");
      expect(store.snapshot().nativeRuntimeAgents.map((agent) => agent.id)).toContain(
        "builtin:shopkeeper:v1"
      );
    } finally {
      await store.close();
    }
  });
});
