import { describe, expect, it } from "vitest";

import type { AgentModelActivationResult, AiModelSummary } from "../packages/shared-types/src";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import {
  anthropicMessage,
  catalogModel,
  createTestPlatform,
  jsonResponse,
  openAiCompletion,
  scriptedFetch,
  testSecrets,
  type RecordedRequest
} from "./fixtures/inference-provider-fakes";

/**
 * chat -> agent -> model binding -> inference router -> (mocked) provider -> normalized response
 * -> chat, through the real HTTP API and the real agent runtime. The only fakes are the vendors'
 * HTTP endpoints.
 */

const providerModels: AiModelSummary[] = [
  catalogModel({
    id: "qwen3-4b-cloud",
    label: "Qwen (Grogoni Cloud)",
    providerId: "grogoni-llama",
    providerModelId: "qwen3-4b"
  }),
  catalogModel({
    id: "glm-test",
    label: "GLM",
    providerId: "zai-general",
    providerModelId: "glm-vendor-id"
  }),
  catalogModel({
    id: "claude-test",
    label: "Claude",
    providerId: "anthropic",
    providerModelId: "claude-vendor-id"
  }),
  catalogModel({
    id: "gpt-test",
    label: "GPT",
    providerId: "openai",
    providerModelId: "gpt-vendor-id",
    capabilities: { tools: true }
  })
];

function lastUserText(request: RecordedRequest): string {
  const messages = (request.body?.messages ?? []) as Array<{ role: string; content: unknown }>;
  const last = [...messages].reverse().find((message) => message.role === "user");
  return JSON.stringify(last?.content ?? "");
}

function vendors(state: { failZai: boolean }) {
  return scriptedFetch((request) => {
    if (request.method === "GET") return jsonResponse({ data: [] });
    const host = new URL(request.url).hostname;
    if (host === "api.anthropic.com") {
      return jsonResponse(
        anthropicMessage({
          text: JSON.stringify({ type: "response", message: "Reply from Claude." })
        })
      );
    }
    if (host === "api.z.ai") {
      if (state.failZai) return jsonResponse({ error: { message: "upstream overloaded" } }, 503);
      // A 1-token verification probe during activation.
      if (request.body?.max_tokens === 1) return jsonResponse(openAiCompletion({ content: "ok" }));
      return jsonResponse(
        openAiCompletion({
          content: JSON.stringify({ type: "response", message: "Reply from GLM." })
        })
      );
    }
    if (host === "inference.grogoni.example") {
      return jsonResponse(openAiCompletion({ content: "Reply from Qwen." }));
    }
    if (host === "api.openai.com") {
      const text = lastUserText(request);
      if (text.includes("draft inventory sugar")) {
        return jsonResponse(
          openAiCompletion({
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "call_create",
                name: "product__create",
                arguments: JSON.stringify({ name: "Model Sugar", unit: "kg", quantity: 3 })
              }
            ]
          })
        );
      }
      if (text.includes("update inventory sugar")) {
        return jsonResponse(
          openAiCompletion({
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "call_update",
                name: "product__update",
                arguments: JSON.stringify({ productName: "Model Sugar", quantity: 5 })
              }
            ]
          })
        );
      }
      return jsonResponse(
        openAiCompletion({
          content: JSON.stringify({ type: "response", message: "Reply from GPT." })
        })
      );
    }
    throw new Error(`unexpected host ${host}`);
  });
}

function jsonHeaders(cookie?: string) {
  return { "content-type": "application/json", ...(cookie === undefined ? {} : { cookie }) };
}

async function setup(contact: string) {
  const state = { failZai: false };
  const { fetch, requests } = vendors(state);
  const { platform, repositories } = createTestPlatform({ catalog: [], fetch });
  const store = createCp2Store({ inferencePlatform: platform });
  const app = buildApi({ cp2: { store } });

  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: jsonHeaders(),
    payload: JSON.stringify({ method: "phone", contact, pin: "1234" })
  });
  expect(signup.statusCode).toBe(200);
  const setCookie = signup.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0] as string;
  const accountId = signup.json<{ account: { id: string } }>().account.id;
  const business = await app.inject({
    method: "POST",
    url: "/businesses",
    headers: jsonHeaders(cookie),
    payload: JSON.stringify({ name: "Multi Provider Shop", language: "en" })
  });
  expect(business.statusCode).toBe(200);
  const businessId = business.json<{ business: { id: string } }>().business.id;

  // Registering provider-routed models is catalog data, through the existing operator API -
  // no code change and nothing agent-specific.
  store.grantPlatformOperator({ accountId, grantedBy: "test-harness" });
  for (const model of providerModels) {
    const put = await app.inject({
      method: "PUT",
      url: `/v1/platform/model-catalog/${model.id}`,
      headers: jsonHeaders(cookie),
      payload: JSON.stringify(model)
    });
    expect(put.statusCode).toBe(200);
  }
  return { app, store, cookie, businessId, requests, repositories, state };
}

