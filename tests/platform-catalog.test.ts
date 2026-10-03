import { describe, expect, it } from "vitest";

import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import {
  computeModelAvailability,
  contextCharacterBudgetForModel,
  resolveDefaultDeviceModelId
} from "../services/api/src/cp2/domains/agent-runtime/model-catalog";

describe("DB-hosted platform model/agent catalog", () => {
  it("boots seeded with the exact bootstrap catalog content, even with no database", () => {
    const store = createCp2Store();
    const models = store.listModelCatalog();
    expect(models.map((model) => model.id).sort()).toEqual(
      [
        "smollm2-360m-android",
        "smollm2-360m",
        "tinyllama-1.1b-chat-q3-k-m-android",
        "tinyllama-1.1b-chat-q4-k-m-android",
        "qwen2.5-0.5b-android",
        "qwen2.5-1.5b-android",
        "qwen3-4b",
        "grogoniclaw-local",
        "llama-cpp-configured",
        // Multi-provider router seeds (migration 102): three on-device models and a disabled
        // Grogoni Cloud entry.
        "smollm2-360m-device",
        "qwen2.5-0.5b-device",
        "qwen3-1.7b-device",
        "qwen3-4b-grogoni-cloud",
        // The Grogoni-funded platform default (migration 103).
        "gpt-6-luna"
      ].sort()
    );
    expect(
      store
        .listAgentCatalog()
        .map((agent) => agent.id)
        .sort()
    ).toEqual(["builtin:pi-assistant", "builtin:shopkeeper", "builtin:shopkeeper-grogoni"].sort());
  });

  it("lets an operator disable the hosted profile without bypassing deployment readiness gates", () => {
    // computeModelAvailability is a pure pass-through of the stored flag now that the OpenAI
    // cloud-model special-casing has been removed (docs/architecture/inference-runtime.md) - no
    // catalog entry gets availability computed any other way.
    expect(computeModelAvailability("smollm2-360m", false)).toBe(false);
    expect(computeModelAvailability("smollm2-360m", true)).toBe(true);
  });

  it("uses the effective catalog entry for runtime fallback selection and context budgeting", () => {
    const model = {
      ...modelPayload({ id: "custom-hosted", label: "Custom hosted" }),
      source: "hosted" as const,
      format: "remote" as const,
      contextWindow: 12_000
    };
    expect(resolveDefaultDeviceModelId(model.id, model)).toBe(model.id);
    expect(contextCharacterBudgetForModel(model.id, model)).toBe(12_000);
  });

  it("requires authentication on the platform catalog read endpoints", async () => {
    const app = buildApi({ cp2: { store: createCp2Store() } });
    try {
      for (const url of ["/v1/platform/model-catalog", "/v1/platform/agent-catalog"]) {
        const response = await app.inject({ method: "GET", url });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({ code: "auth_required" });
      }
    } finally {
      await app.close();
    }
  });

  it("rejects catalog writes from an authenticated session with no platform-operator grant", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    try {
      const actor = await createActor(app, "+254700009101");

      const write = await app.inject({
        method: "PUT",
        url: "/v1/platform/model-catalog/qwen2.5-0.5b-android",
        headers: jsonHeaders(actor.cookie),
        payload: JSON.stringify(modelPayload({ id: "qwen2.5-0.5b-android", label: "Hijacked" }))
      });
      expect(write.statusCode).toBe(403);
      expect(write.json()).toMatchObject({ code: "platform_operator_required" });

      const remove = await app.inject({
        method: "DELETE",
        url: "/v1/platform/model-catalog/tinyllama-1.1b-chat-q3-k-m-android",
        headers: { cookie: actor.cookie }
      });
      expect(remove.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("lets a platform operator add a model that every device then sees through the ordinary catalog fetch", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    try {
      const operator = await createActor(app, "+254700009102");
      store.grantPlatformOperator({ accountId: operator.accountId, grantedBy: "test-harness" });

      const created = await app.inject({
        method: "PUT",
        url: "/v1/platform/model-catalog/custom-shop-model",
        headers: jsonHeaders(operator.cookie),
        payload: JSON.stringify(
          modelPayload({ id: "custom-shop-model", label: "Custom Shop Model" })
        )
      });
      expect(created.statusCode).toBe(200);
      expect(created.json()).toMatchObject({ model: { id: "custom-shop-model" } });

      // A second, unrelated device/session - proves the new entry is DB-hosted and reachable
      // through the ordinary client-facing catalog fetch, not just visible to the operator session.
      const otherDevice = await createActor(app, "+254700009103");
      const fetched = await app.inject({
        method: "GET",
        url: "/v1/ai-models",
        headers: { cookie: otherDevice.cookie }
      });
      expect(fetched.statusCode).toBe(200);
      const models = fetched.json<{ models: Array<{ id: string; label: string }> }>().models;
      expect(models.find((model) => model.id === "custom-shop-model")?.label).toBe(
        "Custom Shop Model"
      );
    } finally {
      await app.close();
    }
  });

  it("protects the required runtime-fallback catalog entries from removal even by an operator", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    try {
      const operator = await createActor(app, "+254700009104");
      store.grantPlatformOperator({ accountId: operator.accountId, grantedBy: "test-harness" });

      const removeDefaultModel = await app.inject({
        method: "DELETE",
        url: "/v1/platform/model-catalog/gpt-6-luna",
        headers: { cookie: operator.cookie }
      });
      expect(removeDefaultModel.statusCode).toBe(409);
      expect(removeDefaultModel.json()).toMatchObject({ code: "model_catalog_entry_protected" });

      const removeCompatibilityModel = await app.inject({
        method: "DELETE",
        url: "/v1/platform/model-catalog/grogoniclaw-local",
        headers: { cookie: operator.cookie }
      });
      expect(removeCompatibilityModel.statusCode).toBe(409);

      const removeDefaultAgent = await app.inject({
        method: "DELETE",
        url: "/v1/platform/agent-catalog/builtin:shopkeeper",
        headers: { cookie: operator.cookie }
      });
      expect(removeDefaultAgent.statusCode).toBe(409);
      expect(removeDefaultAgent.json()).toMatchObject({ code: "agent_catalog_entry_protected" });

      // An unprotected model is still genuinely removable.
      const removeOther = await app.inject({
        method: "DELETE",
        url: "/v1/platform/model-catalog/llama-cpp-configured",
        headers: { cookie: operator.cookie }
      });
      expect(removeOther.statusCode).toBe(200);
      expect(store.listModelCatalog().some((model) => model.id === "llama-cpp-configured")).toBe(
        false
      );
    } finally {
      await app.close();
    }
  });

  it("lets a platform operator add a second built-in agent template", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    try {
      const operator = await createActor(app, "+254700009105");
      store.grantPlatformOperator({ accountId: operator.accountId, grantedBy: "test-harness" });

      const created = await app.inject({
        method: "PUT",
        url: "/v1/platform/agent-catalog/builtin:receptionist",
        headers: jsonHeaders(operator.cookie),
        payload: JSON.stringify(agentPayload({ id: "builtin:receptionist" }))
      });
      expect(created.statusCode).toBe(200);
      expect(created.json()).toMatchObject({ agent: { id: "builtin:receptionist" } });

      const listed = await app.inject({
        method: "GET",
        url: "/v1/platform/agent-catalog",
        headers: { cookie: operator.cookie }
      });
      const agents = listed.json<{ agents: Array<{ id: string }> }>().agents;
      expect(agents.map((agent) => agent.id).sort()).toEqual(
        [
          "builtin:pi-assistant",
          "builtin:receptionist",
          "builtin:shopkeeper",
          "builtin:shopkeeper-grogoni"
        ].sort()
      );
    } finally {
      await app.close();
    }
  });

  it("rejects invalid runtime requirements instead of silently normalizing them", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    try {
      const operator = await createActor(app, "+254700009107");
      store.grantPlatformOperator({ accountId: operator.accountId, grantedBy: "test-harness" });

      const invalidModel = await app.inject({
        method: "PUT",
        url: "/v1/platform/model-catalog/custom-shop-model",
        headers: jsonHeaders(operator.cookie),
        payload: JSON.stringify({
          ...modelPayload({ id: "custom-shop-model", label: "Custom" }),
          contextWindow: -1
        })
      });
      expect(invalidModel.statusCode).toBe(400);
      expect(invalidModel.json()).toMatchObject({ code: "model_catalog_entry_invalid" });

      const invalidAgent = await app.inject({
        method: "PUT",
        url: "/v1/platform/agent-catalog/builtin:receptionist",
        headers: jsonHeaders(operator.cookie),
        payload: JSON.stringify({
          ...agentPayload({ id: "builtin:receptionist" }),
          skillIds: ["not-a-runtime-tool"]
        })
      });
      expect(invalidAgent.statusCode).toBe(400);
      expect(invalidAgent.json()).toMatchObject({ code: "agent_catalog_entry_invalid" });
    } finally {
      await app.close();
    }
  });

  it("returns defensive copies so callers cannot bypass catalog write authorization", () => {
    const store = createCp2Store();
    const model = store.listModelCatalog()[0];
    const agent = store.listAgentCatalog()[0];
    expect(model).toBeDefined();
    expect(agent).toBeDefined();

    model!.label = "Mutated outside the store";
    model!.capabilities.push("injected");
    agent!.displayName = "Mutated outside the store";
    agent!.tools.push("Injected");

    expect(store.listModelCatalog()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Mutated outside the store" })])
    );
    expect(store.listModelCatalog().flatMap((entry) => entry.capabilities)).not.toContain(
      "injected"
    );
    expect(store.listAgentCatalog()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ displayName: "Mutated outside the store" })
      ])
    );
    expect(store.listAgentCatalog().flatMap((entry) => entry.tools)).not.toContain("Injected");
  });

  it("revoking platform-operator authority takes effect immediately", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    try {
      const operator = await createActor(app, "+254700009106");
      store.grantPlatformOperator({ accountId: operator.accountId, grantedBy: "test-harness" });
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/v1/platform/model-catalog/custom-shop-model",
            headers: jsonHeaders(operator.cookie),
            payload: JSON.stringify(modelPayload({ id: "custom-shop-model", label: "Custom" }))
          })
        ).statusCode
      ).toBe(200);

      store.revokePlatformOperator(operator.accountId);

      const afterRevoke = await app.inject({
        method: "PUT",
        url: "/v1/platform/model-catalog/custom-shop-model",
        headers: jsonHeaders(operator.cookie),
        payload: JSON.stringify(modelPayload({ id: "custom-shop-model", label: "Changed again" }))
      });
      expect(afterRevoke.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});

