import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ModelExecutionTarget, RuntimeModelPrompt } from "../packages/shared-types/src";
import { buildApi } from "../services/api/src/app";
import { createCp2Store } from "../services/api/src/cp2/store";
import type { ModelRuntimeAdapter } from "../services/api/src/inference/model-runtime";

// End-to-end coverage of the Runtime Handoff Protocol's REST surface (docs/architecture/
// runtime-handoff-protocol.md section 15), through the real Fastify app and HTTP request/response
// cycle - complementary to tests/runtime-handoff-domain-unit.test.ts, which drives the same
// production RuntimeHandoffDomain class directly for the deeper transaction/concurrency/
// activation-failure scenarios.

describe("Runtime Handoff Protocol REST surface", () => {
  // Durable execution event log (docs/architecture/durable-execution-plane.md "Event lifecycle") -
  // proves the full taxonomy fires end-to-end for a real, conversation-attached, tool-executing
  // chat turn, not just the RuntimeHandoffDomain-internal lifecycle points exercised in
  // tests/runtime-handoff-domain-unit.test.ts.
  it("GET /v1/runtime/:taskId/events records the full execution lifecycle for a real chat turn", async () => {
    const eventsModelId = "qwen2.5-0.5b-android";
    const store = createCp2Store({
      modelRuntimeAdapterResolver: ({ modelId, executionTarget }) =>
        modelId === eventsModelId && executionTarget === "backend"
          ? healthyAdapter(eventsModelId)
          : undefined
    });
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "+254700009099", "Events Shop");
    await activateModel(app, owner, eventsModelId);

    const conversation = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({ kind: "personal", activeShopId: owner.businessId })
    });
    expect(conversation.statusCode).toBe(200);
    const taskId = conversation.json<{ conversation: { id: string } }>().conversation.id;

    await app.inject({
      method: "POST",
      url: `/businesses/${owner.businessId}/products`,
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({ name: "Sugar", unit: "kg", quantity: 4 })
    });

    const turn = await app.inject({
      method: "POST",
      url: `/businesses/${owner.businessId}/runtime/turns`,
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({ message: "show products", conversationId: taskId })
    });
    expect(turn.statusCode, turn.body).toBe(200);
    expect(turn.json<{ turn: { status: string } }>().turn.status).toBe("completed");

    const events = await app.inject({
      method: "GET",
      url: `/v1/runtime/${taskId}/events`,
      headers: { cookie: owner.cookie }
    });
    expect(events.statusCode).toBe(200);
    const eventList =
      events.json<
        Array<{ sequenceNumber: number; eventType: string; taskId: string; payload: unknown }>
      >();
    expect(eventList.length).toBeGreaterThan(5);
    expect(eventList.every((event) => event.taskId === taskId)).toBe(true);
    for (let i = 1; i < eventList.length; i += 1) {
      expect(eventList[i]!.sequenceNumber).toBe(eventList[i - 1]!.sequenceNumber + 1);
    }
    const types = eventList.map((event) => event.eventType);
    expect(types).toEqual(
      expect.arrayContaining([
        "TASK_CREATED",
        "EXECUTION_STARTED",
        "CONTEXT_RESOLVED",
        "CAPABILITIES_RESOLVED",
        "AUTHORIZATION_STARTED",
        "TOOL_REQUESTED",
        "AUTHORIZATION_COMPLETED",
        "TOOL_AUTHORIZED",
        "TOOL_STARTED",
        "TOOL_COMPLETED",
        "EXECUTION_COMPLETED",
        "CHECKPOINT_CREATED"
      ])
    );
    // Ordering sanity: authorization starts before the tool is authorized, which is before it
    // starts executing, which is before it completes.
    const indexOf = (type: string) => types.indexOf(type);
    expect(indexOf("AUTHORIZATION_STARTED")).toBeLessThan(indexOf("TOOL_AUTHORIZED"));
    expect(indexOf("TOOL_AUTHORIZED")).toBeLessThan(indexOf("TOOL_STARTED"));
    expect(indexOf("TOOL_STARTED")).toBeLessThan(indexOf("TOOL_COMPLETED"));
    expect(indexOf("TOOL_COMPLETED")).toBeLessThan(indexOf("EXECUTION_COMPLETED"));
    // Never exposes secrets/prompts.
    expect(JSON.stringify(eventList)).not.toContain("show products");

    // Same information, aggregated, via the inspection endpoint.
    const inspect = await app.inject({
      method: "GET",
      url: `/v1/runtime/${taskId}/inspect`,
      headers: { cookie: owner.cookie }
    });
    expect(inspect.statusCode).toBe(200);
    const inspection = inspect.json<{
      resumeEligible: boolean;
      lastSuccessfulEventType: string | null;
      latestEvents: unknown[];
    }>();
    expect(inspection.resumeEligible).toBe(true);
    expect(inspection.lastSuccessfulEventType).not.toBeNull();
    expect(inspection.latestEvents.length).toBeGreaterThan(0);

    await app.close();
  });

  it("bootstraps a legacy task on first GET, then checkpoints, swaps the model, resumes, and rolls back - all through HTTP", async () => {
    const primaryModelId = "qwen2.5-0.5b-android";
    const replacementModelId = "qwen2.5-1.5b-android";
    const adapter = healthyAdapter(primaryModelId);
    const replacementAdapter = healthyAdapter(replacementModelId);
    const store = createCp2Store({
      modelRuntimeAdapterResolver: ({ modelId, executionTarget }) => {
        if (modelId === primaryModelId && executionTarget === "backend") return adapter;
        if (modelId === replacementModelId && executionTarget === "backend")
          return replacementAdapter;
        return undefined;
      }
    });
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "+254700009001", "Handoff Shop");

    // Activate the replacement model first, then the primary - `activate` makes whichever call
    // runs last the shop's one active binding (see activateVerifiedModel), and this test wants
    // the *primary* model to be what the conversation actually starts on. The replacement model
    // still ends up installed and "active" in the native runtime graph either way, which is all
    // materializeConversationBinding/validateCandidateExecutionChain require to swap to it later.
    await activateModel(app, owner, replacementModelId, { skipTest: true });
    await activateModel(app, owner, primaryModelId);

    const created = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({ kind: "personal", activeShopId: owner.businessId })
    });
    expect(created.statusCode).toBe(200);
    const taskId = created.json<{ conversation: { id: string } }>().conversation.id;

    // 1. GET resolves and legacy-bootstraps a checkpoint from the pre-existing binding.
    const resolved1 = await app.inject({
      method: "GET",
      url: `/v1/runtime/${taskId}`,
      headers: { cookie: owner.cookie }
    });
    expect(resolved1.statusCode).toBe(200);
    const resolvedBody1 = resolved1.json<{
      activeHandoff: { id: string; checkpointVersion: number; runtime: Record<string, string> };
      taskHead: { activeHandoffId: string; nextCheckpointVersion: number };
      isRuntimeStale: boolean;
    }>();
    expect(resolvedBody1.activeHandoff.checkpointVersion).toBe(1);
    expect(resolvedBody1.taskHead.activeHandoffId).toBe(resolvedBody1.activeHandoff.id);
    expect(resolvedBody1.isRuntimeStale).toBe(false);

    // 2. POST a promoted checkpoint carrying forward a nextAction.
    const checkpoint = await app.inject({
      method: "POST",
      url: `/v1/runtime/${taskId}/checkpoints`,
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({
        goal: "Find a supplier for beads",
        currentState: "Searched two suppliers, comparing prices.",
        nextAction: "Ask the supplier for a bulk discount",
        pendingActions: [{ id: "ask-discount", description: "Ask for a bulk discount" }],
        promote: true,
        expectedHandoffId: resolvedBody1.activeHandoff.id
      })
    });
    expect(checkpoint.statusCode).toBe(200);
    const checkpointBody = checkpoint.json<{
      handoff: { id: string; nextAction: string; checkpointVersion: number };
      promoted: boolean;
    }>();
    expect(checkpointBody.promoted).toBe(true);
    expect(checkpointBody.handoff.checkpointVersion).toBe(2);
    expect(checkpointBody.handoff.nextAction).toBe("Ask the supplier for a bulk discount");

    // A stale expectedHandoffId is rejected with 409, never silently applied (section 7).
    const staleCheckpoint = await app.inject({
      method: "POST",
      url: `/v1/runtime/${taskId}/checkpoints`,
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({ promote: true, expectedHandoffId: resolvedBody1.activeHandoff.id })
    });
    expect(staleCheckpoint.statusCode).toBe(409);
    expect(staleCheckpoint.json()).toMatchObject({ code: "RUNTIME_HANDOFF_CONFLICT" });

    // 3. Swap the model. The new checkpoint must carry the same nextAction forward - no transcript
    // replay needed for the new runtime to know what to do next.
    const swap = await app.inject({
      method: "POST",
      url: `/v1/runtime/${taskId}/swaps/model`,
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({
        targetId: replacementModelId,
        expectedHandoffId: checkpointBody.handoff.id
      })
    });
    expect(swap.statusCode).toBe(200);
    const swapBody = swap.json<{
      handoff: {
        id: string;
        taskId: string;
        conversationId: string;
        nextAction: string;
        runtime: { modelId: string };
        parentHandoffId: string;
      };
      runtimeInstance: { status: string; activeHandoffId: string };
      activationFailed: boolean;
    }>();
    expect(swapBody.activationFailed).toBe(false);
    expect(swapBody.handoff.taskId).toBe(taskId);
    expect(swapBody.handoff.conversationId).toBe(taskId);
    expect(swapBody.handoff.runtime.modelId).toBe(replacementModelId);
    expect(swapBody.handoff.nextAction).toBe("Ask the supplier for a bulk discount");
    expect(swapBody.handoff.parentHandoffId).toBe(checkpointBody.handoff.id);
    expect(swapBody.runtimeInstance.status).toBe("READY");

    // 4. Resume reads the new runtime's state straight from the handoff.
    const resume = await app.inject({
      method: "POST",
      url: `/v1/runtime/${taskId}/resume`,
      headers: { cookie: owner.cookie }
    });
    expect(resume.statusCode).toBe(200);
    const resumeBody = resume.json<{
      activeHandoff: { nextAction: string };
      bootstrapped: boolean;
      runtimeInstance: { status: string };
    }>();
    expect(resumeBody.bootstrapped).toBe(false);
    expect(resumeBody.activeHandoff.nextAction).toBe("Ask the supplier for a bulk discount");
    expect(resumeBody.runtimeInstance.status).toBe("RUNNING");

    // 5. Rollback moves the head back to the pre-swap checkpoint without touching the binding.
    const rollback = await app.inject({
      method: "POST",
      url: `/v1/runtime/${taskId}/rollback`,
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({
        targetHandoffId: checkpointBody.handoff.id,
        expectedHandoffId: swapBody.handoff.id
      })
    });
    expect(rollback.statusCode).toBe(200);
    const rollbackBody = rollback.json<{
      taskHead: { activeHandoffId: string };
      activeHandoff: { runtime: { modelId: string } };
    }>();
    expect(rollbackBody.taskHead.activeHandoffId).toBe(checkpointBody.handoff.id);
    expect(rollbackBody.activeHandoff.runtime.modelId).toBe(primaryModelId);

    // The rolled-back-to handoff and the swap handoff both still exist, immutable, by direct id.
    const byId = await app.inject({
      method: "GET",
      url: `/v1/runtime/${taskId}/handoffs/${swapBody.handoff.id}`,
      headers: { cookie: owner.cookie }
    });
    expect(byId.statusCode).toBe(200);
    expect(byId.json<{ runtime: { modelId: string } }>().runtime.modelId).toBe(replacementModelId);

    // By-version lookup.
    const byVersion = await app.inject({
      method: "GET",
      url: `/v1/runtime/${taskId}/handoff?version=1`,
      headers: { cookie: owner.cookie }
    });
    expect(byVersion.statusCode).toBe(200);
    expect(byVersion.json<{ checkpointVersion: number }>().checkpointVersion).toBe(1);

    await app.close();
  });

  it("supports idempotent checkpoint retries via the Idempotency-Key header (section 6.2)", async () => {
    const modelId = "qwen2.5-0.5b-android";
    const adapter = healthyAdapter(modelId);
    const store = createCp2Store({
      modelRuntimeAdapterResolver: ({ modelId: candidateId, executionTarget }) =>
        candidateId === modelId && executionTarget === "backend" ? adapter : undefined
    });
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "+254700009002", "Idempotency Shop");
    await activateModel(app, owner, modelId);
    const created = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({ kind: "personal", activeShopId: owner.businessId })
    });
    const taskId = created.json<{ conversation: { id: string } }>().conversation.id;
    await app.inject({
      method: "GET",
      url: `/v1/runtime/${taskId}`,
      headers: { cookie: owner.cookie }
    });

    const headers = { ...jsonHeaders(owner.cookie), "idempotency-key": "retry-checkpoint-1" };
    const first = await app.inject({
      method: "POST",
      url: `/v1/runtime/${taskId}/checkpoints`,
      headers,
      payload: JSON.stringify({ currentState: "first attempt" })
    });
    const second = await app.inject({
      method: "POST",
      url: `/v1/runtime/${taskId}/checkpoints`,
      headers,
      payload: JSON.stringify({ currentState: "first attempt" })
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json<{ handoff: { id: string } }>().handoff.id).toBe(
      first.json<{ handoff: { id: string } }>().handoff.id
    );

    const resolved = await app.inject({
      method: "GET",
      url: `/v1/runtime/${taskId}`,
      headers: { cookie: owner.cookie }
    });
    // Exactly one unpromoted checkpoint was recorded - retry must not have produced a second one,
    // which would show up as the head's nextCheckpointVersion advancing twice.
    expect(
      resolved.json<{ taskHead: { nextCheckpointVersion: number } }>().taskHead
        .nextCheckpointVersion
    ).toBe(3);

    await app.close();
  });

  it("rejects a task that belongs to another account with 403/404, never leaking runtime state", async () => {
    const store = createCp2Store();
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "+254700009003", "Owner Shop");
    const intruder = await createOwnerBusiness(app, "+254700009004", "Intruder Shop");
    const created = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({ kind: "personal", activeShopId: owner.businessId })
    });
    const taskId = created.json<{ conversation: { id: string } }>().conversation.id;

    const asIntruder = await app.inject({
      method: "GET",
      url: `/v1/runtime/${taskId}`,
      headers: { cookie: intruder.cookie }
    });
    expect(asIntruder.statusCode).toBe(403);

    const missingTask = await app.inject({
      method: "GET",
      url: "/v1/runtime/not-a-real-task-id",
      headers: { cookie: owner.cookie }
    });
    expect(missingTask.statusCode).toBe(404);

    await app.close();
  });

  it("exposes runtime.status/checkpoint/swap over MCP, calling the same service layer as REST (section 17)", async () => {
    const primaryModelId = "qwen2.5-0.5b-android";
    const replacementModelId = "qwen2.5-1.5b-android";
    const adapter = healthyAdapter(primaryModelId);
    const replacementAdapter = healthyAdapter(replacementModelId);
    const store = createCp2Store({
      modelRuntimeAdapterResolver: ({ modelId, executionTarget }) => {
        if (modelId === primaryModelId && executionTarget === "backend") return adapter;
        if (modelId === replacementModelId && executionTarget === "backend")
          return replacementAdapter;
        return undefined;
      }
    });
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "+254700009005", "MCP Handoff Shop");
    await activateModel(app, owner, replacementModelId, { skipTest: true });
    await activateModel(app, owner, primaryModelId);

    const created = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({ kind: "personal", activeShopId: owner.businessId })
    });
    const taskId = created.json<{ conversation: { id: string } }>().conversation.id;

    const tokenResponse = await app.inject({
      method: "POST",
      url: "/v1/mcp/tokens",
      headers: { ...jsonHeaders(owner.cookie), origin: "http://localhost:5173" },
      payload: JSON.stringify({ name: "handoff-mcp-test", scopes: ["mcp:read", "mcp:act"] })
    });
    expect(tokenResponse.statusCode).toBe(200);
    const accessToken = tokenResponse.json<{ accessToken: string }>().accessToken;

    const initialized = await mcpPost(app, accessToken, initializeRequest());
    expect(initialized.statusCode).toBe(200);
    const mcpSessionId = String(initialized.headers["mcp-session-id"]);

    const statusResponse = await mcpPost(
      app,
      accessToken,
      toolCall(2, "grogoni.runtime_status", { taskId }),
      mcpSessionId
    );
    const status = statusResponse.json().result.structuredContent as {
      activeHandoff: { id: string; checkpointVersion: number };
    };
    expect(status.activeHandoff.checkpointVersion).toBe(1);

    const swapResponse = await mcpPost(
      app,
      accessToken,
      toolCall(3, "grogoni.model_swap", {
        taskId,
        targetId: replacementModelId,
        expectedHandoffId: status.activeHandoff.id
      }),
      mcpSessionId
    );
    const swap = swapResponse.json().result.structuredContent as {
      handoff: { runtime: { modelId: string } };
      activationFailed: boolean;
    };
    expect(swap.activationFailed).toBe(false);
    expect(swap.handoff.runtime.modelId).toBe(replacementModelId);

    // Same conversation/task the REST surface manages - the MCP swap took effect there too.
    const restConfirm = await app.inject({
      method: "GET",
      url: `/v1/runtime/${taskId}`,
      headers: { cookie: owner.cookie }
    });
    expect(
      restConfirm.json<{ activeHandoff: { runtime: { modelId: string } } }>().activeHandoff.runtime
        .modelId
    ).toBe(replacementModelId);

    await app.close();
  });

  it("syncs offline-created checkpoints and merges a diverged branch back into one line - all through HTTP (Offline causal ancestry)", async () => {
    const modelId = "qwen2.5-0.5b-android";
    const adapter = healthyAdapter(modelId);
    const store = createCp2Store({
      modelRuntimeAdapterResolver: ({ modelId: candidateId, executionTarget }) =>
        candidateId === modelId && executionTarget === "backend" ? adapter : undefined
    });
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "+254700009006", "Offline Handoff Shop");
    await activateModel(app, owner, modelId);
    const created = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({ kind: "personal", activeShopId: owner.businessId })
    });
    const taskId = created.json<{ conversation: { id: string } }>().conversation.id;

    const resolved = await app.inject({
      method: "GET",
      url: `/v1/runtime/${taskId}`,
      headers: { cookie: owner.cookie }
    });
    const bootstrap = resolved.json<{
      activeHandoff: {
        id: string;
        runtime: { agentId: string; modelId: string; executionHostId: string };
      };
    }>();
    const runtime = bootstrap.activeHandoff.runtime;

    // A client went offline and created two divergent local checkpoints off the same parent.
    // Built once and reused byte-for-byte below (including createdAt) - a real offline client
    // retries the *same* local record, not a freshly re-timestamped one.
    const checkpointsPayload = {
      checkpoints: [
        offlineCheckpoint(
          "branch-a",
          bootstrap.activeHandoff.id,
          runtime,
          "Branch A: tried supplier 1"
        ),
        offlineCheckpoint(
          "branch-b",
          bootstrap.activeHandoff.id,
          runtime,
          "Branch B: tried supplier 2"
        )
      ]
    };
    const sync = await app.inject({
      method: "POST",
      url: `/v1/runtime/${taskId}/checkpoints/sync`,
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify(checkpointsPayload)
    });
    expect(sync.statusCode).toBe(200);
    const syncBody = sync.json<{
      syncedHandoffs: { id: string; checkpointVersion: number }[];
      taskHead: { activeHandoffId: string };
    }>();
    expect(syncBody.syncedHandoffs.map((handoff) => handoff.id)).toEqual(["branch-a", "branch-b"]);
    expect(syncBody.syncedHandoffs[0]?.checkpointVersion).toBe(2);
    expect(syncBody.syncedHandoffs[1]?.checkpointVersion).toBe(3);
    // Sync alone never promotes the head.
    expect(syncBody.taskHead.activeHandoffId).toBe(bootstrap.activeHandoff.id);

    // Retrying the exact same sync is a safe no-op (idempotency for offline batches).
    const retried = await app.inject({
      method: "POST",
      url: `/v1/runtime/${taskId}/checkpoints/sync`,
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify(checkpointsPayload)
    });
    expect(retried.statusCode).toBe(200);
    expect(
      retried
        .json<{ syncedHandoffs: { id: string }[] }>()
        .syncedHandoffs.map((handoff) => handoff.id)
    ).toEqual(["branch-a", "branch-b"]);

    const merge = await app.inject({
      method: "POST",
      url: `/v1/runtime/${taskId}/merge`,
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({
        branchHandoffIds: ["branch-a", "branch-b"],
        currentState: "Compared both suppliers; going with supplier 1.",
        expectedHandoffId: bootstrap.activeHandoff.id
      })
    });
    expect(merge.statusCode).toBe(200);
    const mergeBody = merge.json<{
      handoff: {
        id: string;
        parentHandoffId: string;
        mergedFromHandoffIds: string[];
        currentState: string;
      };
      taskHead: { activeHandoffId: string };
    }>();
    expect(mergeBody.handoff.parentHandoffId).toBe("branch-a");
    expect(mergeBody.handoff.mergedFromHandoffIds).toEqual(["branch-b"]);
    expect(mergeBody.handoff.currentState).toBe("Compared both suppliers; going with supplier 1.");
    expect(mergeBody.taskHead.activeHandoffId).toBe(mergeBody.handoff.id);

    const afterMerge = await app.inject({
      method: "GET",
      url: `/v1/runtime/${taskId}`,
      headers: { cookie: owner.cookie }
    });
    expect(
      afterMerge.json<{ taskHead: { activeHandoffId: string } }>().taskHead.activeHandoffId
    ).toBe(mergeBody.handoff.id);

    await app.close();
  });
});

