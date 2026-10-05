import { describe, expect, it } from "vitest";
import type {
  RuntimeModelCompletionResult,
  RuntimeModelPrompt,
  RuntimeModelProvider
} from "../packages/shared-types/src";
import { parseRuntimeModelOutput } from "../packages/tool-core/src";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import type { ModelArtifactStore } from "../services/api/src/inference/model-artifact-store";
import {
  createVercelInferenceClient,
  createVercelModelAdapter
} from "../services/api/src/inference/model-runtime";
import { activateGenericGlobalDefaultModel } from "./fixtures/native-runtime-test-helpers";

interface VerifyOtpResponse {
  session: {
    id: string;
  };
}

interface CreateBusinessResponse {
  business: {
    id: string;
  };
}

interface ProductResponse {
  id: string;
  name: string;
  quantity: number;
}

interface ConversationInboxResponse {
  conversations: Array<{
    id: string;
  }>;
}

interface ProcessedConversationMessageResponse {
  id: string;
  content: {
    type: string;
  };
  agentMessage: {
    id: string;
    author: string;
    replyToMessageId: string | null;
    content:
      | {
          type: "text";
          text: string;
        }
      | {
          type: string;
        };
  };
  runtime: RuntimeTurnResponse | null;
}

interface RuntimeTurnResponse {
  session: {
    id: string;
  };
  turn: {
    status: "completed" | "needs_confirmation" | "clarifying" | "blocked" | "rate_limited";
    parserIntent: string;
    plan: {
      toolName: string;
      risk: string;
      confirmationToken: string | null;
      executedAt: string | null;
    };
    verification: {
      ok: boolean;
      requiresConfirmation: boolean;
      confirmationSatisfied: boolean;
    };
    model: {
      provider: string | null;
      status: string;
      outputKind: string | null;
      errorCode: string | null;
    } | null;
    response: string;
    toolResult: unknown;
    telemetry: Array<{
      state: string;
      metadata: Record<string, unknown>;
    }>;
  };
}

