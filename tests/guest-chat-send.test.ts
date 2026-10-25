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
  it("shows the guest's own bubble and a typing indicator while the classifier decides", async () => {
    let decide!: (value: Awaited<ReturnType<typeof classifyGuestMessage>>) => void;
    classify.mockReturnValue(new Promise((resolve) => (decide = resolve)));
    const chat = harness();

    const sending = sendGuestMessage(chat.input);
    await Promise.resolve();

    // Still classifying: the bubble is already in the thread, the composer is free again.
    expect(chat.messages.map((message) => [message.author, message.body])).toEqual([
      ["merchant", "sugar"]
    ]);
    expect(chat.order).toEqual(["composer cleared"]);
    expect(isGuestReplyPending("thread-1")).toBe(true);

    decide({ route: { kind: "reply", reply: "Hello!", status: "" }, source: "model" } as never);
    await sending;

    expect(chat.messages.map((message) => message.author)).toEqual(["merchant", "grogoniclaw"]);
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
});
