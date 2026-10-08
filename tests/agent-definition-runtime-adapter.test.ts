import { describe, expect, it } from "vitest";

import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import { connectedAgentRuntimeAdapterId } from "../services/api/src/agent-harness/retired-agent-runtimes";
import type { ModelRuntimeAdapter } from "../services/api/src/inference/model-runtime";

const modelId = "smollm2-360m";

describe("engine choice travels with the agent definition, not an independent axis", () => {
  it("resolves the retired ZeroClaw engine named by stored definitions to Grogoni's own", () => {
    // Agent definitions, native runtime agents and migration 103 may still name "zeroclaw"; it
    // must resolve to the built-in engine, while every live engine id passes through unchanged.
    expect(connectedAgentRuntimeAdapterId("zeroclaw")).toBe("grogoni");
    expect(connectedAgentRuntimeAdapterId("grogoni")).toBe("grogoni");
    expect(connectedAgentRuntimeAdapterId("pi")).toBe("pi");
  });

  it("keeps a shop whose saved agent names the retired ZeroClaw engine chatting", async () => {
    // Regression: shop agents persisted in cp2_native_runtime_agents while ZeroClaw was deployed
    // still carry runtimeAdapterId "zeroclaw". Without the mapping every turn returned 503
    // AGENT_RUNTIME_ADAPTER_UNAVAILABLE and the shop never recovered.
    const store = createCp2Store({ modelRuntimeAdapterResolver: () => adapter() });
    const app = buildApi({ cp2: { store } });
    try {
      const actor = await createActorAndShop(app, "+254700009305", "Legacy ZeroClaw Shop");
      const turn = () =>
        app.inject({
          method: "POST",
          url: `/businesses/${actor.businessId}/runtime/turns`,
          headers: { "content-type": "application/json", cookie: actor.cookie },
          payload: JSON.stringify({ message: "Hello" })
        });
      expect((await turn()).statusCode).toBe(200);

      const snapshot = store.snapshot();
      const shopAgents = snapshot.nativeRuntimeAgents.filter(
        (agent) => agent.businessId === actor.businessId
      );
      expect(shopAgents.length).toBeGreaterThan(0);
      store.hydrateSnapshot({
        ...snapshot,
        nativeRuntimeAgents: snapshot.nativeRuntimeAgents.map((agent) =>
          agent.businessId === actor.businessId
            ? { ...agent, configuration: { ...agent.configuration, runtimeAdapterId: "zeroclaw" } }
            : agent
        )
      });

      const afterLegacyLoad = await turn();
      expect(afterLegacyLoad.statusCode, afterLegacyLoad.body).toBe(200);
      expect(afterLegacyLoad.json()).toMatchObject({
        turn: { model: { agentAdapterId: "grogoni" } }
      });
      expect((await effective(app, actor)).agent.runtimeAdapterId).toBe("grogoni");
    } finally {
      await app.close();
    }
  });

  it("runs Shopkeeper on Grogoni's built-in engine before and after an explicit activation", async () => {
    const store = createCp2Store({ modelRuntimeAdapterResolver: () => adapter() });
    const app = buildApi({ cp2: { store } });
    try {
      const actor = await createActorAndShop(app, "+254700009304", "No Gateway Shop");
      expect((await effective(app, actor)).agent).toMatchObject({
        id: "builtin:shopkeeper",
        runtimeAdapterId: "grogoni"
      });
      const activated = await app.inject({
        method: "POST",
        url: `/api/agents/${actor.businessId}/models/${modelId}/activate`,
        headers: { "content-type": "application/json", cookie: actor.cookie },
        payload: JSON.stringify({
          shopId: actor.businessId,
          executionTarget: "local",
          executionMode: "LOCAL_FIRST",
          permissions: { allowRemoteShopDevice: false }
        })
      });
      expect(activated.statusCode).toBe(200);
      expect((await effective(app, actor)).agent).toMatchObject({
        id: "builtin:shopkeeper",
        runtimeAdapterId: "grogoni"
      });
    } finally {
      await app.close();
    }
  });

  it("picking a different agent definition changes the resolved engine on the next activation", async () => {
    const store = createCp2Store({ modelRuntimeAdapterResolver: () => adapter() });
    const app = buildApi({ cp2: { store } });
    try {
      const actor = await createActorAndShop(app, "+254700009302", "Switching Shop");

      const profile = await app.inject({
        method: "GET",
        url: `/businesses/${actor.businessId}/agent-profile`,
        headers: { cookie: actor.cookie }
      });
      expect(profile.statusCode).toBe(200);

      const switched = await app.inject({
        method: "PUT",
        url: `/businesses/${actor.businessId}/agent-profile`,
        headers: { "content-type": "application/json", cookie: actor.cookie },
        payload: JSON.stringify({ ...profile.json(), agentDefinitionId: "builtin:pi-assistant" })
      });
      expect(switched.statusCode).toBe(200);
      expect(switched.json()).toMatchObject({ agentDefinitionId: "builtin:pi-assistant" });

      const activated = await app.inject({
        method: "POST",
        url: `/api/agents/${actor.businessId}/models/${modelId}/activate`,
        headers: { "content-type": "application/json", cookie: actor.cookie },
        payload: JSON.stringify({
          shopId: actor.businessId,
          executionTarget: "local",
          executionMode: "LOCAL_FIRST",
          permissions: { allowRemoteShopDevice: false }
        })
      });
      expect(activated.statusCode).toBe(200);

      const afterActivation = await effective(app, actor);
      expect(afterActivation.agent).toMatchObject({
        id: "builtin:pi-assistant",
        runtimeAdapterId: "pi"
      });
    } finally {
      await app.close();
    }
  });

  it("rejects an agent catalog entry whose declared engine is not a registered adapter", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    try {
      const actor = await createActorAndShop(app, "+254700009303", "Bad Adapter Shop");
      store.grantPlatformOperator({ accountId: actor.accountId, grantedBy: "test-suite" });

      const response = await app.inject({
        method: "PUT",
        url: "/v1/platform/agent-catalog/builtin:broken-engine",
        headers: { "content-type": "application/json", cookie: actor.cookie },
        payload: JSON.stringify({
          id: "builtin:broken-engine",
          displayName: "Broken",
          role: "Test",
          description: "Declares an unregistered engine.",
          operatingPattern: "Focused operator",
          workloadClass: "focused",
          minimumDeviceTier: "low",
          minimumMemoryGb: 2,
          recommendedContextTokens: 1024,
          personality: "N/A",
          instructions: "N/A.",
          knowledge: "N/A.",
          tools: [],
          skillIds: [],
          runtimeAdapterId: "not-a-real-adapter"
        })
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "agent_catalog_entry_invalid" });
    } finally {
      await app.close();
    }
  });
});