describe("CP11 local model adapter", () => {
  it("parses bounded local model output into runtime tool proposals", () => {
    const parsed = parseRuntimeModelOutput(
      JSON.stringify({
        type: "tool",
        toolName: "products.list",
        input: {},
        reason: "Show products from local model routing."
      })
    );

    expect(parsed).toMatchObject({
      ok: true,
      output: {
        kind: "tool",
        proposal: {
          toolName: "products.list",
          validation: {
            ok: true
          }
        }
      }
    });
    expect(parseRuntimeModelOutput("not json")).toMatchObject({
      ok: false,
      output: null
    });
  });

  it("accepts a smaller model's tool proposal even when it omits the required type discriminator", async () => {
    // Reproduces a live-verified failure: activating a weaker swap-in model against the real
    // Vercel inference service, the model consistently answered with
    // {"toolName":"products.list","input":{}} - valid JSON, but missing the "type":"tool" field
    // parseRuntimeModelOutput requires, so every turn failed MODEL_RESPONSE_PARSE_FAILED even
    // though the proposal was unambiguous. normalizeModelText (model-runtime.ts) is what tolerates
    // this. Without it, the execution target is only swappable in theory - the moment a real
    // deployment activates a weaker model, chat breaks despite activation's own health probe
    // having passed.
    const artifactStore: ModelArtifactStore = {
      async resolveArtifact(modelId) {
        return {
          id: `test:${modelId}`,
          modelId,
          storageProvider: "neon-object-storage",
          bucket: "grogoni-model-artifacts",
          objectKey: `models/${modelId}/model.gguf`,
          format: "gguf",
          quantization: "Q4_0",
          sizeBytes: 12,
          sha256: null,
          contentType: "application/octet-stream",
          status: "available",
          createdAt: "2026-08-31T00:00:00.000Z",
          updatedAt: "2026-08-31T00:00:00.000Z"
        };
      },
      async createDownloadUrl(artifact) {
        return {
          ...artifact,
          downloadUrl: "https://storage.example.neon.tech/grogoni-model-artifacts/model.gguf",
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        };
      },
      async verifyArtifact() {
        return { ok: true, sizeMatches: true, hashMatches: null, errorCode: null };
      }
    };
    const adapter = createVercelModelAdapter({
      modelId: "qwen2.5-0.5b-android",
      artifactStore,
      client: createVercelInferenceClient({
        baseUrl: "https://vercel-inference.example",
        serviceToken: "a".repeat(32),
        timeoutMs: 1_000,
        request: async (input, init) => {
          const url = input instanceof URL ? input : new URL(String(input));
          if (url.pathname === "/health") {
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          }
          const requestId =
            typeof init?.body === "string"
              ? ((JSON.parse(init.body) as { requestId?: string }).requestId ?? "req-1")
              : "req-1";
          const events = [
            {
              type: "result",
              requestId,
              text: JSON.stringify({ toolName: "products.list", input: {} }),
              finishReason: "stop",
              usage: { inputTokens: 10, outputTokens: 5 },
              metrics: {}
            }
          ];
          const encoder = new TextEncoder();
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              for (const event of events) {
                controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
              }
              controller.close();
            }
          });
          return new Response(body, {
            status: 200,
            headers: { "content-type": "application/x-ndjson" }
          });
        }
      })
    });

    const result = await adapter.generate({
      context: { agentId: "agent", shopId: "shop", modelId: "qwen2.5-0.5b-android" },
      prompt: {
        message: "hello",
        allowedTools: [],
        schemaVersion: "cp11-runtime-model-v1"
      }
    });

    expect(parseRuntimeModelOutput(result.text)).toMatchObject({
      ok: true,
      output: {
        kind: "tool",
        proposal: { toolName: "products.list" }
      }
    });
  });

  it("reports an explicit fallback when the active model has no inference provider", async () => {
    let selectedModelId: string | null = null;
    const store = createCp2Store({
      runtimeModelProviderResolver: (modelId) => {
        selectedModelId = modelId;
        return undefined;
      }
    });
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);

    const turn = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      {
        message: "open products"
      },
      sessionCookie
    );

    expect(selectedModelId).toBe("smollm2-360m");
    expect(turn.turn).toMatchObject({
      status: "completed",
      model: {
        provider: null,
        status: "disabled",
        outputKind: null,
        errorCode: "model_provider_unconfigured"
      },
      plan: {
        toolName: "products.list"
      }
    });

    await app.close();
  });

  it("processes a persisted agent-chat message exactly once across idempotent retries", async () => {
    let completionCount = 0;
    const provider = createTestModelProvider(async () => {
      completionCount += 1;
      return availableCompletion({
        type: "response",
        message: "The agent processed this chat message."
      });
    });
    const store = createCp2Store({ runtimeModelProvider: provider });
    // Global default model/host are seeded unavailable until a verified health check runs (see
    // services/api/src/index.ts's production startup gate); mirror that here so the injected
    // provider is actually reachable.
    activateGenericGlobalDefaultModel(store, new Date().toISOString());
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);
    const inboxResponse = await app.inject({
      method: "GET",
      url: "/v1/conversations",
      headers: { cookie: sessionCookie }
    });
    expect(inboxResponse.statusCode).toBe(200);
    const conversationId = inboxResponse.json<ConversationInboxResponse>().conversations[0]?.id;
    expect(conversationId).toBeTruthy();
    const payload = {
      conversationId,
      clientMessageId: "message-agent-processing-0001",
      content: {
        type: "text",
        text: "Please process this in the agent chat."
      },
      clientTimestamp: new Date().toISOString(),
      agent: {
        businessId,
        runtimeSessionId: null,
        message: "Please process this in the agent chat."
      }
    };

    const first = await postJson<ProcessedConversationMessageResponse>(
      app,
      "/v1/messages",
      payload,
      sessionCookie
    );
    const retried = await postJson<ProcessedConversationMessageResponse>(
      app,
      "/v1/messages",
      payload,
      sessionCookie
    );

    expect(completionCount).toBe(1);
    expect(first.runtime?.turn).toMatchObject({
      status: "completed",
      model: {
        provider: "test",
        status: "available",
        outputKind: "response"
      },
      response: "The agent processed this chat message."
    });
    expect(first.agentMessage).toMatchObject({
      author: "agent",
      replyToMessageId: first.id,
      content: {
        type: "text",
        text: "The agent processed this chat message."
      }
    });
    expect(retried.id).toBe(first.id);
    expect(retried.agentMessage.id).toBe(first.agentMessage.id);
    expect(retried.runtime).toBeNull();
    expect(
      store
        .snapshot()
        .conversationMessages.filter((message) => message.conversationId === conversationId)
    ).toHaveLength(2);

    await app.close();
  });

  it("persists an honest unavailable-model notice, not a fabricated reply, and retries idempotently", async () => {
    let completionCount = 0;
    const provider = createTestModelProvider(async () => {
      completionCount += 1;
      if (completionCount === 1) {
        return {
          provider: "test",
          status: "unavailable",
          outputText: null,
          durationMs: 1,
          errorCode: "MODEL_PROVIDER_UNREACHABLE",
          metadata: {}
        };
      }
      return availableCompletion({
        type: "response",
        message: "Recovered local response."
      });
    });
    const store = createCp2Store({ runtimeModelProvider: provider });
    // Global default model/host are seeded unavailable until a verified health check runs (see
    // services/api/src/index.ts's production startup gate); mirror that here so the injected
    // provider is actually reachable.
    activateGenericGlobalDefaultModel(store, new Date().toISOString());
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);
    const inbox = await app.inject({
      method: "GET",
      url: "/v1/conversations",
      headers: { cookie: sessionCookie }
    });
    const conversationId = inbox.json<ConversationInboxResponse>().conversations[0]?.id;
    const payload = {
      conversationId,
      clientMessageId: "message-agent-retry-0001",
      content: { type: "text", text: "Retry this local request." },
      agent: {
        businessId,
        message: "Retry this local request."
      }
    };

    const completed = await postJson<ProcessedConversationMessageResponse>(
      app,
      "/v1/messages",
      payload,
      sessionCookie
    );
    expect(completed).toMatchObject({
      status: "delivered",
      failureCode: null,
      processing: {
        status: "completed",
        errorCode: "AGENT_MODEL_UNAVAILABLE",
        retryable: true
      },
      runtime: null,
      agentMessage: {
        author: "agent"
      }
    });
    // No fabricated model output: the persisted reply is an honest, actionable notice, not a
    // canned answer standing in for a real completion.
    expect(completed.agentMessage.content).toMatchObject({
      type: "text",
      text: expect.stringMatching(/can.?t use a working model/iu)
    });
    expect(store.snapshot().conversationMessages).toHaveLength(2);

    const retried = await postJson<ProcessedConversationMessageResponse>(
      app,
      "/v1/messages",
      payload,
      sessionCookie
    );
    expect(completionCount).toBe(1);
    expect(retried.id).toBe(completed.id);
    expect(retried.agentMessage.id).toBe(completed.agentMessage.id);
    expect(retried.runtime).toBeNull();
    expect(store.snapshot().conversationMessages).toHaveLength(2);

    await app.close();
  });

  it("sends prior persisted conversation turns to the model in chronological order", async () => {
    const prompts: RuntimeModelPrompt[] = [];
    const provider = createTestModelProvider(async (prompt) => {
      prompts.push(prompt);
      return availableCompletion({
        type: "response",
        message: prompts.length === 1 ? "I remember pineapples." : "You said pineapples."
      });
    });
    const store = createCp2Store({ runtimeModelProvider: provider });
    // Global default model/host are seeded unavailable until a verified health check runs (see
    // services/api/src/index.ts's production startup gate); mirror that here so the injected
    // provider is actually reachable.
    activateGenericGlobalDefaultModel(store, new Date().toISOString());
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);
    const inbox = await app.inject({
      method: "GET",
      url: "/v1/conversations",
      headers: { cookie: sessionCookie }
    });
    const conversationId = inbox.json<ConversationInboxResponse>().conversations[0]?.id;

    await postJson(
      app,
      "/v1/messages",
      {
        conversationId,
        clientMessageId: "message-history-0001",
        content: { type: "text", text: "Remember pineapples." },
        agent: { businessId, message: "Remember pineapples." }
      },
      sessionCookie
    );
    await postJson(
      app,
      "/v1/messages",
      {
        conversationId,
        clientMessageId: "message-history-0002",
        content: { type: "text", text: "What did I ask you to remember?" },
        agent: { businessId, message: "What did I ask you to remember?" }
      },
      sessionCookie
    );

    expect(prompts[1]?.conversationHistory).toEqual([
      { role: "user", content: "Remember pineapples." },
      { role: "assistant", content: "I remember pineapples." }
    ]);

    await app.close();
  });

  it("builds server-authoritative llama.cpp prompts with bounded context and no business record names", async () => {
    let capturedPrompt: RuntimeModelPrompt | null = null;
    const provider = createTestModelProvider(async (prompt) => {
      capturedPrompt = prompt;
      return availableCompletion({
        type: "tool",
        toolName: "products.list",
        input: {},
        reason: "List inventory through local model routing."
      });
    });
    const store = createCp2Store({ runtimeModelProvider: provider });
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);
    await postJson<ProductResponse>(
      app,
      `/businesses/${businessId}/products`,
      {
        name: "Private Sugar",
        unit: "kg",
        quantity: 8
      },
      sessionCookie
    );

    const turn = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      {
        message: "what is in stock?",
        agentProfile: {
          behavior: "Practical, polite, and inventory-first",
          integrations: ["Grogoni storefront"],
          knowledge: "Prioritize saved products and confirmed store records.",
          model: "qwen2.5-0.5b-android",
          role: "Store attendant",
          instructions: "Only promise items the store can actually supply.",
          tools: ["Products", "Invoices"],
          contextScripts: [
            "script: product_catalogue_commands\nallow: read, add, edit, remove\nsw: onyesha bidhaa => products.list"
          ]
        }
      },
      sessionCookie
    );

    expect(capturedPrompt).toMatchObject({
      schemaVersion: "cp11-runtime-model-v1",
      context: {
        businessId,
        productCount: 1
      }
    });
    expect(JSON.stringify(capturedPrompt?.context)).not.toContain("Private Sugar");
    // assembleAgentInferenceMessage (services/api/src/cp2/domains/agent-runtime/*.ts) renders the
    // stored, persisted agent profile's compiled instructions into prompt.message before it ever
    // reaches a model adapter (Vercel's createVercelModelAdapter, tested separately, sends this
    // text through verbatim) - the per-turn agentProfile field in the request body above is not
    // the source of truth and must never leak into what the model actually sees.
    const assembledMessage = capturedPrompt?.message ?? "";
    expect(assembledMessage).not.toContain("Private Sugar");
    expect(assembledMessage).toContain(
      "Use this agent profile as the guiding operating principles for how this store is run."
    );
    expect(assembledMessage).toContain(
      "Agent behavior: Warm, concise, accurate and commercially practical."
    );
    expect(assembledMessage).toContain("# Available verified tools");
    expect(assembledMessage).toContain("script: product_catalogue_commands");
    expect(assembledMessage).not.toContain("Practical, polite, and inventory-first");
    expect(assembledMessage).not.toContain("Only promise items the store can actually supply");
    expect(assembledMessage).not.toContain("sw: onyesha bidhaa => products.list");
    expect(turn.turn).toMatchObject({
      status: "completed",
      model: {
        provider: "test",
        status: "available",
        outputKind: "tool"
      },
      plan: {
        toolName: "products.list",
        risk: "low"
      }
    });
    expect(turn.turn.toolResult).toEqual([
      expect.objectContaining({
        name: "Private Sugar"
      })
    ]);
    expect(turn.turn.telemetry.map((event) => event.state)).toEqual(
      expect.arrayContaining(["model.prompt_built", "model.completed"])
    );

    await app.close();
  });

  it("keeps model-derived high-risk actions behind confirmation gates", async () => {
    // product.create is auto-accepted (no confirmation gate) - the mock model routes to
    // product.create on the first call (to seed a product, completing immediately) and
    // product.update (still confirmed) on the second, which is this test's actual proof.
    let callCount = 0;
    const provider = createTestModelProvider(async () => {
      callCount += 1;
      return callCount === 1
        ? availableCompletion({
            type: "tool",
            toolName: "product.create",
            input: {
              name: "Model Sugar",
              unit: "kg",
              quantity: 3
            },
            reason: "Draft product from local model routing."
          })
        : availableCompletion({
            type: "tool",
            toolName: "product.update",
            input: {
              productName: "Model Sugar",
              quantity: 5
            },
            reason: "Update product from local model routing."
          });
    });
    const store = createCp2Store({ runtimeModelProvider: provider });
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);

    const created = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      {
        message: "please ask the local model to draft inventory sugar"
      },
      sessionCookie
    );
    expect(created.turn).toMatchObject({
      status: "completed",
      plan: { toolName: "product.create", requiresConfirmation: false }
    });
    expect(store.snapshot().products).toHaveLength(1);

    const proposed = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      {
        runtimeSessionId: created.session.id,
        message: "please ask the local model to update inventory sugar"
      },
      sessionCookie
    );

    expect(proposed.turn).toMatchObject({
      status: "needs_confirmation",
      model: {
        outputKind: "tool"
      },
      plan: {
        toolName: "product.update",
        risk: "high",
        executedAt: null
      },
      verification: {
        ok: false,
        requiresConfirmation: true,
        confirmationSatisfied: false
      }
    });
    expect(proposed.turn.plan.confirmationToken).toBeTruthy();
    expect(store.snapshot().products[0]?.quantity).toBe(3);

    const confirmed = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      {
        runtimeSessionId: proposed.session.id,
        message: "confirm",
        confirmationToken: proposed.turn.plan.confirmationToken
      },
      sessionCookie
    );

    expect(confirmed.turn).toMatchObject({
      status: "completed",
      model: null,
      verification: {
        ok: true,
        confirmationSatisfied: true
      }
    });
    expect(confirmed.turn.toolResult).toMatchObject({
      name: "Model Sugar",
      quantity: 5
    });

    await app.close();
  });

  it("falls back deterministically when the local model is unavailable or malformed", async () => {
    const unavailable = await runFallbackCase("unavailable", null, "llama_not_running");
    expect(unavailable.turn).toMatchObject({
      status: "completed",
      model: {
        status: "unavailable",
        errorCode: "llama_not_running"
      },
      plan: {
        toolName: "products.list"
      }
    });

    const timedOut = await runFallbackCase("timeout", null, "timeout");
    expect(timedOut.turn).toMatchObject({
      status: "completed",
      model: {
        status: "timeout",
        errorCode: "timeout"
      },
      plan: {
        toolName: "products.list"
      }
    });

    const malformed = await runFallbackCase("available", "not json", null);
    expect(malformed.turn).toMatchObject({
      status: "completed",
      model: {
        status: "malformed"
      },
      plan: {
        toolName: "products.list"
      }
    });

    const thrown = await runThrownFallbackCase();
    expect(thrown.turn).toMatchObject({
      status: "completed",
      model: {
        status: "error",
        errorCode: "provider_exception"
      },
      plan: {
        toolName: "products.list"
      }
    });
  });

  it("does not log plaintext prompts or model output in runtime telemetry", async () => {
    const provider = createTestModelProvider(async () =>
      availableCompletion({
        type: "tool",
        toolName: "products.list",
        input: {},
        reason: "Sensitive model reason should not be telemetry plaintext."
      })
    );
    const store = createCp2Store({ runtimeModelProvider: provider });
    const app = buildApi({ cp2: { store } });
    const { businessId, sessionCookie } = await createOwnerBusiness(app);

    const turn = await postJson<RuntimeTurnResponse>(
      app,
      `/businesses/${businessId}/runtime/turns`,
      {
        message: "show products with private note abc123"
      },
      sessionCookie
    );

    const telemetryText = JSON.stringify(turn.turn.telemetry);
    expect(telemetryText).not.toContain("private note abc123");
    expect(telemetryText).not.toContain("Sensitive model reason");
    expect(JSON.stringify(store.snapshot().auditEvents)).not.toContain("private note abc123");

    await app.close();
  });
});

