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

/** Poll only tasks this browser submitted, including results finished by the server while closed. */
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
        for (const entry of readChatDaemonTasks(accountId!)) {
          if (stopped) break;
          if (entry.scope !== scope) continue;
          const dueIn = Date.parse(entry.runAt) - Date.now();
          if (dueIn > 1000) {
            delay = Math.min(delay, dueIn);
            continue;
          }
          delay = 5000;
          try {
            const { task } = await apiCloudFetch<{ task: PublicDaemonTask }>(
              `/v1/daemon/tasks/${encodeURIComponent(entry.taskId)}`
            );
            if (stopped) break;
            if (["completed", "failed", "cancelled"].includes(task.status)) {
              await latest.current(entry, task);
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
