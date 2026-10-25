import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";

/**
 * The durable record of an agent reply that runs after its message's request returned
 * (agent_chat_turns, migration 125; docs/deployment/supabase-edge-api.md, "Agent turns"). Only the
 * Edge API queues turns: the Node API still answers inside the request.
 *
 * Every statement here is a single row update or read. Queue writes made by a worker run on their
 * own short transactions (never the store lock); `enqueue`, `find` and `complete` run inside the
 * request or worker transaction that writes the message or the reply, so a turn and its reply
 * commit together.
 */

export interface TurnQueryable {
  query: <R extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[]
  ) => Promise<{ rows: R[]; rowCount: number | null }>;
}

export type AgentTurnStatus = "pending" | "running" | "completed" | "failed";

/** What a worker needs to run the turn: the agent part of the original POST /v1/messages. */
export interface AgentTurnRequest {
  conversationId: string;
  clientMessageId: string;
  idempotencyKey?: string;
  content: unknown;
  businessId: string;
  message: string;
  runtimeSessionId?: string;
}

export interface AgentTurnRecord {
  id: string;
  messageId: string;
  conversationId: string;
  accountId: string;
  businessId: string;
  sessionId: string | null;
  request: AgentTurnRequest;
  streamTurnId: string | null;
  status: AgentTurnStatus;
  attempts: number;
  maxAttempts: number;
  leaseToken: string | null;
  leaseUntil: string | null;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  retryable: boolean | null;
  createdAt: string;
  updatedAt: string;
}

/** How long a claim lasts without a renewal; a worker renews every third of it. */
export const agentTurnLeaseMs = 30_000;
/** A queued turn nobody claimed after this long lost its dispatch (the isolate went away). */
export const agentTurnUnclaimedMs = 15_000;
/** The recovery job's limit for a turn still queued with nobody polling it. */
export const agentTurnAbandonedMs = 10 * 60_000;
/** Finished turns are kept this long for a client that polls late, then deleted. */
export const agentTurnRetentionDays = 7;

const columns = `id, message_id, conversation_id, account_id, business_id, session_id, request,
  stream_turn_id, status, attempts, max_attempts, lease_token, lease_until, result, error_code,
  retryable, created_at, updated_at`;

function toRecord(row: Record<string, unknown>): AgentTurnRecord {
  const time = (value: unknown) =>
    value instanceof Date ? value.toISOString() : value === null ? null : String(value);
  return {
    id: String(row.id),
    messageId: String(row.message_id),
    conversationId: String(row.conversation_id),
    accountId: String(row.account_id),
    businessId: String(row.business_id),
    sessionId: row.session_id === null ? null : String(row.session_id),
    request: row.request as AgentTurnRequest,
    streamTurnId: row.stream_turn_id === null ? null : String(row.stream_turn_id),
    status: row.status as AgentTurnStatus,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    leaseToken: row.lease_token === null ? null : String(row.lease_token),
    leaseUntil: time(row.lease_until),
    result: (row.result as Record<string, unknown> | null) ?? null,
    errorCode: row.error_code === null ? null : String(row.error_code),
    retryable: row.retryable === null ? null : Boolean(row.retryable),
    createdAt: time(row.created_at) ?? "",
    updatedAt: time(row.updated_at) ?? ""
  };
}

export class AgentTurnLeaseLostError extends Error {
  constructor() {
    super("Another worker took over this agent turn.");
    this.name = "AgentTurnLeaseLostError";
  }
}

export async function findAgentTurnByMessage(
  db: TurnQueryable,
  messageId: string
): Promise<AgentTurnRecord | null> {
  const row = (
    await db.query(`select ${columns} from agent_chat_turns where message_id = $1`, [messageId])
  ).rows[0];
  return row === undefined ? null : toRecord(row);
}

/**
 * Queues the turn of one message. A message has one row for life: queuing it again while it is
 * pending or running returns that row unchanged (a resend never starts a second turn). Queuing a
 * failed one is an explicit retry and makes the same row pending again; so is queuing a completed
 * one, which the store does only when its reply no longer exists (it answers a resend with the
 * stored reply otherwise).
 */
export async function enqueueAgentTurn(
  db: TurnQueryable,
  input: {
    messageId: string;
    conversationId: string;
    accountId: string;
    businessId: string;
    sessionId: string | null;
    request: AgentTurnRequest;
    streamTurnId: string | null;
  }
): Promise<AgentTurnRecord> {
  const inserted = (
    await db.query(
      `insert into agent_chat_turns
         (id, message_id, conversation_id, account_id, business_id, session_id, request, stream_turn_id)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       on conflict (message_id) do update set
         status = 'pending', attempts = 0, lease_token = null, lease_until = null, result = null,
         error_code = null, retryable = null, finished_at = null, session_id = excluded.session_id,
         request = excluded.request, stream_turn_id = excluded.stream_turn_id, updated_at = now()
       where agent_chat_turns.status in ('failed', 'completed')
       returning ${columns}`,
      [
        randomUUID(),
        input.messageId,
        input.conversationId,
        input.accountId,
        input.businessId,
        input.sessionId,
        JSON.stringify(input.request),
        input.streamTurnId
      ]
    )
  ).rows[0];
  if (inserted !== undefined) return toRecord(inserted);
  const existing = await findAgentTurnByMessage(db, input.messageId);
  if (existing === null) throw new Error("The agent turn could not be queued.");
  return existing;
}