async function runFallbackCase(
  status: RuntimeModelCompletionResult["status"],
  outputText: string | null,
  errorCode: string | null
): Promise<RuntimeTurnResponse> {
  const provider = createTestModelProvider(async () => ({
    provider: "test",
    status,
    outputText,
    durationMs: 1,
    errorCode,
    metadata: {}
  }));
  const store = createCp2Store({ runtimeModelProvider: provider });
  const app = buildApi({ cp2: { store } });
  const { businessId, sessionCookie } = await createOwnerBusiness(app);

  const turn = await postJson<RuntimeTurnResponse>(
    app,
    `/businesses/${businessId}/runtime/turns`,
    {
      message: "open products"
    },
    sessionCookie
  );

  await app.close();
  return turn;
}

async function runThrownFallbackCase(): Promise<RuntimeTurnResponse> {
  const provider = createTestModelProvider(async () => {
    throw new Error("local provider failed");
  });
  const store = createCp2Store({ runtimeModelProvider: provider });
  const app = buildApi({ cp2: { store } });
  const { businessId, sessionCookie } = await createOwnerBusiness(app);

  const turn = await postJson<RuntimeTurnResponse>(
    app,
    `/businesses/${businessId}/runtime/turns`,
    {
      message: "open products"
    },
    sessionCookie
  );

  await app.close();
  return turn;
}