async function activate(
  context: Awaited<ReturnType<typeof setup>>,
  modelId: string
): Promise<AgentModelActivationResult> {
  const catalog = await context.app.inject({
    method: "GET",
    url: "/v1/ai-models",
    headers: { cookie: context.cookie }
  });
  const listed = catalog
    .json<{ models: AiModelSummary[] }>()
    .models.find((model) => model.id === modelId);
  expect(listed).toMatchObject({
    runtimeAvailability: { backend: "configured" },
    hostedExecutionTarget: "backend"
  });
  const response = await context.app.inject({
    method: "POST",
    url: `/api/agents/${context.businessId}/models/${modelId}/activate`,
    headers: jsonHeaders(context.cookie),
    payload: JSON.stringify({
      shopId: context.businessId,
      executionTarget: listed!.hostedExecutionTarget,
      executionMode: "CLOUD_ONLY",
      costResponsibility: "merchant",
      permissions: { allowRemoteShopDevice: false }
    })
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<AgentModelActivationResult>();
}

async function send(
  context: Awaited<ReturnType<typeof setup>>,
  conversationId: string,
  text: string,
  id: string
) {
  return context.app.inject({
    method: "POST",
    url: "/v1/messages",
    headers: jsonHeaders(context.cookie),
    payload: JSON.stringify({
      conversationId,
      clientMessageId: id,
      content: { type: "text", text },
      clientTimestamp: new Date().toISOString(),
      agent: { businessId: context.businessId, message: text }
    })
  });
}

async function history(context: Awaited<ReturnType<typeof setup>>, conversationId: string) {
  const response = await context.app.inject({
    method: "GET",
    url: `/v1/conversations/${conversationId}`,
    headers: { cookie: context.cookie }
  });
  return response
    .json<{ messages: Array<{ content: { text?: string } }> }>()
    .messages.map((message) => message.content.text);
}

describe("multi-provider inference through the agent runtime", () => {
  it("switches Qwen -> GLM -> Claude -> GPT in one conversation without replacing the agent", async () => {
    const context = await setup("+254700008101");
    try {
      const first = await activate(context, "qwen3-4b-cloud");
      const conversations = await context.app.inject({
        method: "GET",
        url: "/v1/conversations",
        headers: { cookie: context.cookie }
      });
      const conversationId = conversations.json<{ conversations: Array<{ id: string }> }>()
        .conversations[0]!.id;

      const expected: Array<[string, string, string]> = [
        ["qwen3-4b-cloud", "inference.grogoni.example", "Reply from Qwen."],
        ["glm-test", "api.z.ai", "Reply from GLM."],
        ["claude-test", "api.anthropic.com", "Reply from Claude."],
        ["gpt-test", "api.openai.com", "Reply from GPT."]
      ];
      for (const [index, [modelId, host, reply]] of expected.entries()) {
        if (index > 0) {
          const swapped = await activate(context, modelId);
          // Same agent, same shop - only the model binding changed.
          expect(swapped.binding).toMatchObject({
            id: first.binding.id,
            agentId: first.binding.agentId,
            shopId: context.businessId,
            modelId
          });
        }
        const turn = await send(
          context,
          conversationId,
          `Hello number ${index + 1}`,
          `multi-provider-${index}`
        );
        expect(turn.statusCode, turn.body).toBe(200);
        expect(turn.json()).toMatchObject({
          conversationId,
          agentMessage: { content: { text: reply } }
        });
        expect(new URL(context.requests.at(-1)!.url).hostname).toBe(host);
      }

      // One stable binding slot for the whole sequence: swapping models rewrote its model role,
      // never the binding identity or its agent.
      const active = context.store
        .snapshot()
        .nativeRuntimeBindings.filter(
          (binding) => binding.businessId === context.businessId && binding.status === "active"
        );
      expect(active).toHaveLength(1);
      expect(active[0]?.agentId).toBe(first.binding.agentId);
      expect(await history(context, conversationId)).toEqual(
        expect.arrayContaining([
          "Reply from Qwen.",
          "Reply from GLM.",
          "Reply from Claude.",
          "Reply from GPT."
        ])
      );

      // Usage was recorded per provider, with no prompt text and no key material.
      const runs = context.repositories.runsSnapshot().filter((run) => run.status === "succeeded");
      expect(runs.map((run) => run.providerId)).toEqual([
        "grogoni-llama",
        "zai-general",
        "anthropic",
        "openai"
      ]);
      expect(
        runs.every(
          (run) => run.tenantId === context.businessId && run.credentialScope === "platform"
        )
      ).toBe(true);
      expect(JSON.stringify(runs)).not.toContain("Hello number");
      expect(JSON.stringify(runs)).not.toContain(testSecrets.openai);
    } finally {
      await context.app.close();
    }
  });

  it("keeps the conversation intact when the selected provider fails, without switching providers", async () => {
    const context = await setup("+254700008102");
    try {
      await activate(context, "glm-test");
      const conversations = await context.app.inject({
        method: "GET",
        url: "/v1/conversations",
        headers: { cookie: context.cookie }
      });
      const conversationId = conversations.json<{ conversations: Array<{ id: string }> }>()
        .conversations[0]!.id;

      const ok = await send(context, conversationId, "First message", "failure-0001");
      expect(ok.json()).toMatchObject({ agentMessage: { content: { text: "Reply from GLM." } } });

      context.state.failZai = true;
      const requestsBefore = context.requests.length;
      const failed = await send(context, conversationId, "Second message", "failure-0002");
      expect(failed.statusCode).not.toBe(500);
      expect(failed.body).not.toContain(testSecrets.zai);
      // No silent cross-provider fallback: every call during the outage went to Z.ai.
      expect(
        context.requests.slice(requestsBefore).every((request) => request.url.includes("api.z.ai"))
      ).toBe(true);
      expect(await history(context, conversationId)).toEqual(
        expect.arrayContaining(["First message", "Reply from GLM."])
      );

      context.state.failZai = false;
      const recovered = await send(context, conversationId, "Third message", "failure-0003");
      expect(recovered.statusCode).toBe(200);
      expect(recovered.json()).toMatchObject({
        conversationId,
        agentMessage: { content: { text: "Reply from GLM." } }
      });
      expect(await history(context, conversationId)).toEqual(
        expect.arrayContaining(["First message", "Third message"])
      );
    } finally {
      await context.app.close();
    }
  });

  it("returns provider-native tool calls to Grogoni's tool runtime and approval engine", async () => {
    const context = await setup("+254700008103");
    try {
      await activate(context, "gpt-test");
      const turn = async (message: string, extra: Record<string, unknown> = {}) => {
        const response = await context.app.inject({
          method: "POST",
          url: `/businesses/${context.businessId}/runtime/turns`,
          headers: jsonHeaders(context.cookie),
          payload: JSON.stringify({ message, ...extra })
        });
        expect(response.statusCode, response.body).toBe(200);
        return response.json<{
          session: { id: string };
          turn: {
            status: string;
            plan: {
              toolName: string;
              confirmationToken?: string | null;
              executedAt: string | null;
            };
          };
        }>();
      };

      const created = await turn("please ask the local model to draft inventory sugar");
      expect(created.turn).toMatchObject({
        status: "completed",
        plan: { toolName: "product.create" }
      });
      // The native tool definitions were offered to OpenAI in its own wire format...
      const createCall = context.requests.find((request) =>
        lastUserText(request).includes("draft inventory sugar")
      );
      expect(
        (createCall?.body?.tools as Array<{ function: { name: string } }>).map(
          (tool) => tool.function.name
        )
      ).toContain("product__create");

      const proposed = await turn("please ask the local model to update inventory sugar", {
        runtimeSessionId: created.session.id
      });
      // ...but a consequential call still stops at Grogoni's confirmation gate. The provider did not execute it.
      expect(proposed.turn).toMatchObject({
        status: "needs_confirmation",
        plan: { toolName: "product.update", executedAt: null }
      });
      expect(
        context.store.snapshot().products.find((product) => product.name === "Model Sugar")
          ?.quantity
      ).toBe(3);
    } finally {
      await context.app.close();
    }
  });

  it("swaps provider mid-task through RuntimeHandoff, carrying the checkpoint forward", async () => {
    const context = await setup("+254700008105");
    try {
      // Both models installed on the shop's runtime graph; GLM ends up active.
      await activate(context, "claude-test");
      await activate(context, "glm-test");
      const created = await context.app.inject({
        method: "POST",
        url: "/v1/conversations",
        headers: jsonHeaders(context.cookie),
        payload: JSON.stringify({ kind: "personal", activeShopId: context.businessId })
      });
      const taskId = created.json<{ conversation: { id: string } }>().conversation.id;
      const first = await send(context, taskId, "Start the supplier task", "handoff-0001");
      expect(first.json()).toMatchObject({
        agentMessage: { content: { text: "Reply from GLM." } }
      });

      const resolved = await context.app.inject({
        method: "GET",
        url: `/v1/runtime/${taskId}`,
        headers: { cookie: context.cookie }
      });
      expect(resolved.statusCode, resolved.body).toBe(200);
      const checkpoint = await context.app.inject({
        method: "POST",
        url: `/v1/runtime/${taskId}/checkpoints`,
        headers: jsonHeaders(context.cookie),
        payload: JSON.stringify({
          goal: "Find a supplier for beads",
          nextAction: "Ask the supplier for a bulk discount",
          promote: true,
          expectedHandoffId: resolved.json<{ activeHandoff: { id: string } }>().activeHandoff.id
        })
      });
      expect(checkpoint.statusCode, checkpoint.body).toBe(200);
      const swap = await context.app.inject({
        method: "POST",
        url: `/v1/runtime/${taskId}/swaps/model`,
        headers: jsonHeaders(context.cookie),
        payload: JSON.stringify({
          targetId: "claude-test",
          expectedHandoffId: checkpoint.json<{ handoff: { id: string } }>().handoff.id
        })
      });
      expect(swap.statusCode, swap.body).toBe(200);
      expect(swap.json()).toMatchObject({
        activationFailed: false,
        handoff: {
          taskId,
          runtime: { modelId: "claude-test" },
          nextAction: "Ask the supplier for a bulk discount"
        }
      });

      const afterSwap = await send(context, taskId, "Continue the task", "handoff-0002");
      expect(afterSwap.statusCode, afterSwap.body).toBe(200);
      expect(afterSwap.json()).toMatchObject({
        conversationId: taskId,
        agentMessage: { content: { text: "Reply from Claude." } }
      });
      expect(await history(context, taskId)).toEqual(
        expect.arrayContaining([
          "Start the supplier task",
          "Reply from GLM.",
          "Continue the task",
          "Reply from Claude."
        ])
      );
    } finally {
      await context.app.close();
    }
  });

  it("uses a tenant's own key once connected, and Grogoni's key otherwise", async () => {
    const context = await setup("+254700008104");
    try {
      await activate(context, "claude-test");
      const conversations = await context.app.inject({
        method: "GET",
        url: "/v1/conversations",
        headers: { cookie: context.cookie }
      });
      const conversationId = conversations.json<{ conversations: Array<{ id: string }> }>()
        .conversations[0]!.id;
      await send(context, conversationId, "before byok", "byok-0001");
      expect(context.requests.at(-1)?.headers["x-api-key"]).toBe(testSecrets.anthropic);

      const tenantKey = "sk-ant-tenant-owned-key-0000000000TTTT";
      const connected = await context.app.inject({
        method: "POST",
        url: "/v1/ai/provider-connections",
        headers: jsonHeaders(context.cookie),
        payload: JSON.stringify({
          providerId: "anthropic",
          apiKey: tenantKey,
          scope: "tenant",
          businessId: context.businessId
        })
      });
      expect(connected.statusCode).toBe(200);
      await send(context, conversationId, "after byok", "byok-0002");
      expect(context.requests.at(-1)?.headers["x-api-key"]).toBe(tenantKey);
      expect(context.repositories.runsSnapshot().at(-1)).toMatchObject({
        credentialScope: "tenant",
        providerId: "anthropic"
      });

      await context.app.inject({
        method: "DELETE",
        url: `/v1/ai/provider-connections/${connected.json<{ id: string }>().id}`,
        headers: { cookie: context.cookie }
      });
      await send(context, conversationId, "after disconnect", "byok-0003");
      expect(context.requests.at(-1)?.headers["x-api-key"]).toBe(testSecrets.anthropic);
    } finally {
      await context.app.close();
    }
  });
});