function offlineCheckpoint(
  id: string,
  parentHandoffId: string,
  runtime: { agentId: string; modelId: string; executionHostId: string },
  currentState: string
) {
  return {
    id,
    parentHandoffId,
    goal: "Find a supplier",
    currentState,
    completedActions: [],
    decisions: [],
    rejectedPaths: [],
    pendingActions: [],
    nextAction: null,
    relevantContext: [],
    artifacts: [],
    tests: { passed: [], failed: [], pending: [] },
    runtime,
    schemaVersion: 1,
    createdAt: new Date().toISOString()
  };
}

async function activateModel(
  app: ReturnType<typeof buildApi>,
  owner: { businessId: string; cookie: string },
  modelId: string,
  options: { skipTest?: boolean } = {}
): Promise<void> {
  if (options.skipTest !== true) {
    const test = await app.inject({
      method: "POST",
      url: `/api/agents/${owner.businessId}/models/${modelId}/test`,
      headers: jsonHeaders(owner.cookie),
      payload: JSON.stringify({ shopId: owner.businessId, executionTarget: "backend" })
    });
    expect(test.statusCode).toBe(200);
  }
  const activation = await app.inject({
    method: "POST",
    url: `/api/agents/${owner.businessId}/models/${modelId}/activate`,
    headers: jsonHeaders(owner.cookie),
    payload: JSON.stringify({
      shopId: owner.businessId,
      executionTarget: "backend" as ModelExecutionTarget,
      executionMode: "LOCAL_FIRST",
      costResponsibility: "merchant",
      permissions: { allowRemoteShopDevice: false }
    })
  });
  expect(activation.statusCode).toBe(200);
}

