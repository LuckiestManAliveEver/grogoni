import { describe, expect, it } from "vitest";

import type { AgentModelActivationResult, AiModelSummary } from "../packages/shared-types/src";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import { DeviceInferenceBroker } from "../services/api/src/inference/device-inference-broker";
import type { InferencePolicyRecord } from "../services/api/src/inference/providers/repositories";
import {
  catalogModel,
  createTestPlatform,
  jsonResponse,
  openAiCompletion,
  scriptedFetch,
  sseResponse,
  testSecrets
} from "./fixtures/inference-provider-fakes";

const deviceModelId = "qwen2.5-0.5b-device";
const deviceEngineModel = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";

function jsonHeaders(cookie?: string, extra: Record<string, string> = {}) {
  return {
    "content-type": "application/json",
    ...(cookie === undefined ? {} : { cookie }),
    ...extra
  };
}

async function signUp(app: ReturnType<typeof buildApi>, contact: string) {
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: jsonHeaders(),
    payload: JSON.stringify({ method: "phone", contact, pin: "1234" })
  });
  expect(signup.statusCode).toBe(200);
  const setCookie = signup.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0] as string;
  return { cookie, accountId: signup.json<{ account: { id: string } }>().account.id };
}

async function owner(app: ReturnType<typeof buildApi>, contact: string) {
  const person = await signUp(app, contact);
  const business = await app.inject({
    method: "POST",
    url: "/businesses",
    headers: jsonHeaders(person.cookie),
    payload: JSON.stringify({ name: "Device Shop", language: "en" })
  });
  expect(business.statusCode).toBe(200);
  return { ...person, businessId: business.json<{ business: { id: string } }>().business.id };
}

async function activate(
  app: ReturnType<typeof buildApi>,
  shop: { cookie: string; businessId: string },
  modelId: string
) {
  const catalog = await app.inject({
    method: "GET",
    url: "/v1/ai-models",
    headers: { cookie: shop.cookie }
  });
  const listed = catalog
    .json<{ models: AiModelSummary[] }>()
    .models.find((model) => model.id === modelId);
  const response = await app.inject({
    method: "POST",
    url: `/api/agents/${shop.businessId}/models/${modelId}/activate`,
    headers: jsonHeaders(shop.cookie),
    payload: JSON.stringify({
      shopId: shop.businessId,
      executionTarget: listed?.hostedExecutionTarget,
      executionMode: "LOCAL_ONLY",
      costResponsibility: "merchant",
      permissions: { allowRemoteShopDevice: false }
    })
  });
  expect(response.statusCode, response.body).toBe(200);
  return { listed: listed!, activation: response.json<AgentModelActivationResult>() };
}

async function firstConversation(app: ReturnType<typeof buildApi>, cookie: string) {
  const conversations = await app.inject({
    method: "GET",
    url: "/v1/conversations",
    headers: { cookie }
  });
  return conversations.json<{ conversations: Array<{ id: string }> }>().conversations[0]!.id;
}

function sendMessage(
  app: ReturnType<typeof buildApi>,
  shop: { cookie: string; businessId: string },
  conversationId: string,
  text: string,
  turnId: string
) {
  return app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: jsonHeaders(shop.cookie, { "x-grogoni-turn-id": turnId }),
    payload: JSON.stringify({
      conversationId,
      clientMessageId: `client-${turnId}`,
      content: { type: "text", text },
      clientTimestamp: new Date().toISOString(),
      agent: { businessId: shop.businessId, message: text }
    })
  });
}

