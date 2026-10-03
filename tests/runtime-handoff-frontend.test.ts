import { describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { openLocalDatabase } from "../packages/offline-runtime/db/client";
import { LocalProvider } from "../packages/offline-runtime/providers/local-provider";
import { executeProviderCall } from "../packages/offline-runtime/providers/resolver";
import type { RuntimeHandoff, RuntimeTransfer } from "@grogoni/shared-types";
import type { LocalRuntimeMessage, Scope } from "@grogoni/offline-runtime";
import {
  RuntimeHandoffController,
  type LocalHandoffHost,
  type LocalResumeReceipt,
  type RuntimeHandoffDependencies
} from "../apps/web/src/runtime-handoff-controller";

const scope: Scope = { accountId: "account", storeId: "shop", deviceId: "device" };
const message: LocalRuntimeMessage = {
  id: "message-1",
  role: "user",
  content: "What is in my catalogue?",
  createdAt: "2026-09-12T00:00:00.000Z"
};
const initial: RuntimeHandoff = {
  id: "hosted-1",
  taskId: "conversation",
  conversationId: "conversation",
  parentHandoffId: null,
  mergedFromHandoffIds: [],
  goal: "Help the merchant",
  currentState: "Ready",
  completedActions: [],
  decisions: [],
  rejectedPaths: [],
  pendingActions: [],
  nextAction: null,
  relevantContext: [{ kind: "document", refId: "protected-context" }],
  artifacts: [],
  tests: { passed: [], failed: [], pending: [] },
  runtime: { agentId: "same-agent", modelId: "same-model", executionHostId: "hosted" },
  checkpointVersion: 1,
  schemaVersion: 1,
  createdAt: "2026-09-12T00:00:00.000Z"
};
function receipt(handoff: RuntimeHandoff): LocalResumeReceipt {
  return {
    handoffId: handoff.id,
    agentId: handoff.runtime.agentId,
    modelId: handoff.runtime.modelId,
    harness: true,
    artifacts: true,
    protectedContext: true,
    businessState: true
  };
}

async function fixture() {
  const db = await openLocalDatabase(new IDBFactory());
  let head = structuredClone(initial);
  let seq = 1;
  const transfers = new Map<string, RuntimeTransfer>();
  const checkpoints = new Map<string, RuntimeHandoff>();
  const order: string[] = [];
  const host: LocalHandoffHost = {
    id: "installed-harness",
    executionHostId: "this-device",
    supports: vi.fn(async () => true),
    prepare: vi.fn(async (_scope, handoff) => {
      order.push("local-ready");
      return receipt(handoff);
    }),
    resume: vi.fn(async (_scope, handoff) => {
      order.push("local-resumed");
      return receipt(handoff);
    }),
    turn: vi.fn(async ({ handoff, executeTool }) => {
      const catalogue = await executeTool("catalogue.list", {});
      return {
        reply: {
          id: "reply-1",
          role: "assistant",
          content: JSON.stringify(catalogue),
          createdAt: message.createdAt
        },
        checkpoint: {
          ...handoff,
          id: "local-turn",
          parentHandoffId: handoff.id,
          checkpointVersion: null,
          currentState: "Catalogue answered"
        }
      };
    }),
    syncMessages: vi.fn(async (_scope, _conversation, messages) => {
      order.push("messages-synced");
      return messages.map((item) => item.id);
    })
  };
  const cloud = vi.fn(async (path: string, body?: unknown) => {
    const input = body as
      { targetId?: string; expectedHandoffId?: string; checkpoints?: RuntimeHandoff[] } | undefined;
    if (path.endsWith("/capabilities") || path.endsWith("/heartbeat"))
      return {
        handoff: { available: true, supported: true, reason: null },
        local: [{ executionHostId: "this-device", available: true }],
        hosted: [{ executionHostId: "hosted", available: true }]
      };
    if (path.endsWith("/handoffs")) {
      const target = (body as { targetExecutionHostId: string }).targetExecutionHostId;
      if (input?.expectedHandoffId !== head.id) throw new Error("RuntimeHandoff conflict");
      if (target === head.runtime.executionHostId) throw new Error("The target is already active");
      order.push("checkpoint");
      const checkpoint = {
        ...head,
        id: `cloud-${++seq}`,
        parentHandoffId: head.id,
        checkpointVersion: seq,
        runtime: { ...head.runtime, executionHostId: target }
      };
      checkpoints.set(checkpoint.id, checkpoint);
      const transfer = {
        id: `transfer-${seq}`,
        taskId: "conversation",
        sourceHandoffId: head.id,
        checkpointId: checkpoint.id,
        sourceHostId: head.runtime.executionHostId,
        targetHostId: target,
        status: "TARGET_ACTIVATING",
        failureCode: null,
        message: null
      } as RuntimeTransfer;
      transfers.set(transfer.id, transfer);
      return transfer;
    }
    if (path.includes("/handoffs/")) return checkpoints.get(path.split("/").at(-1)!);
    if (path.includes("/transfers/")) {
      const id = path.split("/transfers/")[1]!.split("/")[0]!;
      const op = transfers.get(id)!;
      if (path.endsWith("/complete") && op.status !== "COMPLETED") {
        order.push(`swap:${op.targetHostId}`);
        head = checkpoints.get(op.checkpointId!)!;
        op.status = "COMPLETED";
      }
      if (path.endsWith("/fail") && op.status !== "COMPLETED") {
        op.status = "FAILED";
        op.message = "Target activation failed";
      }
      return op;
    }
    if (path.endsWith("/checkpoints/sync")) {
      if (input?.expectedHandoffId !== head.id) throw new Error("RuntimeHandoff conflict");
      order.push("checkpoints-synced");
      head = { ...input.checkpoints!.at(-1)!, checkpointVersion: ++seq };
      return { syncedHandoffs: [head], taskHead: { activeHandoffId: head.id } };
    }
    if (path.endsWith("/swaps/host") || path.endsWith("/checkpoints")) {
      if (input?.expectedHandoffId !== head.id) throw new Error("RuntimeHandoff conflict");
      order.push(input.targetId ? `swap:${input.targetId}` : "checkpoint");
      head = {
        ...head,
        id: `cloud-${++seq}`,
        parentHandoffId: head.id,
        checkpointVersion: seq,
        runtime: {
          ...head.runtime,
          executionHostId: input.targetId ?? head.runtime.executionHostId
        }
      };
      return { handoff: head, taskHead: { activeHandoffId: head.id }, activationFailed: false };
    }
    if (path.endsWith("/resume")) {
      order.push("hosted-resumed");
      return {
        activeHandoff: head,
        runtimeInstance: { activeHandoffId: head.id, status: "RUNNING" }
      };
    }
    return { activeHandoff: head, taskHead: { activeHandoffId: head.id } };
  });
  const deps: RuntimeHandoffDependencies = {
    db,
    hosts: () => [host],
    cloud: cloud as RuntimeHandoffDependencies["cloud"],
    prepareBusiness: vi.fn(async () => {
      order.push("business-prepared");
      await db.transaction(scope, (state) => {
        state.installed = true;
        state.rows.push({
          local_id: "rice",
          cloud_id: "rice",
          store_id: scope.storeId,
          collection: "products",
          dirty: false,
          synced_at: null,
          updated_at_local: message.createdAt,
          payload: { id: "rice", businessId: scope.storeId, name: "Rice" }
        });
      });
    }),
    syncBusiness: vi.fn(async () => {
      order.push("business-synced");
    }),
    activate: vi.fn(async (_scope, offline) => {
      order.push(offline ? "route:local" : "route:hosted");
      await db.transaction(scope, (state) => {
        state.offlineModeActive = offline;
      });
    }),
    executeTool: (scope, operation, args) =>
      executeProviderCall(operation, args, [new LocalProvider(db, scope)], {
        online: false,
        offlineModeActive: true,
        localAuthorized: true
      }),
    lock: async (_scope, action) => action(),
    assertAuthorized: vi.fn(),
    changed: vi.fn()
  };
  return {
    db,
    deps,
    host,
    cloud,
    order,
    controller: new RuntimeHandoffController(deps),
    setHead: (value: RuntimeHandoff) => {
      head = value;
    }
  };
}

describe("frontend RuntimeHandoff lifecycle", () => {
  it("does not offer an inference-only or incompatible local runtime", async () => {
    const f = await fixture();
    f.deps.hosts = () => [];
    expect((await f.controller.availability(scope, "conversation")).available).toBe(false);
    expect(f.cloud).toHaveBeenCalledWith("/v1/runtime/conversation/capabilities");
    f.deps.hosts = () => [f.host];
    vi.mocked(f.host.supports).mockResolvedValue(false);
    expect((await f.controller.availability(scope, "conversation")).available).toBe(false);
    await expect(f.controller.goOffline(scope, "conversation", [])).rejects.toThrow(
      "No compatible local runtime"
    );
    expect(f.deps.activate).not.toHaveBeenCalled();
  });

  it("prepares and acknowledges local resume before switching frontend routing", async () => {
    const f = await fixture();
    await f.controller.goOffline(scope, "conversation", [message]);
    expect(f.order).toEqual([
      "checkpoint",
      "business-prepared",
      "local-ready",
      "local-resumed",
      "swap:this-device",
      "route:local"
    ]);
    const session = (await f.db.read(scope)).runtimeHandoffSession!;
    expect(session.handoff.runtime).toEqual({ ...initial.runtime, executionHostId: "this-device" });
    expect(session.handoff.conversationId).toBe("conversation");
    expect(session.messages).toEqual([message]);
    expect(session.handoff.relevantContext).toEqual(initial.relevantContext);
  });

  it.each(["harness", "artifacts", "protectedContext", "businessState"] as const)(
    "keeps hosted execution when %s preparation is incomplete",
    async (field) => {
      const f = await fixture();
      vi.mocked(f.host.prepare).mockImplementation(async (_scope, handoff) => ({
        ...receipt(handoff),
        [field]: false
      }));
      await expect(f.controller.goOffline(scope, "conversation", [])).rejects.toThrow(
        "could not confirm"
      );
      expect(f.order).not.toContain("swap:this-device");
      expect((await f.db.read(scope)).offlineModeActive).toBe(false);
    }
  );

  it("rejects an acknowledgement for a different identity", async () => {
    const f = await fixture();
    vi.mocked(f.host.prepare).mockImplementation(async (_scope, handoff) => ({
      ...receipt(handoff),
      agentId: "another-agent"
    }));
    await expect(f.controller.goOffline(scope, "conversation", [])).rejects.toThrow(
      "could not confirm"
    );
    expect(f.deps.activate).not.toHaveBeenCalled();
  });

  it("saves a failed activation for recovery without claiming the frontend is offline", async () => {
    const f = await fixture();
    vi.mocked(f.host.resume).mockRejectedValue(new Error("Local process stopped"));
    await expect(f.controller.goOffline(scope, "conversation", [])).rejects.toThrow(
      "Local process stopped"
    );
    expect((await f.db.read(scope)).runtimeHandoffSession?.status).toBe("prepared");
    expect(f.deps.activate).not.toHaveBeenCalled();
    await f.controller.goOnline(scope);
    expect(f.order).toContain("route:hosted");
  });

  it("continues the same chat with local catalogue tools and syncs before hosted resume", async () => {
    const f = await fixture();
    await f.controller.goOffline(scope, "conversation", []);
    const localReply = await f.controller.turn(scope, "conversation", message);
    expect(localReply.content).toContain("Rice");
    expect(f.order).toContain("local-resumed");
    await f.controller.goOnline(scope);
    expect(f.order.slice(-7)).toEqual([
      "business-synced",
      "messages-synced",
      "checkpoints-synced",
      "checkpoint",
      "swap:hosted",
      "hosted-resumed",
      "route:hosted"
    ]);
    const session = (await f.db.read(scope)).runtimeHandoffSession!;
    expect(session.messages.map((item) => item.id)).toEqual([message.id, localReply.id]);
    expect(session.pendingMessages).toEqual([]);
    expect(session.handoff.runtime).toEqual(initial.runtime);
    expect(session.handoff.conversationId).toBe(initial.conversationId);
    expect(session.status).toBe("hosted");
  });

  it("fails network-only tools explicitly without calling the cloud", async () => {
    const f = await fixture();
    await f.controller.goOffline(scope, "conversation", []);
    const calls = f.cloud.mock.calls.length;
    vi.mocked(f.host.turn).mockImplementation(async ({ executeTool }) => {
      await executeTool("payments.settle", {});
      throw new Error("must not execute");
    });
    await expect(f.controller.turn(scope, "conversation", message)).rejects.toThrow(
      "unavailable offline"
    );
    expect(f.cloud).toHaveBeenCalledTimes(calls);
    expect((await f.db.read(scope)).runtimeHandoffSession!.messages).toEqual([message]);
  });

  it("refuses a turn in another chat without replacing the active conversation", async () => {
    const f = await fixture();
    await f.controller.goOffline(scope, "conversation", []);
    await expect(f.controller.turn(scope, "different-chat", message)).rejects.toThrow(
      "no active local handoff"
    );
    expect(f.host.turn).not.toHaveBeenCalled();
  });

  it("blocks return while business conflicts remain", async () => {
    const f = await fixture();
    await f.controller.goOffline(scope, "conversation", []);
    await f.db.transaction(scope, (state) => {
      state.conflicts.push({
        id: "conflict",
        operationId: "op",
        collection: "products",
        entityLocalId: "rice",
        message: "Quantity changed",
        local: null,
        server: null
      });
    });
    await expect(f.controller.goOnline(scope)).rejects.toThrow("pending business changes");
    expect((await f.db.read(scope)).offlineModeActive).toBe(true);
    expect(f.order).not.toContain("swap:hosted");
  });

  it("retains unsynced messages and the local branch on partial acknowledgements", async () => {
    const f = await fixture();
    await f.controller.goOffline(scope, "conversation", []);
    await f.controller.turn(scope, "conversation", message);
    vi.mocked(f.host.syncMessages).mockResolvedValue([message.id]);
    await expect(f.controller.goOnline(scope)).rejects.toThrow("events still need syncing");
    const session = (await f.db.read(scope)).runtimeHandoffSession!;
    expect(session.pendingMessages.map((item) => item.id)).toEqual(["reply-1"]);
    expect(session.checkpoints).toHaveLength(1);
    expect(f.order).not.toContain("swap:hosted");
  });

  it("does not overwrite a concurrent device's checkpoint on return", async () => {
    const f = await fixture();
    await f.controller.goOffline(scope, "conversation", []);
    await f.controller.turn(scope, "conversation", message);
    f.setHead({ ...initial, id: "another-device" });
    await expect(f.controller.goOnline(scope)).rejects.toThrow("conflict");
    expect((await f.db.read(scope)).runtimeHandoffSession!.checkpoints).toHaveLength(1);
    expect((await f.db.read(scope)).offlineModeActive).toBe(true);
  });

  it("retains local state if the backend cannot confirm the resumed checkpoint", async () => {
    const f = await fixture();
    await f.controller.goOffline(scope, "conversation", []);
    const original = f.cloud.getMockImplementation()!;
    f.cloud.mockImplementation(async (path, body) =>
      path.endsWith("/resume")
        ? { activeHandoff: initial, runtimeInstance: { status: "FAILED" } }
        : original(path, body)
    );
    await expect(f.controller.goOnline(scope)).rejects.toThrow("not confirmed resume");
    expect((await f.db.read(scope)).offlineModeActive).toBe(true);
    expect((await f.db.read(scope)).runtimeHandoffSession).toBeDefined();
  });

  it("rechecks account authorization after preparing the runtime", async () => {
    const f = await fixture();
    vi.mocked(f.host.prepare).mockImplementation(async (_scope, handoff) => {
      f.deps.assertAuthorized = () => {
        throw new Error("Account signed out");
      };
      return receipt(handoff);
    });
    await expect(f.controller.goOffline(scope, "conversation", [])).rejects.toThrow("signed out");
    expect(f.order).not.toContain("swap:this-device");
  });

  it("recovers a committed offline swap whose response was lost", async () => {
    const f = await fixture();
    const original = f.cloud.getMockImplementation()!;
    let dropped = false;
    f.cloud.mockImplementation(async (path, body) => {
      const result = await original(path, body);
      if (path.endsWith("/complete") && !dropped) {
        dropped = true;
        throw new Error("Response lost");
      }
      return result;
    });
    await expect(f.controller.goOffline(scope, "conversation", [message])).rejects.toThrow(
      "Response lost"
    );
    expect((await f.db.read(scope)).runtimeHandoffSession?.status).toBe("prepared");
    await f.controller.goOnline(scope);
    const state = await f.db.read(scope);
    expect(state.runtimeHandoffSession?.status).toBe("hosted");
    expect(state.runtimeHandoffSession?.messages).toEqual([message]);
    expect(state.offlineModeActive).toBe(false);
  });

  it("retries an interrupted return without discarding the conversation", async () => {
    const f = await fixture();
    await f.controller.goOffline(scope, "conversation", [message]);
    const original = f.cloud.getMockImplementation()!;
    let dropped = false;
    f.cloud.mockImplementation(async (path, body) => {
      const result = await original(path, body);
      if (path.endsWith("/complete") && !dropped) {
        dropped = true;
        throw new Error("Response lost");
      }
      return result;
    });
    await expect(f.controller.goOnline(scope)).rejects.toThrow("Response lost");
    expect((await f.db.read(scope)).offlineModeActive).toBe(true);
    await f.controller.goOnline(scope);
    const state = await f.db.read(scope);
    expect(state.runtimeHandoffSession?.messages).toEqual([message]);
    expect(state.runtimeHandoffSession?.handoff.runtime).toEqual(initial.runtime);
    expect(state.offlineModeActive).toBe(false);
  });
});

it("resumes a committed local handoff after a browser reload and lost completion response", async () => {
  const f = await fixture();
  const original = f.cloud.getMockImplementation()!;
  let lost = false;
  f.cloud.mockImplementation(async (path, body) => {
    const result = await original(path, body);
    if (path.endsWith("/complete") && !lost) {
      lost = true;
      throw new Error("Response lost");
    }
    return result;
  });
  await expect(f.controller.goOffline(scope, "conversation", [message])).rejects.toThrow(
    "Response lost"
  );
  await new RuntimeHandoffController(f.deps).recover(scope);
  const state = await f.db.read(scope);
  expect(state.offlineModeActive).toBe(true);
  expect(state.runtimeHandoffSession?.messages).toEqual([message]);
  expect(f.order.filter((item) => item === "swap:this-device")).toHaveLength(1);
});

it("uses the backend capability reason without attempting checkpoint or activation", async () => {
  const f = await fixture();
  f.deps.hosts = () => [];
  f.cloud.mockResolvedValue({
    handoff: { available: false, supported: false, reason: "LOCAL_RUNTIME_NOT_REGISTERED" },
    local: [],
    hosted: []
  });
  await expect(f.controller.goOffline(scope, "conversation", [])).rejects.toThrow(
    "No compatible local runtime is currently connected"
  );
  expect(f.cloud.mock.calls.map((call) => call[0])).toEqual([
    "/v1/runtime/conversation/capabilities"
  ]);
  expect(f.deps.activate).not.toHaveBeenCalled();
});

it("allows local execution and a new attempt after hosted activation fails", async () => {
  const f = await fixture();
  await f.controller.goOffline(scope, "conversation", [message]);
  const original = f.cloud.getMockImplementation()!;
  let failed = false;
  f.cloud.mockImplementation(async (path, body) => {
    if (path.endsWith("/complete") && !failed) {
      failed = true;
      return { status: "FAILED", message: "Hosted executor offline" };
    }
    return original(path, body);
  });
  await expect(f.controller.goOnline(scope)).rejects.toThrow("Hosted executor offline");
  expect((await f.db.read(scope)).runtimeHandoffSession?.status).toBe("offline");
  await f.controller.goOnline(scope);
  expect((await f.db.read(scope)).offlineModeActive).toBe(false);
});
