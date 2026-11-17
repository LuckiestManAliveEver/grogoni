import { describe, expect, it } from "vitest";
import type { AgentTurnRecord } from "../services/api/src/edge-agent-turns";
import {
  agentTurnPollMaxWaitMs,
  createAgentTurnWorker,
  readPollWaitMs
} from "../services/api/src/edge-agent-turn-worker";

/**
 * GET /v1/agent-turns/:id?waitMs= holds open while the turn runs, so the reply leaves the server the
 * moment it is saved instead of at the client's next 1/2/4 s poll. These drive the worker's poll
 * with injected reads; edge-async-agent-turns.test.ts covers the same route on PostgreSQL.
 */

const turnId = "11111111-2222-4333-8444-555555555555";
const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function record(status: AgentTurnRecord["status"]): AgentTurnRecord {
  return {
    id: turnId,
    messageId: "m1",
    conversationId: "c1",
    accountId: "a1",
    businessId: "b1",
    sessionId,
    request: {
      conversationId: "c1",
      clientMessageId: "cm1",
      content: { type: "text", text: "hi" },
      businessId: "b1",
      message: "hi"
    },
    streamTurnId: null,
    status,
    attempts: 1,
    maxAttempts: 3,
    leaseToken: null,
    leaseUntil: null,
    result:
      status === "completed"
        ? { agentMessage: { id: "r1" }, processing: { status: "completed" } }
        : null,
    errorCode: null,
    retryable: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}

function claimRow() {
  const turn = record("running");
  return {
    id: turn.id,
    message_id: turn.messageId,
    conversation_id: turn.conversationId,
    account_id: turn.accountId,
    business_id: turn.businessId,
    session_id: turn.sessionId,
    request: turn.request,
    stream_turn_id: null,
    status: "running",
    attempts: 1,
    max_attempts: 3,
    lease_token: "lease-1",
    lease_until: new Date(Date.now() + 30_000),
    result: null,
    error_code: null,
    retryable: null,
    created_at: new Date(0),
    updated_at: new Date(0)
  };
}

function harness(options: {
  pollRecheckMs: number;
  pollMaxRecheckMs?: number;
  /** A live run in this isolate: claims the turn, then its attempt waits for `release()`. */
  liveRun?: boolean;
}) {
  const state = {
    turn: record("running") as AgentTurnRecord | null,
    reads: 0,
    /** Delays the run's cleanup queue work (starting the next turn) once the reply committed. */
    slowCleanupMs: 0,
    committed: false
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const worker = createAgentTurnWorker({
    // The poll's reads return the current row.
    read: async () => {
      state.reads += 1;
      return state.turn as never;
    },
    // Queue work: a live run's claim gets the row; recovery and next-turn lookups find nothing.
    queue: async (work) =>
      work({
        query: async (sql: string) => {
          if (options.liveRun && sql.includes("set status = 'running'"))
            return { rows: [claimRow()], rowCount: 1 } as never;
          if (state.committed && state.slowCleanupMs > 0)
            await new Promise((resolve) => setTimeout(resolve, state.slowCleanupMs));
          return { rows: [], rowCount: 0 } as never;
        }
      }),
    attempt: async () => {
      await gate;
      state.turn = record("completed");
      state.committed = true;
    },
    newLedger: () =>
      ({
        pending: null,
        liveCalls: 0,
        replayed: 0,
        mismatched: 0,
        callLive: async () => {}
      }) as never,
    report: () => {},
    pollRecheckMs: options.pollRecheckMs,
    ...(options.pollMaxRecheckMs === undefined
      ? {}
      : { pollMaxRecheckMs: options.pollMaxRecheckMs })
  });
  const poll = async (query: string, signal?: AbortSignal) => {
    const started = Date.now();
    const response = await worker.poll(
      new Request(`https://grogoni.com/v1/agent-turns/${turnId}${query}`, {
        headers: { cookie: `grogoni_session=${sessionId}` },
        ...(signal ? { signal } : {})
      }),
      turnId
    );
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
      ms: Date.now() - started
    };
  };
  return { state, worker, poll, release };
}

describe("long-polling an agent turn", () => {
  it("answers at once without waitMs, as before", async () => {
    const t = harness({ pollRecheckMs: 50 });
    const { body, ms } = await t.poll("");
    expect(body.processing).toMatchObject({ status: "pending" });
    expect(ms).toBeLessThan(1000);
    // The read plus the existing recovery re-read of an unfinished turn; no wait loop.
    expect(t.state.reads).toBe(2);
  });

  it("holds the poll until a run in another isolate finishes, then answers the reply", async () => {
    const t = harness({ pollRecheckMs: 50 });
    setTimeout(() => (t.state.turn = record("completed")), 180);
    const { body, ms } = await t.poll("?waitMs=5000");
    expect(body).toMatchObject({ agentMessage: { id: "r1" }, turnId });
    // Answered within a recheck or two of the finish, not at the end of the 5 s wait.
    expect(ms).toBeGreaterThanOrEqual(170);
    expect(ms).toBeLessThan(2000);
  });

  it("wakes at once when the run ends in this isolate, without waiting for a recheck", async () => {
    const t = harness({ pollRecheckMs: 60_000 });
    setTimeout(() => {
      t.state.turn = record("completed");
      // The worker's run for this turn ends here (its claim finds nothing): that wakes the poll.
      t.worker.dispatch(turnId);
    }, 100);
    const { body, ms } = await t.poll("?waitMs=5000");
    expect(body).toMatchObject({ agentMessage: { id: "r1" } });
    expect(ms).toBeLessThan(2000);
    await t.worker.settled();
  });

  it("answers pending when the wait ends with the turn still running", async () => {
    const t = harness({ pollRecheckMs: 50 });
    const { body, ms } = await t.poll("?waitMs=250");
    expect(body.processing).toMatchObject({ status: "pending" });
    expect(ms).toBeGreaterThanOrEqual(240);
    expect(ms).toBeLessThan(2000);
  });

  it("answers a failed turn as soon as it fails", async () => {
    const t = harness({ pollRecheckMs: 50 });
    setTimeout(
      () => (t.state.turn = { ...record("failed"), errorCode: "AGENT_TURN_TIMEOUT" }),
      100
    );
    const { body } = await t.poll("?waitMs=5000");
    expect(body.processing).toMatchObject({ status: "failed", errorCode: "AGENT_TURN_TIMEOUT" });
  });

  it("stops waiting when the client goes away", async () => {
    // A recheck longer than the test: only the abort listener can end this wait early.
    const t = harness({ pollRecheckMs: 60_000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 120);
    const { ms } = await t.poll("?waitMs=5000", controller.signal);
    expect(ms).toBeLessThan(2000);
  });

  it("backs its re-reads off, so a full hold costs a handful of reads", async () => {
    const t = harness({ pollRecheckMs: 100, pollMaxRecheckMs: 400 });
    const { body } = await t.poll("?waitMs=1500");
    expect(body.processing).toMatchObject({ status: "pending" });
    // Re-reads at about 100, 300, 700, 1100 and 1500 ms (a fixed 100 ms tick would make 15),
    // plus the first read and the recovery re-read before the hold.
    expect(t.state.reads).toBeLessThanOrEqual(8);
  });

  it("does not poll the row of a turn this isolate is running, and answers as soon as it commits", async () => {
    // Production recheck settings (400 ms doubling to 2 s): the 2 s cap is the only re-read bound.
    const t = harness({ pollRecheckMs: 400, liveRun: true });
    t.worker.dispatch(turnId);
    await new Promise((resolve) => setTimeout(resolve, 20)); // the run has claimed the turn
    // The run's cleanup after its commit (lease timers, the next turn) is slow here.
    t.state.slowCleanupMs = 3000;
    setTimeout(() => t.release(), 600);
    const { body, ms } = await t.poll("?waitMs=8000");
    expect(body).toMatchObject({ agentMessage: { id: "r1" } });
    // Woken by the commit itself (about 600 ms): not at the 2 s cap and not after the 3 s cleanup.
    expect(ms).toBeLessThan(1500);
    // The first read, the recovery re-read and the read after the wake. The other-isolate path
    // would have re-read at 400 ms as well.
    expect(t.state.reads).toBe(3);
    await t.worker.settled();
  }, 15_000);

  it("answers not found when the turn stops being visible mid-wait", async () => {
    const t = harness({ pollRecheckMs: 50 });
    setTimeout(() => (t.state.turn = null), 120);
    const { status, body } = await t.poll("?waitMs=5000");
    expect(status).toBe(404);
    expect(body).toMatchObject({ code: "agent_turn_not_found" });
  });

  it("measures the hold from the request's arrival, not from after recovery work", async () => {
    let first = true;
    // The first read takes 400 ms (a slow pool connect); the hold still ends 600 ms after arrival.
    const started = Date.now();
    const delayed = createAgentTurnWorker({
      read: async () => {
        if (first) {
          first = false;
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        return record("running") as never;
      },
      queue: async () => null as never,
      attempt: async () => {},
      newLedger: () => {
        throw new Error("no run expected");
      },
      report: () => {},
      pollRecheckMs: 50
    });
    await delayed.poll(
      new Request(`https://grogoni.com/v1/agent-turns/${turnId}?waitMs=600`, {
        headers: { cookie: `grogoni_session=${sessionId}` }
      }),
      turnId
    );
    const ms = Date.now() - started;
    expect(ms).toBeGreaterThanOrEqual(590);
    expect(ms).toBeLessThan(950);
  });

  it("caps and validates waitMs", () => {
    const base = `https://grogoni.com/v1/agent-turns/${turnId}`;
    expect(readPollWaitMs(base)).toBe(0);
    expect(readPollWaitMs(`${base}?waitMs=2500`)).toBe(2500);
    expect(readPollWaitMs(`${base}?waitMs=999999`)).toBe(agentTurnPollMaxWaitMs);
    expect(readPollWaitMs(`${base}?waitMs=-5`)).toBe(0);
    expect(readPollWaitMs(`${base}?waitMs=1e9`)).toBe(0);
    expect(readPollWaitMs(`${base}?waitMs=abc`)).toBe(0);
    expect(readPollWaitMs("not a url")).toBe(0);
  });
});
