import { Cp2Error } from "./cp2/cp2-error.js";
import { readSessionCookie } from "./cp2/store.js";
import {
  AgentTurnLeaseLostError,
  agentTurnLeaseMs,
  agentTurnResponse,
  claimAgentTurn,
  failAgentTurn,
  nextQueuedTurn,
  readAgentTurnForSession,
  recoverConversationTurns,
  renewAgentTurnLease,
  type AgentTurnRecord,
  type TurnQueryable
} from "./edge-agent-turns.js";
import { AttemptNeedsModelCall, type ModelCallLedger } from "./edge-model-deferral.js";
import { ModelRuntimeError } from "./inference/model-runtime.js";

/**
 * Runs queued agent turns on the Edge API (docs/deployment/supabase-edge-api.md, "Agent turns").
 *
 * One run: claim the turn under a lease, renew it every third of the lease, and loop
 *   make the pending model call (no transaction open)  ->  one locked attempt of the turn
 * until an attempt needs no model call it has not got: that attempt saves the reply, the tool
 * calls' writes and the turn's completion in one commit. A lost save race (40001) reruns the
 * attempt (its model calls are replayed, not repeated). Failures mark the turn failed; a run that
 * dies leaves its lease to expire, and the next poll of the turn (or the hourly recovery job)
 * picks it up.
 */

export interface AgentTurnWorkerDeps {
  /** Independent short transactions for queue rows: no store lock, no snapshot. */
  queue: <T>(work: (db: TurnQueryable) => Promise<T>) => Promise<T>;
  /** A short read for the client's poll (the request transaction, rate limited like any read). */
  read: <T>(work: (db: TurnQueryable) => Promise<T>) => Promise<T>;
  /**
   * One locked attempt: resolves once the reply and the turn's completion committed. Rejects with
   * AttemptNeedsModelCall when the ledger got a pending call (the attempt rolled back).
   */
  attempt: (turn: AgentTurnRecord, leaseToken: string, ledger: ModelCallLedger) => Promise<void>;
  newLedger: (streamTurnId: string | null) => ModelCallLedger;
  waitUntil?: (work: Promise<unknown>) => void;
  report: (event: Record<string, unknown>) => void;
  leaseMs?: number;
  /** The whole run, inside Supabase's 150 s wall clock. */
  deadlineMs?: number;
}

export const agentTurnDeadlineMs = 120_000;
const maxSaveConflicts = 3;

function failureOf(error: unknown, timedOut: boolean): { errorCode: string; retryable: boolean } {
  if (timedOut) return { errorCode: "AGENT_TURN_TIMEOUT", retryable: true };
  if (error instanceof AttemptNeedsModelCall)
    return { errorCode: "AGENT_TURN_FAILED", retryable: false };
  if (error instanceof ModelRuntimeError)
    return { errorCode: error.code, retryable: error.retryable };
  if (error instanceof Cp2Error)
    return { errorCode: error.code, retryable: error.retryable ?? error.statusCode >= 500 };
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "40001") return { errorCode: "AGENT_TURN_CONFLICT", retryable: true };
  return { errorCode: "AGENT_TURN_FAILED", retryable: true };
}

