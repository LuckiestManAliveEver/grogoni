import type { PoolClient } from "pg";
import { createCp2Store } from "../cp2/store.js";
import { createEdgeSnapshotScope, prepareEdgeHydration } from "../cp2/edge-snapshot-scope.js";
import { loadTransactionalCp2Snapshot } from "../cp2/postgres-store.js";
import { DaemonTaskError } from "./worker.js";
import type { DaemonTask } from "./task-store.js";

/** Read the existing messaging store under the task owner's authority; never copy it into a queue. */
export async function loadDaemonConversationHistory(client: PoolClient, task: DaemonTask) {
  const origin = task.payload.kind === "agent" ? task.payload.conversation : undefined;
  if (!origin) return [];
  if (!task.owner_user_id) throw new DaemonTaskError("CONVERSATION_OWNER_REQUIRED", false);
  const request = new Request(`https://grogoni.com/v1/conversations/${origin.id}`);
  const scope = await createEdgeSnapshotScope(
    client,
    request,
    `/v1/conversations/${origin.id}`,
    undefined,
    { daemonOwnerUserId: task.owner_user_id }
  );
  if (!scope.accountId) throw new DaemonTaskError("CONVERSATION_UNAVAILABLE", false);
  const snapshot = await loadTransactionalCp2Snapshot(client, scope);
  const store = createCp2Store();
  store.hydrateSnapshot(prepareEdgeHydration(snapshot));
  try {
    return store.daemonConversationHistory(
      task.owner_user_id,
      origin.id,
      origin.clientMessageId,
      task.created_at
    );
  } catch {
    throw new DaemonTaskError("CONVERSATION_UNAVAILABLE", false);
  }
}
