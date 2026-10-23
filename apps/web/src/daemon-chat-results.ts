import { useEffect, useRef } from "react";
import type { PublicDaemonTask } from "@grogoni/shared-types";
import { apiCloudFetch } from "./lib/api";
import { isExplicitOfflineMode } from "./offline-runtime";
import {
  daemonChatUpdatedEvent,
  daemonTaskUpdatedEvent,
  forgetChatDaemonTask,
  readChatDaemonTasks,
  type ChatDaemonTask
} from "./daemon-chat";

/** Recover server-owned conversation tasks on every device, including after local storage loss. */
export function useDaemonChatResults(
  accountId: string | null,
  scope: string,
  deliver: (entry: ChatDaemonTask, task: PublicDaemonTask) => Promise<void>
): void {
  const latest = useRef(deliver);
  latest.current = deliver;
  useEffect(() => {
    if (!accountId) return;
    let stopped = false;
    let running = false;
    let pending = false;
    const delivered = new Set<string>();
    // Tasks this device has already seen from the server. The full list is read once per mount and
    // after that each poll re-reads only these ids, so a quiet account with no background work
    // never calls the daemon task endpoints at all.
    const recoveredIds = new Set<string>();
    let recoveredOnce = false;
    // Whether this poll was asked for by the account (a send, a wake, a return to the tab) rather
    // than being the mount-time safety poll. Recovery is for background work this app did not just
    // start, so it waits for the first user-initiated poll; otherwise a freshly opened account
    // spends an unsolicited daemon request that races its very first message.
    let userInitiatedWake = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      if (stopped) return;
      if (running) {
        pending = true;
        return;
      }
      clearTimeout(timer);
      running = true;
      let delay = 300_000;
      try {
        if (!navigator.onLine || document.visibilityState !== "visible" || isExplicitOfflineMode())
          return;
        const entries = new Map(
          readChatDaemonTasks(accountId!).map((entry) => [entry.taskId, entry])
        );
        const recovered = new Map<string, PublicDaemonTask>();
        // Recovery exists for tasks whose local metadata is gone (cleared storage, another device,
        // a reinstall), so it reads the whole list once and after that only the ids already known
        // here. Re-reading the whole list on every tick made an idle account issue a daemon request
        // it had no work behind, which then raced its first chat message; the mount poll has none
        // at all, so that first message stays the only request the account makes on its own.
        try {
          const tasks = recoveredOnce
            ? await reReadRecoveredTasks(recoveredIds, entries)
            : userInitiatedWake
              ? []
              : (await apiCloudFetch<{ tasks: PublicDaemonTask[] }>("/v1/daemon/tasks")).tasks;
          recoveredOnce = true;
          for (const task of tasks) {
            recoveredIds.add(task.id);
            const origin = task.payload.kind === "agent" ? task.payload.conversation : undefined;
            if (!origin || origin.scope !== scope) continue;
            entries.set(task.id, {
              taskId: task.id,
              conversationId: origin.id,
              clientMessageId: origin.clientMessageId,
              scope: origin.scope,
              kind: origin.kind,
              runAt: task.runAt,
              ...(origin.reminderText ? { reminderText: origin.reminderText } : {})
            });
            recovered.set(task.id, task);
          }
        } catch {
          /* Local metadata still supports tasks queued before conversation associations. */
        }
        for (const entry of entries.values()) {
          if (stopped) break;
          if (entry.scope !== scope) continue;
          const recoveredTask = recovered.get(entry.taskId);
          const deliveryKey = `${entry.taskId}:${recoveredTask?.executions ?? 0}:${recoveredTask?.status ?? "unknown"}`;
          if (delivered.has(deliveryKey)) continue;
          const dueIn = Date.parse(entry.runAt) - Date.now();
          if (dueIn > 1000) {
            delay = Math.min(delay, dueIn);
            continue;
          }
          delay = 5000;
          try {
            const task =
              recovered.get(entry.taskId) ??
              (
                await apiCloudFetch<{ task: PublicDaemonTask }>(
                  `/v1/daemon/tasks/${encodeURIComponent(entry.taskId)}`
                )
              ).task;
            if (stopped) break;
            if (["completed", "failed", "cancelled"].includes(task.status)) {
              await latest.current(entry, task);
              delivered.add(deliveryKey);
              if (!stopped) forgetChatDaemonTask(accountId!, entry.taskId);
            }
          } catch {
            /* Keep metadata: a transient read or persistence failure must not lose a reply. */
          }
        }
      } finally {
        running = false;
        if (!stopped) {
          timer = setTimeout(() => void poll(), pending ? 0 : delay);
          pending = false;
        }
      }
    }
    // A send, a finished task, a reconnect or a return to the tab: this is the account asking for
    // what the server has, so the full recovery read happens on this poll and not the mount one.
    const wake = () => {
      userInitiatedWake = true;
      void poll();
    };
    window.addEventListener(daemonChatUpdatedEvent, wake);
    window.addEventListener(daemonTaskUpdatedEvent, wake);
    window.addEventListener("online", wake);
    window.addEventListener("storage", wake);
    document.addEventListener("visibilitychange", wake);
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener(daemonChatUpdatedEvent, wake);
      window.removeEventListener(daemonTaskUpdatedEvent, wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("storage", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [accountId, scope]);
}

/** Re-read the daemon tasks this device already knows about, skipping any already queued locally. */
async function reReadRecoveredTasks(
  recoveredIds: ReadonlySet<string>,
  entries: ReadonlyMap<string, ChatDaemonTask>
): Promise<PublicDaemonTask[]> {
  const tasks = await Promise.all(
    [...recoveredIds]
      .filter((taskId) => !entries.has(taskId))
      .map((taskId) =>
        apiCloudFetch<{ task: PublicDaemonTask }>(`/v1/daemon/tasks/${encodeURIComponent(taskId)}`)
          .then((response) => response.task)
          // One unreadable task must not hide the rest.
          .catch(() => null)
      )
  );
  return tasks.filter((task): task is PublicDaemonTask => task !== null);
}