describe("device-local models through the real chat path", () => {
  it("runs the shop's on-device model on the member's own device and returns its reply", async () => {
    const { fetch, requests } = scriptedFetch(() => jsonResponse({}));
    const { platform, repositories } = createTestPlatform({ catalog: [], fetch });
    const app = buildApi({ cp2: { store: createCp2Store({ inferencePlatform: platform }) } });
    try {
      const shop = await owner(app, "+254700009201");
      const outsider = await owner(app, "+254700009202");
      const { listed, activation } = await activate(app, shop, deviceModelId);
      expect(listed).toMatchObject({ hostedExecutionTarget: "browser-local", provider: "local" });
      expect(activation.binding).toMatchObject({
        modelId: deviceModelId,
        executionTarget: "browser-local"
      });

      const conversationId = await firstConversation(app, shop.cookie);
      const turnId = "turn-device-0001";
      const reply = sendMessage(app, shop, conversationId, "What sells best?", turnId);
      const claimUrl = `/v1/ai/device-inference/jobs/next?runtime=browser-local&models=${deviceEngineModel}&turnId=${turnId}&waitMs=3000`;

      // Another account's device never sees this shop member's job.
      const foreign = await app.inject({
        method: "GET",
        url: claimUrl.replace("waitMs=3000", "waitMs=50"),
        headers: { cookie: outsider.cookie }
      });
      expect(foreign.statusCode).toBe(204);

      const claimed = await app.inject({
        method: "GET",
        url: claimUrl,
        headers: { cookie: shop.cookie }
      });
      expect(claimed.statusCode, claimed.body).toBe(200);
      expect(claimed.headers["cache-control"]).toBe("no-store");
      const job = claimed.json<{
        job: {
          id: string;
          token: string;
          messages: Array<{ role: string; content: string }>;
          generation: { jsonOutput: boolean };
        };
      }>().job;
      expect(job.messages[0]?.role).toBe("system");
      expect(job.messages.at(-1)?.content).toContain("What sells best?");
      expect(job.generation.jsonOutput).toBe(true);

      const forged = await app.inject({
        method: "POST",
        url: `/v1/ai/device-inference/jobs/${job.id}/result`,
        headers: jsonHeaders(outsider.cookie),
        payload: JSON.stringify({ token: job.token, text: "hijacked" })
      });
      expect(forged.statusCode).toBe(404);

      const submitted = await app.inject({
        method: "POST",
        url: `/v1/ai/device-inference/jobs/${job.id}/result`,
        headers: jsonHeaders(shop.cookie),
        payload: JSON.stringify({
          token: job.token,
          text: '{"type":"response","message":"Sugar sells best on this device."}',
          usage: { inputTokens: 120, outputTokens: 9 },
          latencyMs: 900
        })
      });
      expect(submitted.statusCode).toBe(200);

      const response = await reply;
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        conversationId,
        agentMessage: { content: { text: "Sugar sells best on this device." } }
      });
      // Nothing went to any cloud provider, and the run is recorded as free on-device usage.
      expect(requests).toHaveLength(0);
      expect(repositories.runsSnapshot().at(-1)).toMatchObject({
        providerId: "local",
        executionTarget: "browser-local",
        inputTokens: 120,
        outputTokens: 9,
        estimatedCost: 0,
        status: "succeeded"
      });
    } finally {
      await app.close();
    }
  });

  it("keeps a device model's tool proposals behind Grogoni's confirmation gate", async () => {
    const { fetch } = scriptedFetch(() => jsonResponse({}));
    const { platform } = createTestPlatform({ catalog: [], fetch });
    const store = createCp2Store({ inferencePlatform: platform });
    const app = buildApi({ cp2: { store } });
    try {
      const shop = await owner(app, "+254700009203");
      await activate(app, shop, deviceModelId);
      const device = (async () => {
        for (const output of [
          {
            type: "tool",
            toolName: "product.create",
            input: { name: "Device Sugar", unit: "kg", quantity: 3 }
          },
          {
            type: "tool",
            toolName: "product.update",
            input: { productName: "Device Sugar", quantity: 9 }
          }
        ]) {
          const claimed = await app.inject({
            method: "GET",
            url: `/v1/ai/device-inference/jobs/next?models=${deviceEngineModel}&waitMs=5000`,
            headers: { cookie: shop.cookie }
          });
          const job = claimed.json<{ job: { id: string; token: string } }>().job;
          await app.inject({
            method: "POST",
            url: `/v1/ai/device-inference/jobs/${job.id}/result`,
            headers: jsonHeaders(shop.cookie),
            payload: JSON.stringify({
              token: job.token,
              text: JSON.stringify({ ...output, reason: "device" })
            })
          });
        }
      })();
      const turn = (message: string, extra: Record<string, unknown> = {}) =>
        app.inject({
          method: "POST",
          url: `/businesses/${shop.businessId}/runtime/turns`,
          headers: jsonHeaders(shop.cookie),
          payload: JSON.stringify({ message, ...extra })
        });
      const created = await turn("please ask the local model to draft inventory sugar");
      expect(created.json()).toMatchObject({
        turn: { status: "completed", plan: { toolName: "product.create" } }
      });
      const proposed = await turn("please ask the local model to update inventory sugar", {
        runtimeSessionId: created.json<{ session: { id: string } }>().session.id
      });
      expect(proposed.json()).toMatchObject({
        turn: {
          status: "needs_confirmation",
          plan: { toolName: "product.update", executedAt: null }
        }
      });
      await device;
      expect(
        store.snapshot().products.find((product) => product.name === "Device Sugar")?.quantity
      ).toBe(3);
    } finally {
      await app.close();
    }
  });

  it("fails clearly - without switching to a cloud model - when no device with the model is online", async () => {
    const { fetch, requests } = scriptedFetch(() =>
      jsonResponse(openAiCompletion({ content: "cloud" }))
    );
    const { platform } = createTestPlatform({
      catalog: [],
      fetch,
      options: { deviceBroker: new DeviceInferenceBroker({ claimTimeoutMs: 30 }) }
    });
    const app = buildApi({ cp2: { store: createCp2Store({ inferencePlatform: platform }) } });
    try {
      const shop = await owner(app, "+254700009204");
      await activate(app, shop, deviceModelId);
      const conversationId = await firstConversation(app, shop.cookie);
      const response = await sendMessage(app, shop, conversationId, "Hello?", "turn-device-0002");
      expect(response.statusCode).not.toBe(500);
      expect(JSON.stringify(response.json())).not.toContain("cloud");
      expect(requests).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});

describe("live reply streaming", () => {
  it("streams hosted model text to the member's turn stream while the turn runs", async () => {
    const { fetch } = scriptedFetch((request) => {
      if (request.method === "GET") return jsonResponse({ data: [] });
      if (request.body?.stream === true) {
        return sseResponse([
          { data: { choices: [{ index: 0, delta: { content: '{"type":"response","mes' } }] } },
          { data: { choices: [{ index: 0, delta: { content: 'sage":"Streaming ' } }] } },
          {
            data: { choices: [{ index: 0, delta: { content: 'reply."}' }, finish_reason: "stop" }] }
          },
          {
            data: {
              choices: [],
              usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 }
            }
          },
          { data: "[DONE]" }
        ]);
      }
      return jsonResponse(openAiCompletion({ content: "{}" }));
    });
    const { platform } = createTestPlatform({ catalog: [], fetch });
    const store = createCp2Store({ inferencePlatform: platform });
    const app = buildApi({ cp2: { store } });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
    try {
      const shop = await owner(app, "+254700009205");
      const operator = await signUp(app, "+254700009206");
      store.grantPlatformOperator({ accountId: operator.accountId, grantedBy: "test" });
      const put = await app.inject({
        method: "PUT",
        url: "/v1/platform/model-catalog/gpt-stream",
        headers: jsonHeaders(operator.cookie),
        payload: JSON.stringify(
          catalogModel({
            id: "gpt-stream",
            providerId: "openai",
            providerModelId: "gpt-x",
            capabilities: { streaming: true }
          })
        )
      });
      expect(put.statusCode, put.body).toBe(200);
      await activate(app, shop, "gpt-stream");
      const conversationId = await firstConversation(app, shop.cookie);

      const turnId = "turn-stream-0001";
      const streamResponse = await globalThis.fetch(`${base}/v1/ai/turn-stream/${turnId}`, {
        headers: { cookie: shop.cookie, accept: "text/event-stream" }
      });
      expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");
      const reader = streamResponse.body!.getReader();
      const decoder = new TextDecoder();
      let raw = "";
      const received = (async () => {
        while (!raw.includes('reply."}') && !raw.includes("reply.")) {
          const { value, done } = await reader.read();
          if (done) break;
          raw += decoder.decode(value, { stream: true });
        }
      })();
      const turn = await globalThis.fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: jsonHeaders(shop.cookie, { "x-grogoni-turn-id": turnId }),
        body: JSON.stringify({
          conversationId,
          clientMessageId: "client-stream-0001",
          content: { type: "text", text: "Tell me something" },
          clientTimestamp: new Date().toISOString(),
          agent: { businessId: shop.businessId, message: "Tell me something" }
        })
      });
      expect(turn.status).toBe(200);
      expect(await turn.json()).toMatchObject({
        agentMessage: { content: { text: "Streaming reply." } }
      });
      await received;
      await reader.cancel();
      const texts = raw
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)) as { type: string; text?: string })
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join("");
      expect(texts).toBe("Streaming reply.");
      expect(raw).not.toContain('"type":"response"');

      // Another account cannot read this turn's stream.
      const outsider = await signUp(app, "+254700009207");
      const peek = await globalThis.fetch(`${base}/v1/ai/turn-stream/${turnId}`, {
        headers: { cookie: outsider.cookie }
      });
      const peekReader = peek.body!.getReader();
      const first = await Promise.race([
        peekReader.read(),
        new Promise<{ value: undefined }>((resolve) =>
          setTimeout(() => resolve({ value: undefined }), 150)
        )
      ]);
      expect(first.value === undefined ? "" : new TextDecoder().decode(first.value)).not.toContain(
        "Streaming"
      );
      await peekReader.cancel();
    } finally {
      await app.close();
    }
  });
});

