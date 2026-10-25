import type { ChatMessage } from "./app-shell";
import type { PublicDaemonTask, DaemonUserTaskResult } from "@grogoni/shared-types";

export function daemonChatResultText(task: PublicDaemonTask, reminderText?: string): string {
  const result = task.result as Partial<DaemonUserTaskResult> | null;
  return task.status === "completed" && typeof reminderText === "string"
    ? `Reminder: ${reminderText}`
    : task.status === "completed" && typeof result?.text === "string"
      ? result.text
      : "The background assistant could not finish this request. Please send it again.";
}

export function daemonChatReply(task: PublicDaemonTask, reminderText?: string): ChatMessage {
  return {
    id: `daemon:${task.id}:${task.executions}`,
    author: "grogoniclaw",
    body: daemonChatResultText(task, reminderText),
    createdAt: task.updatedAt,
    status: "delivered"
  };
}
