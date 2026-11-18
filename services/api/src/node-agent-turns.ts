import { randomUUID } from "node:crypto";
import type { Cp2Store } from "./cp2/store.js";
import { Cp2Error } from "./cp2/cp2-error.js";
import type {
  AgentTurnQueue,
  AgentConversationMessageResult
} from "./cp2/domains/messaging/shared.js";
import type { ConversationMessageContent } from "@grogoni/shared-types";
import {
  agentTurnResponse,
  claimAgentTurn,
  completeAgentTurn,
  enqueueAgentTurn,
  failAgentTurn,
  findAgentTurnByMessage,
  readAgentTurnForSession,
  renewAgentTurnLease,
  settleAnsweredAgentTurn,
  type AgentTurnRecord,
  type TurnQueryable
} from "./edge-agent-turns.js";

type EnqueueInput = Parameters<AgentTurnQueue["enqueue"]>[0];
type DurableStore = Cp2Store & { flush?: () => Promise<void>; agentTurnDatabase?: TurnQueryable };

/** Node acceptance uses the same durable queue and leases as Edge. Persist the message before
 * queuing, acknowledge only once both writes succeed, and flush replies before completing turns. */
export function createNodeAgentTurns(
  store: DurableStore,
  onError?: (error: unknown, turnId: string) => void
) {
  const db = store.agentTurnDatabase;
  const staged = new Map<string, EnqueueInput>();
  const memory = new Map<string, AgentTurnRecord>();
  const running = new Set<string>();
  const work = new Set<Promise<void>>();
  let closed = false;
  const queue: AgentTurnQueue = {
    find: async (messageId) =>
      db
        ? findAgentTurnByMessage(db, messageId)
        : ([...memory.values()].find((turn) => turn.messageId === messageId) ?? null),
    enqueue: async (input) => {
      staged.set(input.messageId, input);
      return { id: input.messageId, status: "pending" };
    },
    settle: async (messageId, result) => {
      if (db) await settleAnsweredAgentTurn(db, messageId, result);
      else {
        const turn = [...memory.values()].find((row) => row.messageId === messageId);
        if (turn) {
          turn.status = "completed";
          turn.result = result;
        }
      }
    }
  };
  store.setAgentTurnQueue(queue);
  async function accept(
    processed: AgentConversationMessageResult
  ): Promise<AgentConversationMessageResult> {
    if (processed.processing.status !== "pending") return processed;
    await store.flush?.();
    const input = staged.get(processed.message.id);
    let turn: AgentTurnRecord | null = null;
    if (input) {
      if (db) turn = await enqueueAgentTurn(db, { ...input, streamTurnId: "node" });
      else {
        turn = [...memory.values()].find((row) => row.messageId === input.messageId) ?? null;
        if (!turn || turn.status === "completed" || turn.status === "failed") {
          const at = new Date().toISOString();
          turn = {
            ...input,
            id: turn?.id ?? randomUUID(),
            request: input.request,
            streamTurnId: "node",
            status: "pending",
            attempts: 0,
            maxAttempts: 2,
            leaseToken: null,
            leaseUntil: null,
            result: null,
            errorCode: null,
            retryable: null,
            createdAt: at,
            updatedAt: at
          };
          memory.set(turn.id, turn);
        }
      }
      staged.delete(processed.message.id);
    } else
      turn = db
        ? await findAgentTurnByMessage(db, processed.message.id)
        : (memory.get(processed.processing.turnId ?? "") ?? null);
    if (!turn)
      throw new Cp2Error(
        503,
        "agent_queue_unavailable",
        "The agent request could not be queued. Retry the same message."
      );
    dispatch(turn.id);
    return { ...processed, processing: { ...processed.processing, turnId: turn.id } };
  }
  function dispatch(id: string) {
    if (closed || running.has(id)) return;
    running.add(id);
    const task = run(id)
      .catch(() => undefined)
      .finally(() => {
        running.delete(id);
        work.delete(task);
      });
    work.add(task);
  }
  async function run(id: string) {
    const turn = db ? await claimAgentTurn(db, id) : memory.get(id);
    if (!turn || (!db && turn.status !== "pending")) return;
    // The SQL claim enforces conversation order. In memory, later turns wait behind earlier ones.
    if (
      !db &&
      [...memory.values()].find(
        (row) =>
          row.conversationId === turn.conversationId &&
          (row.status === "pending" || row.status === "running")
      )?.id !== id
    )
      return;
    const lease = turn.leaseToken ?? randomUUID();
    turn.status = "running";
    const renewal = db
      ? setInterval(() => {
          void renewAgentTurnLease(db, id, lease).catch(() => undefined);
        }, 10_000)
      : null;
    renewal?.unref();
    try {
      const result = await store.createAgentConversationMessage({
        ...turn.request,
        content: turn.request.content as ConversationMessageContent,
        sessionId: turn.sessionId,
        runQueuedTurn: true,
        replyRightAfterMessage: true
      });
      await store.flush?.();
      const response = {
        ...result.message,
        agentMessage: result.agentMessage,
        runtime: result.runtime,
        processing: result.processing
      };
      if (db) await completeAgentTurn(db, id, lease, response);
      else {
        turn.status = result.processing.status === "failed" ? "failed" : "completed";
        turn.result = response;
      }
    } catch (error) {
      onError?.(error, id);
      const code = error instanceof Cp2Error ? error.code : "AGENT_TURN_FAILED";
      if (db)
        await failAgentTurn(db, id, lease, {
          errorCode: code,
          retryable: !(error instanceof Cp2Error) || error.statusCode >= 500
        }).catch(() => undefined);
      else {
        turn.status = "failed";
        turn.errorCode = code;
        turn.retryable = true;
      }
    } finally {
      if (renewal) clearInterval(renewal);
      if (db && !closed) {
        const next = await db
          .query<{ id: string }>(
            "select id from agent_chat_turns where stream_turn_id = 'node' and conversation_id = $1 and status = 'pending' order by created_at, id limit 1",
            [turn.conversationId]
          )
          .catch(() => ({ rows: [] }));
        for (const row of next.rows) dispatch(row.id);
      } else if (!db)
        for (const row of memory.values())
          if (row.conversationId === turn.conversationId && row.status === "pending")
            dispatch(row.id);
    }
  }
  async function poll(id: string, sessionId: string | null) {
    const actor = store.getSession(sessionId);
    if (!actor || !sessionId)
      throw new Cp2Error(401, "session_required", "Sign in to read this reply.");
    const turn = db ? await readAgentTurnForSession(db, id, sessionId) : memory.get(id);
    if (!turn || turn.accountId !== actor.account.id)
      throw new Cp2Error(404, "agent_turn_not_found", "This agent turn was not found.");
    if (turn.status === "pending" || turn.status === "running") dispatch(id);
    return agentTurnResponse(turn);
  }
  const recovery = setInterval(() => {
    if (db)
      void db
        .query<{ id: string }>(
          "select id from agent_chat_turns where stream_turn_id = 'node' and (status = 'pending' or (status = 'running' and lease_until < now())) order by created_at limit 50"
        )
        .then((result) => {
          for (const row of result.rows) dispatch(row.id);
        })
        .catch(() => undefined);
  }, 10_000);
  recovery.unref();
  return {
    accept,
    poll,
    close: async () => {
      closed = true;
      clearInterval(recovery);
      await Promise.allSettled(work);
    }
  };
}
