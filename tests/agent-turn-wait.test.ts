import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../apps/web/src/app-shell";
import {
  clearAgentReplyPlaceholders,
  placeReplyAfter,
  showFailedAgentReply,
  showPendingAgentReply,
  waitForAgentTurn
} from "../apps/web/src/messaging/agent-turn";

const pending = {
  id: "m1",
  processing: {
    correlationId: "m1",
    status: "pending" as const,
    errorCode: null,
    retryable: false,
    turnId: "t1"
  }
};

function stateOf(initial: ChatMessage[]) {
  let messages = initial;
  const set = (next: ChatMessage[] | ((current: ChatMessage[]) => ChatMessage[])) => {
    messages = typeof next === "function" ? next(messages) : next;
  };
  return { set, get: () => messages };
}

describe("waiting for an agent reply that runs after its message", () => {
  it("passes a synchronous answer through without polling", async () => {
    const poll = vi.fn();
    const done = { id: "m1", processing: { ...pending.processing, status: "completed" as const } };
    expect(await waitForAgentTurn(done, { poll })).toBe(done);
    expect(poll).not.toHaveBeenCalled();
  });

  it("polls until the turn completes and returns the reply in the synchronous shape", async () => {
    const onPending = vi.fn();
    const answers = [
      pending,
      new Error("network"),
      {
        agentMessage: { id: "r1" },
        processing: { ...pending.processing, status: "completed" as const }
      }
    ];
    const poll = vi.fn(async () => {
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next as never;
    });
    const sleeps: number[] = [];
    const result = await waitForAgentTurn(pending, {
      poll,
      onPending,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 0
    });
    expect(onPending).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledWith("t1");
    expect(result).toMatchObject({ id: "m1", agentMessage: { id: "r1" } });
    expect(result.processing?.status).toBe("completed");
    // The first ask goes out at once; a quick pending answer and a dropped ask each back off.
    expect(sleeps).toEqual([1000, 1000]);
  });

  it("asks again at once after a server held the poll open (long poll)", async () => {
    let clock = 0;
    const answers = [
      pending,
      pending,
      {
        agentMessage: { id: "r1" },
        processing: { ...pending.processing, status: "completed" as const }
      }
    ];
    const sleeps: number[] = [];
    const result = await waitForAgentTurn(pending, {
      poll: async () => {
        clock += 10_000; // the server held each ask for its full wait
        return answers.shift() as never;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock
    });
    expect(result).toMatchObject({ agentMessage: { id: "r1" } });
    expect(sleeps).toEqual([]);
  });

  it("backs off the full step after a failed ask, however long it took", async () => {
    let clock = 0;
    const answers: unknown[] = [
      new Error("timeout"),
      { processing: { ...pending.processing, status: "completed" as const } }
    ];
    const sleeps: number[] = [];
    await waitForAgentTurn(pending, {
      poll: async () => {
        clock += 900; // the failed ask took most of its step
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return next as never;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock
    });
    expect(sleeps).toEqual([1000]);
  });

  it("only sleeps what is left of the step after a partial hold", async () => {
    let clock = 0;
    const answers = [
      pending,
      { processing: { ...pending.processing, status: "completed" as const } }
    ];
    const sleeps: number[] = [];
    await waitForAgentTurn(pending, {
      poll: async () => {
        clock += 300;
        return answers.shift() as never;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock
    });
    expect(sleeps).toEqual([700]);
  });

  it("long-polls the turn route with a wait the client timeout outlasts", async () => {
    vi.resetModules();
    const apiFetch = vi.fn(async () => ({
      processing: { ...pending.processing, status: "completed" as const }
    }));
    vi.doMock("../apps/web/src/lib/api", () => ({ apiFetch }));
    const fresh = await import("../apps/web/src/messaging/agent-turn");
    await fresh.waitForAgentTurn(pending, { sleep: async () => {} });
    expect(apiFetch).toHaveBeenCalledWith(
      `/v1/agent-turns/t1?waitMs=${fresh.agentTurnLongPollWaitMs}`,
      { timeoutMs: fresh.agentTurnLongPollWaitMs + 15_000 }
    );
    vi.doUnmock("../apps/web/src/lib/api");
  });

  it("returns a failed turn as failed, with its code", async () => {
    const result = await waitForAgentTurn(pending, {
      poll: async () => ({
        processing: {
          ...pending.processing,
          status: "failed" as const,
          errorCode: "AGENT_TURN_LOST",
          retryable: true
        }
      }),
      sleep: async () => {}
    });
    expect(result.processing).toMatchObject({ status: "failed", errorCode: "AGENT_TURN_LOST" });
  });

  it("hands a turn still running after the wait to the outbox as retryable", async () => {
    let clock = 0;
    const result = await waitForAgentTurn(pending, {
      poll: async () => pending,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      limitMs: 10_000
    });
    expect(result.processing).toMatchObject({
      status: "failed",
      errorCode: "AGENT_TURN_WAITING",
      retryable: true,
      turnId: "t1"
    });
  });
});

describe("pending and failed reply bubbles", () => {
  const base: ChatMessage[] = [
    { id: "m1", author: "merchant", body: "hi" },
    { id: "m2", author: "merchant", body: "later" }
  ];

  it("shows the pending reply right under its message, kept across refreshes", () => {
    const state = stateOf(base);
    showPendingAgentReply(state.set, "c1", "m1");
    expect(state.get().map((item) => item.id)).toEqual(["m1", "agent-turn-pending-m1", "m2"]);
    expect(state.get()[1]).toMatchObject({
      author: "grogoniclaw",
      status: "sending",
      deviceOnlyIn: "c1",
      deviceOnlyAfter: "m1"
    });
  });

  it("replaces the pending bubble with a failure notice, then clears both", () => {
    const state = stateOf(base);
    showPendingAgentReply(state.set, "c1", "m1");
    showFailedAgentReply(state.set, "c1", "m1", "The reply failed.");
    expect(state.get().map((item) => item.id)).toEqual(["m1", "agent-turn-failed-m1", "m2"]);
    expect(state.get()[1]).toMatchObject({ status: "failed", body: "The reply failed." });
    clearAgentReplyPlaceholders(state.set, "m1");
    expect(state.get().map((item) => item.id)).toEqual(["m1", "m2"]);
  });

  it("puts a late reply after the message it answers, once", () => {
    const reply: ChatMessage = { id: "r1", author: "grogoniclaw", body: "answer" };
    const placed = placeReplyAfter(base, "m1", reply);
    expect(placed.map((item) => item.id)).toEqual(["m1", "r1", "m2"]);
    expect(placeReplyAfter(placed, "m1", reply)).toBe(placed);
    expect(placeReplyAfter(base, "missing", reply).map((item) => item.id)).toEqual([
      "m1",
      "m2",
      "r1"
    ]);
  });
});