function healthyAdapter(modelId: string): ModelRuntimeAdapter {
  const executionTarget: ModelExecutionTarget = "backend";
  return {
    provider: "test",
    executionTarget,
    async canRun() {
      return { available: true, errorCode: null, message: null };
    },
    async healthCheck() {
      return {
        available: true,
        modelId,
        provider: "test",
        executionTarget,
        latencyMs: 4,
        responsePreview: "GROGONI_MODEL_OK",
        errorCode: null,
        message: null,
        retryable: false
      };
    },
    async generate({ prompt }: { prompt: RuntimeModelPrompt }) {
      void prompt;
      return {
        text: JSON.stringify({ type: "response", message: "market" }),
        modelId,
        provider: "test",
        executionTarget,
        latencyMs: 8
      };
    }
  };
}

async function createOwnerBusiness(
  app: ReturnType<typeof buildApi>,
  contact: string,
  name: string
): Promise<{ businessId: string; cookie: string }> {
  const signup = await app.inject({
    method: "POST",
    url: "/auth/pin/signup",
    headers: jsonHeaders(),
    payload: JSON.stringify({ method: "phone", contact, pin: "1234" })
  });
  expect(signup.statusCode).toBe(200);
  const cookie = sessionCookie(signup.headers["set-cookie"]);
  const business = await app.inject({
    method: "POST",
    url: "/businesses",
    headers: jsonHeaders(cookie),
    payload: JSON.stringify({ name, language: "en" })
  });
  expect(business.statusCode).toBe(200);
  return {
    businessId: business.json<{ business: { id: string } }>().business.id,
    cookie
  };
}