/**
 * Claims a turn for one run: a pending turn, or a running one whose worker stopped renewing.
 * Turns of one conversation run in the order their messages arrived, so a turn waits while an
 * earlier one of its conversation is unfinished. Returns null when there is nothing to claim.
 */
export async function claimAgentTurn(
  db: TurnQueryable,
  turnId: string,
  leaseMs = agentTurnLeaseMs
): Promise<AgentTurnRecord | null> {
  const row = (
    await db.query(
      `update agent_chat_turns turn set status = 'running', attempts = turn.attempts + 1,
         lease_token = $2, lease_until = now() + ($3::text || ' milliseconds')::interval,
         updated_at = now()
       where turn.id = $1 and turn.attempts < turn.max_attempts
         and (turn.status = 'pending' or (turn.status = 'running' and turn.lease_until < now()))
         and not exists (
           select 1 from agent_chat_turns earlier
           where earlier.conversation_id = turn.conversation_id and earlier.id <> turn.id
             and earlier.status in ('pending', 'running') and earlier.created_at < turn.created_at)
       returning ${columns}`,
      [turnId, randomUUID(), String(leaseMs)]
    )
  ).rows[0];
  return row === undefined ? null : toRecord(row);
}

/** Renews a claim. False: the lease is gone (taken over or finished); stop working on it. */
export async function renewAgentTurnLease(
  db: TurnQueryable,
  turnId: string,
  leaseToken: string,
  leaseMs = agentTurnLeaseMs
): Promise<boolean> {
  const result = await db.query(
    `update agent_chat_turns set lease_until = now() + ($3::text || ' milliseconds')::interval,
       updated_at = now()
     where id = $1 and lease_token = $2 and status = 'running'`,
    [turnId, leaseToken, String(leaseMs)]
  );
  return (result.rowCount ?? 0) === 1;
}

/**
 * Marks the turn completed in the worker's own transaction, the one that saves the reply. A run
 * whose lease was taken over matches no row and throws, so its transaction (and its reply) rolls
 * back: one turn never commits two replies.
 */
export async function completeAgentTurn(
  db: TurnQueryable,
  turnId: string,
  leaseToken: string,
  result: Record<string, unknown>
): Promise<void> {
  const updated = await db.query(
    `update agent_chat_turns set status = 'completed', result = $3::jsonb, error_code = null,
       retryable = null, lease_token = null, lease_until = null, session_id = null,
       request = request - 'content', finished_at = now(), updated_at = now()
     where id = $1 and lease_token = $2 and status = 'running'`,
    [turnId, leaseToken, JSON.stringify(result)]
  );
  if ((updated.rowCount ?? 0) !== 1) throw new AgentTurnLeaseLostError();
}

/** A failed run, fenced by its lease. False when the lease was already gone. */
export async function failAgentTurn(
  db: TurnQueryable,
  turnId: string,
  leaseToken: string,
  failure: { errorCode: string; retryable: boolean }
): Promise<boolean> {
  const updated = await db.query(
    `update agent_chat_turns set status = 'failed', error_code = $3, retryable = $4,
       lease_token = null, lease_until = null, session_id = null, request = request - 'content',
       finished_at = now(), updated_at = now()
     where id = $1 and lease_token = $2 and status = 'running'`,
    [turnId, leaseToken, failure.errorCode, failure.retryable]
  );
  return (updated.rowCount ?? 0) === 1;
}

/**
 * A turn whose reply exists although the turn did not finish: a run committed the reply on the
 * side (the inventory recipe acknowledges its work independently) and then failed. A resend finds
 * the reply; this records the turn as completed with it, so its poll answers the reply too.
 */
export async function settleAnsweredAgentTurn(
  db: TurnQueryable,
  messageId: string,
  result: Record<string, unknown>
): Promise<void> {
  await db.query(
    `update agent_chat_turns set status = 'completed', result = $2::jsonb, error_code = null,
       retryable = null, lease_token = null, lease_until = null, session_id = null,
       request = request - 'content', finished_at = now(), updated_at = now()
     where message_id = $1 and status in ('pending', 'failed')`,
    [messageId, JSON.stringify(result)]
  );
}

