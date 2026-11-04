import { describe, expect, it, vi } from "vitest";
import type { DaemonPayload } from "@grogoni/shared-types";
import {
  conversationRuntimeLookupMs,
  executeOnConversationRuntime
} from "./conversation-runtime.js";
import type { DaemonTask } from "./task-store.js";

const conversation = {
  id: "11111111-1111-4111-8111-111111111111",
  clientMessageId: "c",
  scope: "s",
  kind: "reply" as const
};
const task = (payload: DaemonPayload, owner: string | null = "user-a"): DaemonTask => ({
  id: "t",
  idempotency_key: "k",
  payload,
  status: "running",
  run_at: new Date(),
  attempts: 1,
  max_attempts: 3,
  executions: 0,
  lease_token: "l",
  lease_until: new Date(),
  interval_ms: null,
  result: null,
  error_code: null,
  owner_user_id: owner,
  lane: "server",
  created_at: new Date(),
  updated_at: new Date()
});
const agentPayload: DaemonPayload = {
  kind: "agent",
  message: "hi",
  modelId: "old-model",
  agentAdapterId: "grogoni",
  conversation
};

describe("standalone daemon: conversation tasks follow My Assistant's current runtime", () => {
  const run = async (
    input: DaemonTask,
    lookup: () => Promise<{ modelId: string; agentAdapterId: "grogoni" | "pi" } | null>,
    refused: string | null = null
  ) => {
    const ran: DaemonPayload[] = [];
    const execute = executeOnConversationRuntime(
      async (t) => {
        ran.push(t.payload);
        return { ok: true };
      },
      lookup,
      () => refused
    );
    await execute(input, new AbortController().signal);
    return ran[0];
  };

  it("runs on the selection made after the task was created", async () => {
    expect(
      await run(task(agentPayload), async () => ({ modelId: "new-model", agentAdapterId: "pi" }))
    ).toMatchObject({ modelId: "new-model", agentAdapterId: "pi", message: "hi" });
  });

  it("keeps the task's own runtime when there is none, it cannot run, or the lookup fails", async () => {
    expect(await run(task(agentPayload), async () => null)).toEqual(agentPayload);
    expect(
      await run(
        task(agentPayload),
        async () => ({ modelId: "removed", agentAdapterId: "pi" }),
        "MODEL_NOT_CONFIGURED"
      )
    ).toEqual(agentPayload);
    expect(
      await run(task(agentPayload), async () => {
        throw new Error("database unavailable");
      })
    ).toEqual(agentPayload);
  });

  it("reports a failed lookup so the fallback shows in the logs", async () => {
    const reported: unknown[] = [];
    const denied = Object.assign(new Error("permission denied"), { code: "42501" });
    const execute = executeOnConversationRuntime(
      async () => ({ ok: true }),
      async () => {
        throw denied;
      },
      () => null,
      (failed, error) => reported.push([failed.id, error])
    );
    await execute(task(agentPayload), new AbortController().signal);
    expect(reported).toEqual([["t", denied]]);
  });

  it("does not wait past the lookup deadline for a slow database", async () => {
    vi.useFakeTimers();
    try {
      const running = run(task(agentPayload), () => new Promise(() => undefined));
      await vi.advanceTimersByTimeAsync(conversationRuntimeLookupMs);
      expect(await running).toEqual(agentPayload);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never looks up operator tasks, maintenance or tasks without a conversation", async () => {
    let looked = 0;
    const lookup = async () => {
      looked++;
      return { modelId: "x", agentAdapterId: "pi" as const };
    };
    await run(task(agentPayload, null), lookup);
    await run(task({ kind: "maintenance", job: "x" }), lookup);
    await run(
      task({ kind: "agent", message: "hi", modelId: "old-model", agentAdapterId: "grogoni" }),
      lookup
    );
    expect(looked).toBe(0);
  });
});
