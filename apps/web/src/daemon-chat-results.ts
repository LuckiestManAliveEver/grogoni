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
    // Tasks this device has already pulled from the server. Recovery is a one-shot on mount (see
    // below); after that first poll each restarting poll fetches only these ids, so a quiet account
    // with no background work never calls the daemon task endpoints at all.
    const recoveredIds = new Set<string>();
    let recoveredOnce = false;
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
        // a reinstall), so it runs once and then only for tasks learned about since. Polling the
        // whole task list on every tick made an idle, freshly opened account issue a daemon request
        // it has no work behind - the first chat message then raced a second call.
        try {
          const { tasks } = recoveredOnce
            ? (
                await Promise.all(
                  [...recoveredIds]
                    .filter((taskId) => !entries.has(taskId))
                    .map((taskId) =>
                      apiCloudFetch<{ task: PublicDaemonTask }>(
                        `/v1/daemon/tasks/${encodeURIComponent(taskId)}`
                      )
                        .then((response) => response.task)
                        .catch(() => null)
                    )
                )
              )
                .filter((task): task is PublicDaemonTask => task !== null)
                .reduce<{ tasks: PublicDaemonTask[] }>(
                  (acc, task) => ({ tasks: [...acc.tasks, task] }),
                  { tasks: [] }
                )
            : await apiCloudFetch<{ tasks: PublicDaemonTask[] }>("/v1/daemon/tasks");
          if (!recoveredOnce) recoveredOnce = true;
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
    const wake = () => {
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
