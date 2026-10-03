import { describe, expect, it } from "vitest";

import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import type { ModelRuntimeAdapter } from "../services/api/src/inference/model-runtime";

const modelId = "gpt-6-luna";

describe("engine choice travels with the agent definition, not an independent axis", () => {
  it("an explicit model activation surfaces the agent definition's own declared engine", async () => {
    // With a ZeroClaw gateway connected, Shopkeeper runs on ZeroClaw both as the zero-setup
    // default and after an explicit activation (its own declared engine).
    const store = createCp2Store({
      modelRuntimeAdapterResolver: () => adapter(),
      zeroClawGateway: {
        url: new URL("https://zeroclaw.example.test"),
        token: "test-token",
        webhookSecret: "",
        agentAlias: "",
        timeoutMs: 5_000
      }
    });
    const app = buildApi({ cp2: { store } });
    try {
      const actor = await createActorAndShop(app, "+254700009301", "Untouched Shop");

      const beforeActivation = await effective(app, actor);
      expect(beforeActivation.agent).toMatchObject({
        id: "builtin:shopkeeper",
        runtimeAdapterId: "zeroclaw"
      });

      const activated = await app.inject({
        method: "POST",
        url: `/api/agents/${actor.businessId}/models/${modelId}/activate`,
        headers: { "content-type": "application/json", cookie: actor.cookie },
        payload: JSON.stringify({
          shopId: actor.businessId,
          executionTarget: "backend",
          executionMode: "LOCAL_FIRST",
          permissions: { allowRemoteShopDevice: false }
        })
      });
      expect(activated.statusCode).toBe(200);

      const afterActivation = await effective(app, actor);
      expect(afterActivation.agent).toMatchObject({
        id: "builtin:shopkeeper",
        runtimeAdapterId: "zeroclaw"
      });
    } finally {
      await app.close();
    }
  });

  it("runs Shopkeeper on Grogoni's built-in engine where no ZeroClaw gateway is connected", async () => {
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
          executionTarget: "backend",
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
          executionTarget: "backend",
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
    provider: "test-vercel",
    executionTarget: "backend",
    canRun: async () => ({ available: true, errorCode: null, message: null }),
    healthCheck: async () => ({
      available: true,
      modelId,
      provider: "test-vercel",
      executionTarget: "backend",
      latencyMs: 1,
      responsePreview: "GROGONI_MODEL_OK",
      errorCode: null,
      message: null,
      retryable: false
    }),
    generate: async () => ({
      text: JSON.stringify({ type: "response", message: "ok" }),
      modelId,
      provider: "test-vercel",
      executionTarget: "backend",
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
