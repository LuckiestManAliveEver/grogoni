import { isDaemonAgentId, type DaemonAgentId } from "@grogoni/shared-types";
import {
  normalizeAdapterId,
  runtimeAdapterIdForAgent
} from "../agent-harness/agent-runtime-adapter.js";
import { connectedAgentRuntimeAdapterId } from "../agent-harness/retired-agent-runtimes.js";
import type { PoolClient } from "pg";
import type { DaemonPayload } from "@grogoni/shared-types";
import type { DaemonTask } from "./task-store.js";
import type { DaemonExecutor } from "./worker.js";
import type { Cp2Store } from "../cp2/store.js";

export interface DaemonConversationRuntime {
  modelId: string;
  agentAdapterId: DaemonAgentId;
}

/**
 * The model and agent engine a conversation's background tasks run on: whatever its runtime
 * binding resolves to (My Assistant's details choose it). Engines a daemon task cannot run fall
 * back to Grogoni. Throws the store's Cp2Error when the conversation has no usable runtime.
 */
export function daemonConversationRuntime(
  store: Pick<Cp2Store, "resolveRuntimeBinding">,
  conversationId: string
): DaemonConversationRuntime {
  const runtime = store.resolveRuntimeBinding(conversationId);
  const engine = runtimeAdapterIdForAgent(runtime.agent);
  return {
    modelId: runtime.selected.model.id,
    agentAdapterId: isDaemonAgentId(engine) ? engine : "grogoni"
  };
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** $1 owner user id (uuid, validated by the caller), $2 conversation id. The query itself lives in
 *  the SECURITY DEFINER function from migration 132, so the native daemon's role can run it. */
export const conversationTaskRuntimeSql =
  "select engine, model_id from grogoni_conversation_task_runtime($1::uuid, $2)";

/**
 * The same answer for a queued task, read straight from Postgres: one query on the shared pool, no
 * store lock and no snapshot, cheap enough to run on every claim and server execution. Every join
 * is by primary key or an indexed column (users.id is compared as uuid, never cast to text, so its
 * primary key index is used). Only an explicit selection made in My Assistant's details counts,
 * and only while its binding, agent and model are all active, mirroring the store resolver's
 * structural checks; anything else (no selection, conversation gone or not the owner's) returns
 * null and the task keeps the runtime it was created with.
 */
export async function loadConversationTaskRuntime(
  db: { pool: { connect(): Promise<Pick<PoolClient, "query" | "release">> } },
  ownerUserId: string,
  conversationId: string
): Promise<DaemonConversationRuntime | null> {
  if (!uuidPattern.test(ownerUserId)) return null;
  type Row = { engine: string | null; model_id: string | null };
  // Its own short read-only transaction on one pooled connection, so the database itself stops
  // the query at the lookup deadline (statement_timeout) instead of it lingering on the pool. It
  // never runs inside a caller's transaction, which a missing grant would otherwise abort.
  const client = await db.pool.connect();
  let discard = false;
  let row: Row | undefined;
  try {
    await client.query("begin read only");
    await client.query(`set local statement_timeout = ${conversationRuntimeLookupMs}`);
    row = (await client.query<Row>(conversationTaskRuntimeSql, [ownerUserId, conversationId]))
      .rows[0];
    await client.query("commit");
  } catch (error) {
    // A connection whose rollback failed is in an unknown state: never return it to the pool.
    await client.query("rollback").catch(() => {
      discard = true;
    });
    throw error;
  } finally {
    client.release(discard);
  }
  if (!row?.model_id) return null;
  // The same engine normalization as runtimeAdapterIdForAgent (retired engines run on Grogoni).
  let engine: string | null = null;
  try {
    engine =
      row.engine === null ? null : connectedAgentRuntimeAdapterId(normalizeAdapterId(row.engine));
  } catch {
    engine = null;
  }
  return {
    modelId: row.model_id,
    agentAdapterId: isDaemonAgentId(engine) ? engine : "grogoni"
  };
}

/**
 * Wraps an executor so a conversation task runs on its conversation's current runtime: `lookup`
 * reads it (null keeps the task's own), and a runtime `refusal` rejects keeps the task's own too.
 * A failed or slow lookup (past conversationRuntimeLookupMs) never fails or delays the task. Used
 * by the standalone daemon; the Edge lane does the same and also saves the refreshed payload under
 * the lease.
 */
export function executeOnConversationRuntime(
  execute: DaemonExecutor,
  lookup: (task: DaemonTask) => Promise<DaemonConversationRuntime | null>,
  refusal: (payload: DaemonPayload) => string | null,
  /** Called when the lookup fails or times out, so the fallback is visible in the logs. */
  onLookupError: (task: DaemonTask, error: unknown) => void = () => undefined
): DaemonExecutor {
  return async (task, signal) => {
    const payload = task.payload;
    if (payload.kind === "agent" && payload.conversation && task.owner_user_id) {
      const runtime = await withLookupDeadline(lookup(task)).catch((error: unknown) => {
        onLookupError(task, error);
        return null;
      });
      if (runtime !== null) {
        const next: DaemonPayload = { ...payload, ...runtime };
        if (refusal(next) === null) return execute({ ...task, payload: next }, signal);
      }
    }
    return execute(task, signal);
  };
}

/** How long a claim or run waits to learn the conversation's current runtime before going on. */
export const conversationRuntimeLookupMs = 2_000;

/**
 * Resolves the lookup, or rejects once `ms` pass: a slow database must not spend a task's run
 * budget or a browser's fresh lease. The caller then keeps the task's own runtime.
 */
export function withLookupDeadline<T>(
  lookup: Promise<T>,
  ms: number = conversationRuntimeLookupMs
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("conversation runtime lookup timed out")), ms);
  });
  // A lookup that loses the race may still fail later; that failure is already handled here.
  lookup.catch(() => undefined);
  return Promise.race([lookup, deadline]).finally(() => clearTimeout(timer));
}
