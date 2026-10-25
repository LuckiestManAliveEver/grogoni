import type { Dispatch, SetStateAction } from "react";

import type { ChatMessage } from "../app-shell";
import { apiFetch } from "../lib/api";

/**
 * Agent replies that run after their message was accepted (the Edge API: docs/deployment/
 * supabase-edge-api.md, "Agent turns"). POST /v1/messages answers at once with
 * `processing.status = "pending"` and a `turnId`; the reply arrives by polling
 * GET /v1/agent-turns/:turnId, which answers the body the synchronous API answers (agentMessage,
 * runtime, processing) once the turn completed or failed. The Node API answers `completed`
 * directly, and `waitForAgentTurn` passes that through untouched.
 */

interface AgentTurnProcessing {
  correlationId: string;
  status: "completed" | "failed" | "pending";
  errorCode: string | null;
  retryable: boolean;
  turnId?: string;
}

/** The poll waits 1 s, then 2 s, then 4 s between asks. */
export const agentTurnPollDelaysMs = [1000, 1000, 1000, 2000, 2000, 2000, 4000];
/** Longer than the server's own limit for a turn (120 s) plus one recovery. */
export const agentTurnWaitLimitMs = 180_000;

export async function waitForAgentTurn<T extends { id?: string; processing?: AgentTurnProcessing }>(
  response: T,
  options: {
    onPending?: () => void;
    poll?: (turnId: string) => Promise<Partial<T>>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    limitMs?: number;
  } = {}
): Promise<T> {
  const turnId = response.processing?.turnId;
  if (response.processing?.status !== "pending" || turnId === undefined) return response;
  options.onPending?.();
  const poll =
    options.poll ??
    ((id: string) =>
      apiFetch<Partial<T>>(`/v1/agent-turns/${encodeURIComponent(id)}`, { timeoutMs: 15_000 }));
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.limitMs ?? agentTurnWaitLimitMs);
  for (let ask = 0; now() < deadline; ask += 1) {
    await sleep(agentTurnPollDelaysMs[Math.min(ask, agentTurnPollDelaysMs.length - 1)]!);
    let turn: Partial<T>;
    try {
      turn = await poll(turnId);
    } catch {
      // A dropped poll is asked again; the turn keeps running on the server either way.
      continue;
    }
    if (turn.processing !== undefined && turn.processing.status !== "pending")
      return { ...response, ...turn, id: response.id ?? turn.id } as T;
  }
  // Still running after the wait: the outbox resends the same message later, which answers with
  // this same turn (never a second one) or its reply.
  return {
    ...response,
    processing: {
      correlationId: response.processing.correlationId,
      status: "failed",
      errorCode: "AGENT_TURN_WAITING",
      retryable: true,
      turnId
    }
  } as T;
}

const pendingId = (messageId: string) => `agent-turn-pending-${messageId}`;
const failedId = (messageId: string) => `agent-turn-failed-${messageId}`;

/**
 * A placeholder reply right under the message it answers while its turn runs. Kept on this device
 * across the thread's 4-second refreshes (deviceOnlyIn / deviceOnlyAfter), removed when the reply
 * or its failure arrives.
 */
export function showPendingAgentReply(
  setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>,
  conversationId: string,
  messageId: string
): void {
  setChatMessages((messages) => {
    const placeholder: ChatMessage = {
      id: pendingId(messageId),
      author: "grogoniclaw",
      body: "Working on a reply…",
      status: "sending",
      createdAt: new Date().toISOString(),
      deviceOnlyIn: conversationId,
      deviceOnlyAfter: messageId
    };
    const rest = messages.filter(
      (item) => item.id !== placeholder.id && item.id !== failedId(messageId)
    );
    const answered = rest.findIndex((item) => item.id === messageId);
    return answered === -1
      ? [...rest, placeholder]
      : [...rest.slice(0, answered + 1), placeholder, ...rest.slice(answered + 1)];
  });
}

/** A reply that failed: it says so under its message; the outbox resend retries it. */
export function showFailedAgentReply(
  setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>,
  conversationId: string,
  messageId: string,
  text: string
): void {
  setChatMessages((messages) => {
    const notice: ChatMessage = {
      id: failedId(messageId),
      author: "grogoniclaw",
      body: text,
      status: "failed",
      outboxState: "retrying",
      createdAt: new Date().toISOString(),
      deviceOnlyIn: conversationId,
      deviceOnlyAfter: messageId
    };
    const rest = messages.filter(
      (item) => item.id !== pendingId(messageId) && item.id !== notice.id
    );
    const answered = rest.findIndex((item) => item.id === messageId);
    return answered === -1
      ? [...rest, notice]
      : [...rest.slice(0, answered + 1), notice, ...rest.slice(answered + 1)];
  });
}

export function clearAgentReplyPlaceholders(
  setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>,
  messageId: string
): void {
  setChatMessages((messages) =>
    messages.filter((item) => item.id !== pendingId(messageId) && item.id !== failedId(messageId))
  );
}

/** Inserts a reply right after the message it answers (or at the end when that is not shown). */
export function placeReplyAfter(
  messages: ChatMessage[],
  answeredId: string,
  reply: ChatMessage
): ChatMessage[] {
  if (messages.some((item) => item.id === reply.id)) return messages;
  const answered = messages.findIndex((item) => item.id === answeredId);
  return answered === -1
    ? [...messages, reply]
    : [...messages.slice(0, answered + 1), reply, ...messages.slice(answered + 1)];
}