describe("inference policy and provider management APIs", () => {
  function appWithOperator() {
    const { fetch } = scriptedFetch(() => jsonResponse({ data: [] }));
    const { platform, repositories } = createTestPlatform({ catalog: [], fetch });
    const store = createCp2Store({ inferencePlatform: platform });
    return { app: buildApi({ cp2: { store } }), store, platform, repositories };
  }

  it("lets a shop owner set budgets and explicit fallback, validated, and keeps others out", async () => {
    const { app, repositories } = appWithOperator();
    try {
      const shop = await owner(app, "+254700009301");
      const stranger = await owner(app, "+254700009302");
      const url = `/v1/ai/policies/shop/${shop.businessId}`;
      const initial = await app.inject({ method: "GET", url, headers: { cookie: shop.cookie } });
      expect(initial.json()).toMatchObject({
        scope: "tenant",
        fallbackPolicy: "NONE",
        dailyBudget: null
      });

      const saved = await app.inject({
        method: "PUT",
        url,
        headers: jsonHeaders(shop.cookie),
        payload: JSON.stringify({
          dailyBudget: 2.5,
          maxRequestsPerMinute: 30,
          fallbackPolicy: "SAME_PROVIDER",
          fallbackModelIds: ["qwen3-4b-grogoni-cloud"]
        })
      });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(
        await repositories.policies.get({ scope: "tenant", tenantId: shop.businessId })
      ).toMatchObject({
        dailyBudget: 2.5,
        maxRequestsPerMinute: 30,
        fallbackPolicy: "SAME_PROVIDER"
      });

      for (const body of [
        { providerMonthlyCeilings: { openai: 10 } },
        { fallbackPolicy: "ALWAYS" },
        { fallbackPolicy: "APPROVED_PROVIDERS", approvedProviderIds: ["not-a-provider"] },
        { fallbackPolicy: "SAME_PROVIDER", fallbackModelIds: ["smollm2-360m"] },
        { dailyBudget: -1 },
        { fallbackModelIds: ["qwen3-4b-grogoni-cloud"] }
      ]) {
        const rejected = await app.inject({
          method: "PUT",
          url,
          headers: jsonHeaders(shop.cookie),
          payload: JSON.stringify(body)
        });
        expect(rejected.statusCode, JSON.stringify(body)).toBe(400);
      }
      const intruder = await app.inject({
        method: "PUT",
        url,
        headers: jsonHeaders(stranger.cookie),
        payload: JSON.stringify({ dailyBudget: 1_000 })
      });
      expect([403, 404]).toContain(intruder.statusCode);
      expect(
        (await repositories.policies.get({ scope: "tenant", tenantId: shop.businessId }))
          ?.dailyBudget
      ).toBe(2.5);

      const mine = await app.inject({
        method: "PUT",
        url: "/v1/ai/policies/me",
        headers: jsonHeaders(shop.cookie),
        payload: JSON.stringify({ dailyBudget: 1 })
      });
      expect(mine.json()).toMatchObject({ scope: "user", dailyBudget: 1 });
      const global = await app.inject({
        method: "PUT",
        url: "/v1/platform/ai/policy",
        headers: jsonHeaders(shop.cookie),
        payload: "{}"
      });
      expect(global.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("lets only platform operators add, validate and remove provider configuration", async () => {
    const { app, store } = appWithOperator();
    try {
      const merchant = await signUp(app, "+254700009303");
      const operator = await signUp(app, "+254700009304");
      store.grantPlatformOperator({ accountId: operator.accountId, grantedBy: "test" });
      const gateway = {
        displayName: "Team gateway",
        type: "openai-compatible",
        baseUrl: "https://gateway.example.com/v1",
        credentialRef: "env:TEAM_GATEWAY_KEY"
      };
      const denied = await app.inject({
        method: "PUT",
        url: "/v1/platform/ai/providers/team-gateway",
        headers: jsonHeaders(merchant.cookie),
        payload: JSON.stringify(gateway)
      });
      expect(denied.statusCode).toBe(403);

      for (const bad of [
        { ...gateway, baseUrl: "https://169.254.169.254/v1" },
        { ...gateway, baseUrl: "http://gateway.example.com/v1" },
        { ...gateway, credentialRef: testSecrets.openai },
        { ...gateway, type: "chatgpt-web" }
      ]) {
        const rejected = await app.inject({
          method: "PUT",
          url: "/v1/platform/ai/providers/team-gateway",
          headers: jsonHeaders(operator.cookie),
          payload: JSON.stringify(bad)
        });
        expect(rejected.statusCode, JSON.stringify(bad)).toBe(400);
      }

      const created = await app.inject({
        method: "PUT",
        url: "/v1/platform/ai/providers/team-gateway",
        headers: jsonHeaders(operator.cookie),
        payload: JSON.stringify(gateway)
      });
      expect(created.statusCode, created.body).toBe(200);
      const visible = await app.inject({
        method: "GET",
        url: "/v1/ai/providers",
        headers: { cookie: merchant.cookie }
      });
      expect(
        visible
          .json<{ providers: Array<{ id: string }> }>()
          .providers.map((provider) => provider.id)
      ).toContain("team-gateway");
      expect(visible.body).not.toContain("TEAM_GATEWAY_KEY");

      const removed = await app.inject({
        method: "DELETE",
        url: "/v1/platform/ai/providers/team-gateway",
        headers: { cookie: operator.cookie }
      });
      expect(removed.statusCode).toBe(200);
      const after = await app.inject({
        method: "GET",
        url: "/v1/ai/providers",
        headers: { cookie: merchant.cookie }
      });
      expect(after.body).not.toContain("team-gateway");
    } finally {
      await app.close();
    }
  });
});

describe("budget scopes", () => {
  it("applies Grogoni's caps only to Grogoni-funded spend and a shop's own cap to all its spend", async () => {
    const { fetch } = scriptedFetch(() =>
      jsonResponse(
        openAiCompletion({ content: "ok", usage: { prompt_tokens: 1_000, completion_tokens: 500 } })
      )
    );
    const priced = [
      catalogModel({
        id: "gpt-priced",
        providerId: "openai",
        providerModelId: "gpt",
        pricing: { inputPerMillionTokens: 2, outputPerMillionTokens: 8 }
      })
    ];
    const context = { agentId: "agent", tenantId: "shop-1", userId: "user-1" };
    const request = {
      requestId: "r",
      modelId: "gpt-priced",
      messages: [{ role: "user" as const, content: "hi" }]
    };

    // Platform cap 0.006 USD/day; each call costs 0.006.
    const platformCapped = createTestPlatform({
      catalog: priced,
      fetch,
      env: { INFERENCE_TENANT_DAILY_BUDGET: "0.006" }
    });
    await platformCapped.platform.router.generate(request, context);
    await expect(platformCapped.platform.router.generate(request, context)).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED"
    });
    // The shop connects its own key: Grogoni's cap no longer applies to its own spend.
    await platformCapped.platform.connections.connect({
      scope: "tenant",
      tenantId: "shop-1",
      userId: "user-1",
      actorId: "user-1",
      providerId: "openai",
      apiKey: "sk-shop-owned-key-00000000000000SHOP"
    });
    await expect(platformCapped.platform.router.generate(request, context)).resolves.toBeDefined();

    // The shop's own cap limits everything it spends, including its own key.
    const ownCap: InferencePolicyRecord = {
      scope: "tenant",
      tenantId: "shop-1",
      userId: null,
      currency: "USD",
      dailyBudget: 0.006,
      providerMonthlyCeilings: {},
      maxRequestsPerMinute: null,
      maxTokensPerRequest: null,
      fallbackPolicy: "NONE",
      approvedProviderIds: [],
      fallbackModelIds: [],
      updatedAt: new Date().toISOString()
    };
    const shopCapped = createTestPlatform({ catalog: priced, fetch, policies: [ownCap] });
    await shopCapped.platform.connections.connect({
      scope: "tenant",
      tenantId: "shop-1",
      userId: "user-1",
      actorId: "user-1",
      providerId: "openai",
      apiKey: "sk-shop-owned-key-00000000000000SHOP"
    });
    await shopCapped.platform.router.generate(request, context);
    await expect(shopCapped.platform.router.generate(request, context)).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED"
    });
  });
});
