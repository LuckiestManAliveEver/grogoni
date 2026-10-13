import { describe, expect, it, vi } from "vitest";
import { compileBusinessTask, type BusinessEnvironmentManifest } from "@grogoni/tool-core";
import { executeBusinessTaskRootStep } from "./business-task-execution.js";

const manifest: BusinessEnvironmentManifest = {
  id: "test.inventory",
  version: "1.0.0",
  name: "Inventory",
  description: "Fixture",
  domain: "retail",
  capabilities: ["products.list"],
  observationSchema: {},
  verificationPolicyId: "test.verify",
  evaluationPolicyId: "test.evaluate",
  executionMode: "READ_ONLY",
  status: "ACTIVE"
};
function fixture() {
  const task = compileBusinessTask({
    taskId: "conversation",
    businessId: "business",
    actorId: "actor",
    objective: "Inspect inventory",
    manifest,
    authorizedCapabilities: ["products.list"],
    executionMode: "READ_ONLY",
    constraints: { budgetMinor: null, currency: null, horizonDays: null },
    steps: [
      {
        id: "observe",
        capability: "products.list",
        input: {},
        dependencies: [],
        expectedOutput: "Inventory"
      }
    ],
    now: new Date()
  });
  const events: string[] = [];
  const input = {
    sessionId: "session",
    businessId: "business",
    taskId: task.id,
    stepId: "observe",
    expectedEnvironmentRevision: 2,
    manifest,
    tasks: { get: vi.fn(async () => task) },
    steps: {
      claim: vi.fn(async () => {
        events.push("claim");
        return { claim_id: "claim" };
      }),
      record: vi.fn(async (...args: unknown[]) => {
        events.push("record");
        return args[4];
      })
    },
    runtime: {
      getConversation: vi.fn(() => ({ conversation: { activeShopId: "business" } })),
      createRuntimeTurn: vi.fn(async () => {
        events.push("runtime");
        return {
          turn: {
            id: "turn",
            status: "completed",
            createdAt: new Date().toISOString(),
            context: {},
            toolResult: { items: [] }
          }
        };
      })
    },
    commitRuntime: vi.fn(async () => {
      events.push("commit");
    })
  };
  return {
    input: input as unknown as Parameters<typeof executeBusinessTaskRootStep>[0],
    mocks: input,
    events
  };
}
describe("business task canonical execution composition", () => {
  it("claims before dispatch, awaits durability, and leaves output awaiting independent verification", async () => {
    const { input, mocks, events } = fixture();
    expect(await executeBusinessTaskRootStep(input)).toMatchObject({
      status: "VERIFYING",
      runtimeTurnId: "turn",
      observation: { verificationStatus: "NOT_VERIFIED" }
    });
    expect(events).toEqual(["claim", "runtime", "commit", "record"]);
    expect(mocks.runtime.createRuntimeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conversation",
        plannedStep: expect.objectContaining({ capability: "products.list" })
      })
    );
  });
  it("does not dispatch after a duplicate claim", async () => {
    const { input, mocks } = fixture();
    mocks.steps.claim.mockRejectedValueOnce(new Error("already started"));
    await expect(executeBusinessTaskRootStep(input)).rejects.toThrow("already started");
    expect(mocks.runtime.createRuntimeTurn).not.toHaveBeenCalled();
  });
  it.each(["runtime", "commit"])(
    "retains uncertainty after a %s failure without replay",
    async (failure) => {
      const { input, mocks } = fixture();
      if (failure === "runtime")
        mocks.runtime.createRuntimeTurn.mockRejectedValueOnce(new Error("uncertain"));
      else mocks.commitRuntime.mockRejectedValueOnce(new Error("uncertain"));
      await expect(executeBusinessTaskRootStep(input)).rejects.toThrow("uncertain");
      expect(mocks.steps.record).toHaveBeenCalledWith(
        expect.anything(),
        "conversation",
        "observe",
        "claim",
        expect.objectContaining({ status: "INCONCLUSIVE" })
      );
      expect(mocks.runtime.createRuntimeTurn).toHaveBeenCalledTimes(1);
    }
  );
  it("rejects mismatched conversations and pinned versions before claiming", async () => {
    const { input, mocks } = fixture();
    mocks.runtime.getConversation.mockReturnValueOnce({ conversation: { activeShopId: "other" } });
    await expect(executeBusinessTaskRootStep(input)).rejects.toMatchObject({
      code: "business_task_conversation_mismatch"
    });
    await expect(
      executeBusinessTaskRootStep({ ...input, manifest: { ...manifest, version: "2.0.0" } })
    ).rejects.toMatchObject({ code: "business_task_environment_mismatch" });
    expect(mocks.steps.claim).not.toHaveBeenCalled();
  });
  it("blocks simulation from reaching live domain operations", async () => {
    const { input, mocks } = fixture();
    const task = await mocks.tasks.get();
    task.executionMode = "SIMULATION";
    await expect(executeBusinessTaskRootStep(input)).rejects.toMatchObject({
      code: "business_task_simulation_unavailable"
    });
    expect(mocks.steps.claim).not.toHaveBeenCalled();
  });
});