export function createAgentTurnWorker(deps: AgentTurnWorkerDeps) {
  const leaseMs = deps.leaseMs ?? agentTurnLeaseMs;
  const deadlineMs = deps.deadlineMs ?? agentTurnDeadlineMs;
  const inFlight = new Set<Promise<void>>();

  function dispatch(turnId: string): void {
    const work = run(turnId).catch((error: unknown) =>
      deps.report({
        event: "agent_turn_worker_failed",
        turnId,
        errorType: error instanceof Error ? error.name : "UnknownError"
      })
    );
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
    deps.waitUntil?.(work);
  }

  async function run(turnId: string): Promise<void> {
    const turn = await deps.queue((db) => claimAgentTurn(db, turnId, leaseMs));
    if (turn === null) return;
    const leaseToken = turn.leaseToken!;
    const started = Date.now();
    const controller = new AbortController();
    let leaseLost = false;
    let timedOut = false;
    const renew = setInterval(() => {
      deps
        .queue((db) => renewAgentTurnLease(db, turnId, leaseToken, leaseMs))
        .then((renewed) => {
          if (!renewed) {
            leaseLost = true;
            controller.abort();
          }
        })
        // A missed renewal is retried at the next tick; the lease outlives two of them.
        .catch(() => {});
    }, leaseMs / 3);
    const deadline = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, deadlineMs);
    const ledger = deps.newLedger(turn.streamTurnId);
    let attempts = 0;
    try {
      for (let conflicts = 0; ;) {
        if (ledger.pending !== null) await ledger.callLive(controller.signal);
        if (controller.signal.aborted) throw new Error("The agent turn stopped.");
        attempts += 1;
        try {
          await deps.attempt(turn, leaseToken, ledger);
          deps.report({
            event: "agent_turn_completed",
            turnId,
            conversationId: turn.conversationId,
            attempt: turn.attempts,
            durationMs: Date.now() - started,
            lockedAttempts: attempts,
            liveModelCalls: ledger.liveCalls,
            replayedModelCalls: ledger.replayed,
            mismatchedModelCalls: ledger.mismatched
          });
          return;
        } catch (error) {
          if (error instanceof AttemptNeedsModelCall && !error.independentWork) continue;
          const independentWork = (error as { independentWork?: unknown }).independentWork === true;
          if (
            (error as { code?: unknown } | null)?.code === "40001" &&
            !independentWork &&
            conflicts < maxSaveConflicts
          ) {
            conflicts += 1;
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      if (leaseLost || error instanceof AgentTurnLeaseLostError) {
        deps.report({ event: "agent_turn_lease_lost", turnId });
        return;
      }
      const failure = failureOf(error, timedOut);
      const recorded = await deps
        .queue((db) => failAgentTurn(db, turnId, leaseToken, failure))
        .catch(() => false);
      deps.report({
        event: "agent_turn_failed",
        turnId,
        conversationId: turn.conversationId,
        ...failure,
        recorded,
        durationMs: Date.now() - started,
        lockedAttempts: attempts,
        liveModelCalls: ledger.liveCalls,
        errorType: error instanceof Error ? error.name : "UnknownError"
      });
    } finally {
      clearInterval(renew);
      clearTimeout(deadline);
      // The conversation's next message waited for this one; start it now.
      const next = await deps
        .queue((db) => nextQueuedTurn(db, turn.conversationId))
        .catch(() => null);
      if (next !== null) dispatch(next);
    }
  }

  /** GET /v1/agent-turns/:turnId. Also restarts a dead or never-started run of its conversation. */
  async function poll(request: Request, turnId: string): Promise<Response> {
    const sessionId = readSessionCookie(request.headers.get("cookie") ?? undefined);
    if (
      sessionId === null ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(turnId)
    )
      return Response.json(
        sessionId === null
          ? { code: "auth_required", message: "Authentication is required." }
          : { code: "agent_turn_not_found", message: "This agent turn was not found." },
        { status: sessionId === null ? 401 : 404 }
      );
    let turn = await deps.read((db) => readAgentTurnForSession(db, turnId, sessionId));
    if (turn === null)
      return Response.json(
        { code: "agent_turn_not_found", message: "This agent turn was not found." },
        { status: 404 }
      );
    if (turn.status === "pending" || turn.status === "running") {
      const conversationId = turn.conversationId;
      const restart = await deps.queue((db) => recoverConversationTurns(db, conversationId));
      if (restart !== null) {
        deps.report({ event: "agent_turn_recovered", turnId: restart, conversationId });
        dispatch(restart);
      }
      turn = (await deps.read((db) => readAgentTurnForSession(db, turnId, sessionId))) ?? turn;
    }
    return Response.json(agentTurnResponse(turn), { headers: { "Cache-Control": "no-store" } });
  }

  return {
    dispatch,
    poll,
    /** Resolves once every run started in this isolate has finished (tests, local runs). */
    settled: async () => {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    }
  };
}

export type AgentTurnWorker = ReturnType<typeof createAgentTurnWorker>;
