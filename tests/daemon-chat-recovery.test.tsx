// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PublicDaemonTask } from "@grogoni/shared-types";
import { useDaemonChatResults } from "../apps/web/src/daemon-chat-results";
import { daemonChatScope, daemonTaskUpdatedEvent } from "../apps/web/src/daemon-chat";

const state = vi.hoisted(() => ({ tasks: [] as PublicDaemonTask[] }));
vi.mock("../apps/web/src/lib/api", () => ({
  apiCloudFetch: async (path: string) =>
    path === "/v1/daemon/tasks"
      ? { tasks: state.tasks }
      : { task: state.tasks.find((task) => path.endsWith(`/${task.id}`)) }
}));
vi.mock("../apps/web/src/offline-runtime", () => ({ isExplicitOfflineMode: () => false }));
let root: Root;
const deliver = vi.fn(async () => {});
const scope = daemonChatScope("marketplace", null, "daemon-a");
function Harness() {
  useDaemonChatResults("account-a", scope, deliver);
  return null;
}
function completed(id: string, originScope = scope): PublicDaemonTask {
  return {
    id,
    key: `chat:${id}`,
    payload: {
      kind: "agent",
      message: "hello",
      modelId: "selected-model",
      agentAdapterId: "grogoni",
      conversation: {
        id: "daemon-a",
        clientMessageId: "client-message-a",
        scope: originScope,
        kind: "reply"
      }
    },
    status: "completed",
    runAt: new Date(0).toISOString(),
    intervalMs: null,
    attempts: 1,
    maxAttempts: 3,
    executions: 1,
    leaseUntil: null,
    result: { text: "A real result would be stored here." },
    errorCode: null,
    lane: "server",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  root = createRoot(document.createElement("div"));
  localStorage.clear();
  state.tasks = [];
  deliver.mockClear();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
});
afterEach(async () => {
  await act(async () => root.unmount());
});
it("recovers completed tasks after local storage loss and delivers only to their original scope", async () => {
  state.tasks = [
    completed("one"),
    completed("other", daemonChatScope("seller", "other-business", "daemon-b"))
  ];
  await act(async () => root.render(<Harness />));
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(deliver.mock.calls[0]).toEqual([
    expect.objectContaining({ conversationId: "daemon-a", clientMessageId: "client-message-a" }),
    expect.objectContaining({ id: "one" })
  ]);
  await act(async () => {
    window.dispatchEvent(new Event(daemonTaskUpdatedEvent));
  });
  expect(deliver).toHaveBeenCalledTimes(1);
});
it("retains a result when message persistence fails and retries delivery on wake", async () => {
  state.tasks = [completed("one")];
  deliver.mockRejectedValueOnce(new Error("temporary persistence outage"));
  await act(async () => root.render(<Harness />));
  await act(async () => {
    window.dispatchEvent(new Event(daemonTaskUpdatedEvent));
  });
  await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
});