function createTestModelProvider(
  complete: (prompt: RuntimeModelPrompt) => Promise<RuntimeModelCompletionResult>
): RuntimeModelProvider {
  return {
    name: "test",
    complete
  };
}

function availableCompletion(output: unknown): RuntimeModelCompletionResult {
  return {
    provider: "test",
    status: "available",
    outputText: JSON.stringify(output),
    durationMs: 1,
    errorCode: null,
    metadata: {}
  };
}

async function createOwnerBusiness(app: ReturnType<typeof buildApi>) {
  const verifyResponse = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: jsonHeaders(),
    payload: JSON.stringify({
      method: "phone",
      contact: "254700000011",
      pin: "1234"
    })
  });
  const sessionCookie = extractSessionCookie(verifyResponse.headers["set-cookie"]);
  const auth = verifyResponse.json<VerifyOtpResponse>();
  const business = await postJson<CreateBusinessResponse>(
    app,
    "/businesses",
    {
      name: "Jane's Shop",
      language: "en"
    },
    sessionCookie
  );

  expect(auth.session.id).toBeTruthy();

  return {
    businessId: business.business.id,
    sessionCookie
  };
}

async function postJson<TResponse>(
  app: ReturnType<typeof buildApi>,
  url: string,
  payload: Record<string, unknown>,
  cookie?: string
): Promise<TResponse> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: cookie === undefined ? jsonHeaders() : { ...jsonHeaders(), cookie },
    payload: JSON.stringify(payload)
  });

  expect(response.statusCode).toBe(200);
  return response.json<TResponse>();
}

function jsonHeaders() {
  return {
    "content-type": "application/json"
  };
}

function extractSessionCookie(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  expect(value).toBeDefined();
  return value?.split(";")[0] ?? "";
}