/** The turn as its own account may read it; null for anyone else. */
export async function readAgentTurnForSession(
  db: TurnQueryable,
  turnId: string,
  sessionId: string
): Promise<AgentTurnRecord | null> {
  const row = (
    await db.query(
      `select ${columns.replace(/(^|,\s*)(\w+)/gu, "$1turn.$2")} from agent_chat_turns turn
       join sessions s on s.account_id = turn.account_id
       join accounts a on a.id = s.account_id
       where turn.id = $1 and s.id = $2 and s.revoked_at is null and s.expires_at > now()
         and s.inactivity_expires_at > now() and s.absolute_expires_at > now()
         and a.status = 'active' and a.deleted_at is null`,
      [turnId, sessionId]
    )
  ).rows[0];
  return row === undefined ? null : toRecord(row);
}

/**
 * Recovery for one conversation, run when a client asks about one of its turns. A run that
 * stopped renewing its lease with no attempts left is failed (AGENT_TURN_LOST, retryable). Returns
 * the conversation's first unfinished turn when it needs a worker: a dead run with an attempt left,
 * or a queued turn nobody claimed (its dispatch was lost with its isolate).
 */
export async function recoverConversationTurns(
  db: TurnQueryable,
  conversationId: string,
  unclaimedMs = agentTurnUnclaimedMs
): Promise<string | null> {
  await db.query(
    `update agent_chat_turns set status = 'failed', error_code = 'AGENT_TURN_LOST', retryable = true,
       lease_token = null, lease_until = null, session_id = null, request = request - 'content',
       finished_at = now(), updated_at = now()
     where conversation_id = $1 and status = 'running' and lease_until < now()
       and attempts >= max_attempts`,
    [conversationId]
  );
  const next = (
    await db.query<{ id: string }>(
      `select id from agent_chat_turns
       where conversation_id = $1 and status in ('pending', 'running')
         and ((status = 'running' and lease_until < now())
           or (status = 'pending' and updated_at < now() - ($2::text || ' milliseconds')::interval))
         and not exists (
           select 1 from agent_chat_turns earlier
           where earlier.conversation_id = agent_chat_turns.conversation_id
             and earlier.id <> agent_chat_turns.id and earlier.status in ('pending', 'running')
             and earlier.created_at < agent_chat_turns.created_at)
       order by created_at limit 1`,
      [conversationId, String(unclaimedMs)]
    )
  ).rows[0];
  return next?.id ?? null;
}

/** The next queued turn of a conversation, to start once the one before it finished. */
export async function nextQueuedTurn(
  db: TurnQueryable,
  conversationId: string
): Promise<string | null> {
  const row = (
    await db.query<{ id: string }>(
      `select id from agent_chat_turns where conversation_id = $1 and status = 'pending'
       order by created_at limit 1`,
      [conversationId]
    )
  ).rows[0];
  return row?.id ?? null;
}

/**
 * The hourly safety net (edge job agent_turn_recovery), for turns no client is polling: a run
 * whose lease ended, and a turn queued with nobody to start it, are failed (retryable, so the
 * client's resend runs it again). Finished turns older than the retention are deleted.
 */
export async function sweepAgentTurns(
  db: TurnQueryable,
  abandonedMs = agentTurnAbandonedMs
): Promise<{ failed: number; purged: number }> {
  const failed = await db.query(
    `update agent_chat_turns set status = 'failed', error_code = 'AGENT_TURN_LOST', retryable = true,
       lease_token = null, lease_until = null, session_id = null, request = request - 'content',
       finished_at = now(), updated_at = now()
     where (status = 'running' and lease_until < now())
        or (status = 'pending' and updated_at < now() - ($1::text || ' milliseconds')::interval)`,
    [String(abandonedMs)]
  );
  const purged = await db.query(
    `delete from agent_chat_turns where status in ('completed', 'failed')
       and updated_at < now() - ($1::text || ' days')::interval`,
    [String(agentTurnRetentionDays)]
  );
  return { failed: failed.rowCount ?? 0, purged: purged.rowCount ?? 0 };
}

/** The body a client gets for a turn: the same shape POST /v1/messages answers with. */
export function agentTurnResponse(turn: AgentTurnRecord): Record<string, unknown> {
  if (turn.status === "completed" && turn.result !== null)
    return { ...turn.result, turnId: turn.id };
  return {
    turnId: turn.id,
    id: turn.messageId,
    conversationId: turn.conversationId,
    processing: {
      correlationId: turn.messageId,
      status:
        turn.status === "completed" ? "completed" : turn.status === "failed" ? "failed" : "pending",
      errorCode: turn.status === "failed" ? (turn.errorCode ?? "AGENT_TURN_FAILED") : null,
      retryable: turn.status === "failed" ? (turn.retryable ?? true) : false,
      turnId: turn.id
    }
  };
}