function adapter(): ModelRuntimeAdapter {
  return {
    provider: "test-ollama",
    executionTarget: "local",
    canRun: async () => ({ available: true, errorCode: null, message: null }),
    healthCheck: async () => ({
      available: true,
      modelId,
      provider: "test-ollama",
      executionTarget: "local",
      latencyMs: 1,
      responsePreview: "GROGONI_MODEL_OK",
      errorCode: null,
      message: null,
      retryable: false
    }),
    generate: async () => ({
      text: JSON.stringify({ type: "response", message: "ok" }),
      modelId,
      provider: "test-ollama",
      executionTarget: "local",
      latencyMs: 1
    })
  };
}

async function effective(
  app: ReturnType<typeof buildApi>,
  actor: { cookie: string; businessId: string }
) {
  const response = await app.inject({
    method: "GET",
    url: `/businesses/${actor.businessId}/runtime/effective`,
    headers: { cookie: actor.cookie }
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ agent: { id: string; name: string; runtimeAdapterId: string } }>();
}

async function createActorAndShop(app: ReturnType<typeof buildApi>, contact: string, name: string) {
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
  const businessResponse = await app.inject({
    method: "POST",
    url: "/businesses",
    headers: { "content-type": "application/json", cookie },
    payload: JSON.stringify({ name, language: "en" })
  });
  expect(businessResponse.statusCode).toBe(200);
  const businessId = businessResponse.json<{ business: { id: string } }>().business.id;
  return { cookie, accountId, businessId };
}