async function createActor(
  app: ReturnType<typeof buildApi>,
  contact: string
): Promise<{ cookie: string; accountId: string }> {
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ method: "phone", contact, pin: "1234" })
  });
  expect(signup.statusCode).toBe(200);
  const setCookie = signup.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0] as string;
  const accountId = signup.json<{ account: { id: string } }>().account.id;
  return { cookie, accountId };
}

function jsonHeaders(cookie: string) {
  return { "content-type": "application/json", cookie };
}

function modelPayload(overrides: { id: string; label: string }) {
  return {
    id: overrides.id,
    label: overrides.label,
    provider: "local",
    description: "Test catalog model",
    capabilities: ["chat"],
    available: true,
    source: "huggingface",
    format: "GGUF",
    license: "Apache-2.0",
    licenseUrl: null,
    modelCardUrl: null,
    downloadUrl: null,
    fileName: null,
    fileSizeBytes: null,
    minimumMemoryGb: null,
    recommended: false,
    contextWindow: null
  };
}

function agentPayload(overrides: { id: string }) {
  return {
    id: overrides.id,
    displayName: "Receptionist",
    role: "Front-desk receptionist",
    description: "Handles greetings and routing.",
    operatingPattern: "Focused operator",
    workloadClass: "focused",
    minimumDeviceTier: "low",
    minimumMemoryGb: 2,
    recommendedContextTokens: 1024,
    personality: "Polite and efficient",
    instructions: "Greet the customer and route their request.",
    knowledge: "Use saved business records.",
    tools: ["Products"],
    skillIds: [],
    runtimeAdapterId: "grogoni"
  };
}
