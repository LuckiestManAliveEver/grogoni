// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../apps/web/src/app-shell";

vi.mock("../apps/web/src/guest-intent-client", () => ({ classifyGuestMessage: vi.fn() }));

const { classifyGuestMessage } = await import("../apps/web/src/guest-intent-client");
const { sendGuestMessage } = await import("../apps/web/src/guest-chat-send");
const { isGuestReplyPending } = await import("../apps/web/src/guest-reply-pending");
const { readDeviceOnlyMessages } = await import("../apps/web/src/chat-device-only-messages");

const classify = vi.mocked(classifyGuestMessage);

function harness() {
  let messages: ChatMessage[] = [];
  const order: string[] = [];
  return {
    get messages() {
      return messages;
    },
    order,
    input: {
      message: "sugar",
      accountId: "guest-1",
      mode: "marketplace",
      activeConversationId: "thread-1",
      chatMessages: [] as ChatMessage[],
      setChatMessages: (update: (current: ChatMessage[]) => ChatMessage[]) => {
        messages = update(messages);
      },
      isOpen: () => true,
      searchBuyFeed: vi.fn(async () => null),
      // The conversational model's answer: a guest's chat shows only the model's own words.
      askModel: vi.fn<
        (
          message: string,
          clientMessageId: string
        ) => Promise<{ text: string } | { note: string } | null>
      >(async () => ({ text: "Hello!" })),
      afterBubble: () => order.push("composer cleared"),
      navigateToMarketplace: vi.fn(),
      setStatusMessage: vi.fn()
    }
  };
}

beforeEach(() => {
  localStorage.clear();
  classify.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a guest's message", () => {
  it("shows the guest's own bubble and a typing indicator while the answer is worked out", async () => {
    let decide!: (value: { text: string }) => void;
    classify.mockResolvedValue({
      route: { kind: "reply", reply: "Tell me what you need.", status: "" },
      source: "rules",
      // The classifier could not answer: the rules' explanation is not the model's words.
      fallback: "error"
    } as never);
    const chat = harness();
    chat.input.askModel = vi.fn(() => new Promise((resolve) => (decide = resolve)));

    const sending = sendGuestMessage(chat.input);
    await Promise.resolve();

    // Still waiting on the model: the bubble is already in the thread, the composer is free again.
    expect(chat.messages.map((message) => [message.author, message.body])).toEqual([
      ["merchant", "sugar"]
    ]);
    expect(chat.order).toEqual(["composer cleared"]);
    expect(isGuestReplyPending("thread-1")).toBe(true);

    decide({ text: "Hello!" });
    await sending;

    // The reply is the model's own words, not the app's explanation.
    expect(chat.messages.map((message) => [message.author, message.body])).toEqual([
      ["merchant", "sugar"],
      ["grogoniclaw", "Hello!"]
    ]);
    expect(isGuestReplyPending("thread-1")).toBe(false);
    // Both are kept on the device, in order, for a refresh or a trip to another thread.
    expect(readDeviceOnlyMessages("guest-1").map((message) => message.author)).toEqual([
      "merchant",
      "grogoniclaw"
    ]);
  });

  it("still answers, and ends the typing indicator, when the search fails", async () => {
    classify.mockResolvedValue({
      route: { kind: "search", query: "sugar" },
      source: "model"
    } as never);
    const chat = harness();
    chat.input.searchBuyFeed = vi.fn(async () => {
      throw new Error("offline");
    });

    await sendGuestMessage(chat.input);

    expect(chat.messages.map((message) => message.author)).toEqual(["merchant", "grogoniclaw"]);
    expect(isGuestReplyPending("thread-1")).toBe(false);
  });
  it("queues the visible bubble's ID and leaves only one bubble for an asynchronous reply", async () => {
    classify.mockResolvedValue({
      route: { kind: "reply", reply: "Scripted help", status: "help" },
      source: "model",
      fallback: null
    });
    const chat = harness();
    chat.input.askModel.mockResolvedValue({ note: "Assistant is thinking…" });
    await sendGuestMessage(chat.input);
    expect(chat.input.askModel).toHaveBeenCalledWith("sugar", chat.messages[0]!.id);
    expect(chat.messages).toHaveLength(1);
    expect(isGuestReplyPending("thread-1")).toBe(false);
  });

  it.each([null, { text: "   " }])(
    "reports model unavailability for %j instead of scripted copy",
    async (answer) => {
      classify.mockResolvedValue({
        route: { kind: "search", query: "Explain why a rainbow forms" },
        source: "rules",
        fallback: "error"
      });
      const chat = harness();
      chat.input.askModel.mockResolvedValue(answer);
      await sendGuestMessage(chat.input);
      expect(chat.input.searchBuyFeed).not.toHaveBeenCalled();
      expect(chat.messages[1]!.body).toBe("I couldn't reach the assistant. Please try again.");
      expect(isGuestReplyPending("thread-1")).toBe(false);
    }
  );
});
