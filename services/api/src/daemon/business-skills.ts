import type { Cp2Snapshot } from "../cp2/store.js";
import { createCp2Store } from "../cp2/store.js";
import type { DaemonTask } from "./task-store.js";
import { DaemonTaskError } from "./worker.js";

/** Queue-owned identity is only a lookup key. The normal message route rechecks the live session
 * and business membership; no new principal, service-wide tool grant or execution engine is created. */
export async function executeDaemonBusinessSkill(input: {
  task: DaemonTask;
  businessId: string;
  message: string;
  signal: AbortSignal;
  load: () => Promise<Cp2Snapshot>;
  send: (request: Request) => Promise<Response | null>;
}) {
  const { task } = input;
  if (!task.owner_user_id || task.payload.kind !== "agent" || !task.payload.conversation)
    throw new DaemonTaskError("SKILL_OWNER_CONTEXT_REQUIRED", false);
  const origin = task.payload.conversation;
  const snapshot = await input.load();
  const store = createCp2Store();
  store.hydrateSnapshot(snapshot);
  store.daemonConversationHistory(
    task.owner_user_id,
    origin.id,
    origin.clientMessageId,
    task.created_at
  );
  const session = snapshot.sessions.find(
    (s) =>
      s.userId === task.owner_user_id && s.pinVerifiedAt !== null && store.getSession(s.id) !== null
  );
  if (!session) throw new DaemonTaskError("SKILL_SESSION_REQUIRED", false);
  input.signal.throwIfAborted();
  const response = await input.send(
    new Request("https://grogoni.com/v1/messages", {
      method: "POST",
      signal: input.signal,
      headers: { cookie: `grogoni_session=${session.id}`, "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: origin.id,
        clientMessageId:
          Number(task.executions) > 0
            ? `daemon-skill:${task.id}:${task.executions}`
            : origin.clientMessageId,
        content: { type: "text", text: task.payload.message },
        agent: { businessId: input.businessId, message: input.message }
      })
    })
  );
  if (!response || !response.ok) throw new DaemonTaskError("BUSINESS_SKILL_REJECTED", false);
  const result = (await response.json()) as {
    agentMessage?: { content?: { text?: string; prompt?: string } };
    processing?: { status?: string };
    runtime?: unknown;
  };
  const text = result.agentMessage?.content?.text ?? result.agentMessage?.content?.prompt;
  if (!text || result.processing?.status !== "completed")
    throw new DaemonTaskError("BUSINESS_SKILL_FAILED", false);
  return {
    completion: {
      status: "available",
      outputText: JSON.stringify({ type: "response", message: text })
    }
  };
}
