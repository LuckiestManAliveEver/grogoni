import { beforeEach, expect, it, vi } from "vitest";
import { askGuestModel } from "../apps/web/src/guest-model-send";
import { postJson } from "../apps/web/src/api-helpers";
import { submitChatDaemonTask } from "../apps/web/src/daemon-chat";

vi.mock("../apps/web/src/api-helpers", () => ({ postJson: vi.fn() }));
vi.mock("../apps/web/src/daemon-chat", () => ({ submitChatDaemonTask: vi.fn() }));

const input = {
  accountId: "guest",
  conversationId: "thread",
  scope: "guest-thread",
  clientMessageId: "visible-bubble",
  message: "Remember ALPHA",
  history: []
};

beforeEach(() => vi.resetAllMocks());

it("persists the guest question before the daemon can load conversation history", async () => {
  let saved = false;
  vi.mocked(postJson).mockImplementation(async () => {
    saved = true;
    return {} as never;
  });
  vi.mocked(submitChatDaemonTask).mockImplementation(async () => {
    expect(saved).toBe(true);
    return {} as never;
  });
  expect(await askGuestModel(input)).toEqual({ note: "Assistant is thinking…" });
  expect(postJson).toHaveBeenCalledWith("/v1/messages", {
    conversationId: "thread",
    clientMessageId: "visible-bubble",
    content: { type: "text", text: "Remember ALPHA" }
  });
  expect(submitChatDaemonTask).toHaveBeenCalledWith(input);
});

it("does not queue a model turn when the guest question could not be saved", async () => {
  vi.mocked(postJson).mockRejectedValue(new Error("offline"));
  expect(await askGuestModel(input)).toBeNull();
  expect(submitChatDaemonTask).not.toHaveBeenCalled();
});