function jsonHeaders(cookie?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(cookie === undefined ? {} : { cookie })
  };
}

function sessionCookie(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) throw new Error("Expected a session cookie.");
  return value.split(";")[0] ?? value;
}

function initializeRequest() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "grogoni-test", version: "1.0.0" }
    }
  };
}

function toolCall(id: number, name: string, args: Record<string, unknown>) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

async function mcpPost(
  app: FastifyInstance,
  token: string,
  payload: unknown,
  sessionId?: string
): Promise<Awaited<ReturnType<FastifyInstance["inject"]>>> {
  return app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId })
    },
    payload: JSON.stringify(payload)
  });
}

describe("runtime capability and transfer API", () => {
  async function setup() {
    const modelId = "qwen2.5-0.5b-android";
    const adapter = healthyAdapter(modelId);
    const store = createCp2Store({ modelRuntimeAdapterResolver: () => adapter });
    const app = buildApi({ cp2: { store } });
    const owner = await createOwnerBusiness(app, "+254700009777", "Portable runtime");
    await activateModel(app, owner, modelId);
    const response = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      headers: jsonHeaders(owner.cookie),
      payload: { kind: "personal", activeShopId: owner.businessId }
    });
    const taskId = response.json().conversation.id as string;
    const initial = (
      await app.inject({
        method: "GET",
        url: `/v1/runtime/${taskId}`,
        headers: { cookie: owner.cookie }
      })
    ).json();
    return { app, store, owner, taskId, initial, adapter };
  }

  it("returns a specific capability rejection immediately even when the persistence queue is stalled", async () => {
    const f = await setup();
    try {
      const caps = await f.app.inject({
        method: "GET",
        url: `/v1/runtime/${f.taskId}/capabilities`,
        headers: { cookie: f.owner.cookie, "x-grogoni-device-id": "device" }
      });
      expect(caps.json().handoff).toMatchObject({
        available: false,
        supported: false,
        reason: "LOCAL_RUNTIME_NOT_REGISTERED"
      });
      const blocked = buildApi({
        cp2: { store: f.store },
        mutationPersistenceFlush: () => new Promise<void>(() => undefined)
      });
      try {
        const response = await blocked.inject({
          method: "POST",
          url: `/v1/runtime/${f.taskId}/handoffs`,
          headers: {
            ...jsonHeaders(f.owner.cookie),
            "x-grogoni-device-id": "device",
            "idempotency-key": "missing-host"
          },
          payload: {
            targetExecutionHostId: "absent",
            expectedHandoffId: f.initial.activeHandoff.id
          }
        });
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe("NO_EXECUTION_HOST");
        expect(response.body).not.toContain("request took too long");
      } finally {
        await blocked.close();
      }
    } finally {
      await f.app.close();
    }
  });

  it("does not block a pure-read capabilities GET on an unrelated stalled persistence flush, but still blocks the legacy-bootstrapping GET", async () => {
    const f = await setup();
    try {
      // Set up a second, not-yet-resolved task on the *unblocked* app first, so the only request
      // that ever touches the stalled app is the one this test is actually about - otherwise every
      // setup mutation would itself wait out the real persistence-flush deadline.
      const secondOwner = await createOwnerBusiness(f.app, "+254700009778", "Second Shop");
      await activateModel(f.app, secondOwner, "qwen2.5-0.5b-android");
      const conversation = await f.app.inject({
        method: "POST",
        url: "/v1/conversations",
        headers: jsonHeaders(secondOwner.cookie),
        payload: JSON.stringify({ kind: "personal", activeShopId: secondOwner.businessId })
      });
      const secondTaskId = conversation.json<{ conversation: { id: string } }>().conversation.id;

      const previousDeadline = process.env.PERSISTENCE_FLUSH_RESPONSE_DEADLINE_MS;
      process.env.PERSISTENCE_FLUSH_RESPONSE_DEADLINE_MS = "200";
      const blocked = buildApi({
        cp2: { store: f.store },
        mutationPersistenceFlush: () => new Promise<void>(() => undefined)
      });
      try {
        // getRuntimeCapabilities is deliberately excluded from postgres-store.ts's
        // mutatingMethodNames because it never needs to enqueue a save of its own; the response
        // must therefore never wait on some *other* tenant's persistence backlog either, let alone
        // time out into it.
        const caps = await blocked.inject({
          method: "GET",
          url: `/v1/runtime/${f.taskId}/capabilities`,
          headers: { cookie: f.owner.cookie, "x-grogoni-device-id": "device" }
        });
        expect(caps.statusCode).toBe(200);

        // GET .../handoff?version=N calls getRuntimeHandoffByVersion, a pure read of an
        // already-recorded checkpoint - unlike the same path with no query, it never bootstraps,
        // so it must not be swept up by the path-only pattern into waiting on the flush either.
        const byVersion = await blocked.inject({
          method: "GET",
          url: `/v1/runtime/${f.taskId}/handoff?version=1`,
          headers: { cookie: f.owner.cookie }
        });
        expect(byVersion.statusCode).toBe(200);

        // resolveRuntimeHandoff can legacy-bootstrap a checkpoint on first call (a real write), so
        // this GET - unlike capabilities above - must still wait for that write's durability to be
        // confirmed, and time out the same way a mutating request would.
        const resolved = await blocked.inject({
          method: "GET",
          url: `/v1/runtime/${secondTaskId}`,
          headers: { cookie: secondOwner.cookie }
        });
        expect(resolved.statusCode).toBe(503);
        expect(resolved.json().code).toBe("RUNTIME_PERSISTENCE_PENDING");
      } finally {
        await blocked.close();
        if (previousDeadline === undefined)
          delete process.env.PERSISTENCE_FLUSH_RESPONSE_DEADLINE_MS;
        else process.env.PERSISTENCE_FLUSH_RESPONSE_DEADLINE_MS = previousDeadline;
      }
    } finally {
      await f.app.close();
    }
  });

  it("restores a local checkpoint before committing and probes hosted execution before the return", async () => {
    const f = await setup();
    try {
      const snapshot = f.store.snapshot();
      const sourceId = f.initial.activeHandoff.runtime.executionHostId as string;
      const sourceHost = snapshot.nativeExecutionHosts!.find((host) => host.id === sourceId)!;
      const accountId = snapshot.conversations.find((item) => item.id === f.taskId)!.accountId;
      snapshot.nativeExecutionHosts!.push({
        ...sourceHost,
        id: "registered-local",
        type: "remote-shop-device",
        accountId,
        businessId: f.owner.businessId,
        capabilities: [...sourceHost.capabilities, "runtime-handoff-v1"],
        configuration: { deviceId: "device" }
      });
      const installation = snapshot.nativeModelInstallations!.find(
        (item) => item.executionHostId === sourceId
      )!;
      snapshot.nativeModelInstallations!.push({
        ...installation,
        id: "registered-local-model",
        executionHostId: "registered-local"
      });
      f.store.hydrateSnapshot(snapshot);
      const headers = { ...jsonHeaders(f.owner.cookie), "x-grogoni-device-id": "device" };
      expect(
        (
          await f.app.inject({
            method: "POST",
            url: `/v1/runtime/${f.taskId}/hosts/registered-local/heartbeat`,
            headers,
            payload: { connected: true }
          })
        ).statusCode
      ).toBe(200);
      const begin = await f.app.inject({
        method: "POST",
        url: `/v1/runtime/${f.taskId}/handoffs`,
        headers: { ...headers, "idempotency-key": "offline" },
        payload: {
          targetExecutionHostId: "registered-local",
          expectedHandoffId: f.initial.activeHandoff.id
        }
      });
      expect(begin.statusCode).toBe(202);
      const op = begin.json();
      const checkpoint = (
        await f.app.inject({
          method: "GET",
          url: `/v1/runtime/${f.taskId}/handoffs/${op.checkpointId}`,
          headers
        })
      ).json();
      expect(
        (await f.app.inject({ method: "GET", url: `/v1/runtime/${f.taskId}`, headers })).json()
          .activeHandoff.id
      ).toBe(f.initial.activeHandoff.id);
      const completed = await f.app.inject({
        method: "POST",
        url: `/v1/runtime/${f.taskId}/transfers/${op.id}/complete`,
        headers,
        payload: {
          receipt: {
            handoffId: checkpoint.id,
            agentId: checkpoint.runtime.agentId,
            modelId: checkpoint.runtime.modelId,
            harness: true,
            artifacts: true,
            protectedContext: true,
            businessState: true
          }
        }
      });
      expect(completed.json().status).toBe("COMPLETED");
      const back = (
        await f.app.inject({
          method: "POST",
          url: `/v1/runtime/${f.taskId}/handoffs`,
          headers: { ...headers, "idempotency-key": "hosted" },
          payload: { targetExecutionHostId: sourceId, expectedHandoffId: checkpoint.id }
        })
      ).json();
      const healthy = f.adapter.healthCheck;
      f.adapter.healthCheck = async (context) => ({
        ...(await healthy(context)),
        available: false
      });
      const failed = await f.app.inject({
        method: "POST",
        url: `/v1/runtime/${f.taskId}/transfers/${back.id}/complete`,
        headers,
        payload: {}
      });
      expect(failed.json()).toMatchObject({
        status: "FAILED",
        failureCode: "TARGET_ACTIVATION_FAILED"
      });
      expect(
        (await f.app.inject({ method: "GET", url: `/v1/runtime/${f.taskId}`, headers })).json()
          .activeHandoff.id
      ).toBe(checkpoint.id);
      f.adapter.healthCheck = healthy;
      const retry = (
        await f.app.inject({
          method: "POST",
          url: `/v1/runtime/${f.taskId}/handoffs`,
          headers: { ...headers, "idempotency-key": "hosted-retry" },
          payload: { targetExecutionHostId: sourceId, expectedHandoffId: checkpoint.id }
        })
      ).json();
      const returned = await f.app.inject({
        method: "POST",
        url: `/v1/runtime/${f.taskId}/transfers/${retry.id}/complete`,
        headers,
        payload: {}
      });
      expect(returned.json().status).toBe("COMPLETED");
      expect(
        (await f.app.inject({ method: "GET", url: `/v1/runtime/${f.taskId}`, headers })).json()
          .activeHandoff.runtime
      ).toEqual(f.initial.activeHandoff.runtime);
    } finally {
      await f.app.close();
    }
  });
});
