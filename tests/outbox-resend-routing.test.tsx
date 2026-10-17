// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError } from "../apps/web/src/lib/api";
import type * as ApiHelpers from "../apps/web/src/api-helpers";
import type { ChatMessage } from "../apps/web/src/app-shell";

vi.mock("../apps/web/src/api-helpers", async () => {
  const actual = await vi.importActual<typeof ApiHelpers>("../apps/web/src/api-helpers");
  return { ...actual, getJson: vi.fn(), postJson: vi.fn(), patchJson: vi.fn(async () => ({})) };
});

const { getJson, patchJson, postJson } = await import("../apps/web/src/api-helpers");
const { useChatInboxState } = await import("../apps/web/src/hooks/useChatInboxState");
const { queueMessagingOutbox, readMessagingOutbox } =
  await import("../apps/web/src/messaging/outbox");

/**
 * The outbox resends failed messages on its own. Three ways that went wrong in review: one
 * message that stopped retrying blocked every later message on the account; a resend finishing
 * after the user switched thread put the old thread's agent reply into the new one (the 4-second
 * interval holds an old render's closure); and a message the server refused for good sat in the
 * thread with no way to get the text back.
 */
describe("outbox resend routing", () => {
  let host: HTMLDivElement;
  let root: Root;
  let inbox: ReturnType<typeof useChatInboxState> | null = null;
  let messages: ChatMessage[] = [];
  let draft = "";
  let sendInFlight = false;
  let statusSink: (message: string) => void = () => undefined;
  const session = {
    account: { id: "account-1" },
    user: { id: "user-1" }
  } as never;

  function Harness() {
    const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
    const [chatDraft, setChatDraft] = useState("");
    messages = chatMessages;
    draft = chatDraft;
    inbox = useChatInboxState({
      business: null,
      session,
      e2eeIdentity: null,
      mode: "seller",
      setStatusMessage: (message) => statusSink(message),
      setView: () => undefined,
      applySessionContextForConversation: async () => null,
      requireMessagingSignIn: () => undefined,
      chatMessages,
      chatDraft,
      isSendInFlight: () => sendInFlight,
      setChatMessages,
      setChatDraft,
      setReplyToMessageId: () => undefined,
      registerReset: () => undefined
    });
    return null;
  }

  const view = (id: string) => ({
    conversation: { id, title: id },
    participants: [{ role: "account", accountId: "account-1" }],
    messages: [
      {
        id: `${id}-first`,
        conversationId: id,
        clientMessageId: `${id}-first-client`,
        author: "account",
        authorId: "user-1",
        content: { type: "text", text: `first in ${id}` },
        createdAt: "2026-10-16T09:00:00Z"
      }
    ]
  });

  const queue = (
    clientMessageId: string,
    conversationId: string,
    attempts = 0,
    nextAttemptAt = 0
  ) =>
    queueMessagingOutbox({
      accountId: "account-1",
      clientMessageId,
      payload: { conversationId, clientMessageId },
      attempts,
      nextAttemptAt
    });

  async function flush() {
    for (let tick = 0; tick < 30; tick++) await Promise.resolve();
  }

  beforeEach(async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    window.matchMedia = ((query: string) => ({ matches: false, media: query })) as never;
    vi.mocked(getJson).mockReset();
    vi.mocked(postJson).mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<Harness />));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("does not let a message that stopped retrying hold up other conversations", async () => {
    queue("stopped-in-a", "A", 3);
    queue("later-in-a", "A");
    queue("due-in-b", "B");
    vi.mocked(postJson).mockRejectedValue(new ApiRequestError(503, "Busy"));
    await act(async () => {
      await inbox!.retryQueuedMessages({ automatic: true });
      await flush();
    });
    const posted = vi.mocked(postJson).mock.calls.map(([, body]) => body.clientMessageId);
    // B is resent; A's later message keeps its place behind A's stopped one.
    expect(posted).toEqual(["due-in-b"]);
  });

  it("never puts a resent reply into the thread opened while it was in flight", async () => {
    let answerB: (value: unknown) => void = () => undefined;
    vi.mocked(getJson).mockImplementation(async (path: string) => {
      if (path === "/v1/conversations/A") return view("A");
      if (path === "/v1/conversations/B")
        return new Promise((resolve) => {
          answerB = resolve;
        });
      throw new Error(`unexpected ${path}`);
    });
    await act(async () => {
      await inbox!.selectConversation("A");
      await flush();
    });
    queue("queued-in-a", "A");
    let answerPost: (value: unknown) => void = () => undefined;
    vi.mocked(postJson).mockImplementation(
      () =>
        new Promise((resolve) => {
          answerPost = resolve;
        }) as never
    );
    let resend: Promise<void> = Promise.resolve();
    await act(async () => {
      resend = inbox!.retryQueuedMessages();
      await flush();
    });
    // The user opens B; B's thread is still loading, so A's view is still the loaded one.
    let opening: Promise<void> = Promise.resolve();
    await act(async () => {
      opening = inbox!.selectConversation("B");
      await flush();
    });
    await act(async () => {
      answerPost({
        id: "server-a",
        conversationId: "A",
        clientMessageId: "queued-in-a",
        author: "account",
        authorId: "user-1",
        content: { type: "text", text: "queued text" },
        agentMessage: {
          id: "agent-a",
          conversationId: "A",
          clientMessageId: "agent-a",
          author: "agent",
          authorId: "agent",
          content: { type: "text", text: "Reply meant for A" }
        }
      });
      await resend;
      await flush();
    });
    expect(messages.map((message) => message.body)).not.toContain("Reply meant for A");
    await act(async () => {
      answerB(view("B"));
      await opening;
      await flush();
    });
    expect(messages.map((message) => message.body)).toEqual(["first in B"]);
    expect(readMessagingOutbox("account-1")).toEqual([]);
  });

  it("gives a refused message's text back to an empty composer and drops it from the queue", async () => {
    vi.mocked(getJson).mockResolvedValue(view("A"));
    await act(async () => {
      await inbox!.selectConversation("A");
      await flush();
    });
    queue("refused", "A");
    // The queued bubble as the send left it.
    const bubble: ChatMessage = {
      id: "refused",
      author: "merchant",
      body: "please add 5 bags",
      status: "failed",
      outboxState: "retrying",
      deviceOnlyIn: "A"
    };
    vi.mocked(getJson).mockResolvedValue({ ...view("A"), messages: [] });
    await act(async () => {
      // Put the bubble on screen through a refresh that carries device-only messages.
      localStorage.setItem(
        "grogoni.device-only-messages.v1:account-1",
        JSON.stringify([{ ...bubble, createdAt: new Date().toISOString() }])
      );
      await inbox!.loadConversationThread("A");
      await flush();
    });
    expect(messages.map((message) => message.body)).toContain("please add 5 bags");
    vi.mocked(postJson).mockRejectedValue(
      new ApiRequestError(400, "Message too long", { code: "validation_failed" })
    );
    await act(async () => {
      await inbox!.retryQueuedMessages();
      await flush();
    });
    expect(messages.map((message) => message.body)).not.toContain("please add 5 bags");
    expect(draft).toBe("please add 5 bags");
    expect(readMessagingOutbox("account-1")).toEqual([]);
  });

  it("on reconnect skips the wait but never the three-try cap", async () => {
    queue("used-up", "A", 3);
    queue("waiting", "B", 1, Date.now() + 60_000);
    vi.mocked(postJson).mockRejectedValue(new ApiRequestError(503, "Busy"));
    await act(async () => {
      await inbox!.retryQueuedMessages({ reconnect: true });
      await flush();
    });
    expect(vi.mocked(postJson).mock.calls.map(([, body]) => body.clientMessageId)).toEqual([
      "waiting"
    ]);
  });

  it("keeps a refused message readable in the thread when its text cannot go back cleanly", async () => {
    vi.mocked(getJson).mockResolvedValue({ ...view("A"), messages: [] });
    await act(async () => {
      await inbox!.selectConversation("A");
      await flush();
    });
    queue("refused-2", "A");
    localStorage.setItem(
      "grogoni.device-only-messages.v1:account-1",
      JSON.stringify([
        {
          id: "refused-2",
          author: "merchant",
          body: "the price list",
          status: "failed",
          outboxState: "retrying",
          deviceOnlyIn: "A",
          createdAt: new Date().toISOString(),
          attachments: [
            {
              id: "f1",
              name: "prices.pdf",
              type: "application/pdf",
              size: 10,
              category: "document"
            }
          ]
        }
      ])
    );
    await act(async () => {
      await inbox!.loadConversationThread("A");
      await flush();
    });
    vi.mocked(postJson).mockRejectedValue(
      new ApiRequestError(400, "Attachment type not allowed", { code: "validation_failed" })
    );
    await act(async () => {
      await inbox!.retryQueuedMessages();
      await flush();
    });
    // An attachment cannot go back into the composer: the message stays, marked not sent.
    expect(messages.find((message) => message.id === "refused-2")).toMatchObject({
      body: "the price list",
      outboxState: "rejected"
    });
    expect(draft).toBe("");
    expect(readMessagingOutbox("account-1")).toEqual([]);
  });

  it("tells the user when a tap cannot run because another tab is sending", async () => {
    queue("waiting", "A");
    const statuses: string[] = [];
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: async (_name: string, _options: unknown, callback: (lock: null) => unknown) =>
          callback(null)
      }
    });
    try {
      statusSink = (message) => statuses.push(message);
      await act(async () => {
        await inbox!.retryQueuedMessages();
      });
      expect(postJson).not.toHaveBeenCalled();
      expect(statuses).toContain("Your waiting messages are being sent from another tab.");
    } finally {
      Reflect.deleteProperty(navigator, "locks");
      statusSink = () => undefined;
    }
  });

  it("puts each resent message's reply right after it, in the order they were typed", async () => {
    vi.mocked(getJson).mockResolvedValue(view("A"));
    await act(async () => {
      await inbox!.selectConversation("A");
      await flush();
    });
    queue("q1", "A");
    queue("q2", "A");
    const at = Date.now();
    localStorage.setItem(
      "grogoni.device-only-messages.v1:account-1",
      JSON.stringify(
        ["q1", "q2"].map((id, index) => ({
          id,
          author: "merchant",
          body: `typed ${id}`,
          status: "failed",
          outboxState: "retrying",
          deviceOnlyIn: "A",
          deviceOnlyAfter: "A-first",
          createdAt: new Date(at + index * 1000).toISOString()
        }))
      )
    );
    await act(async () => {
      await inbox!.loadConversationThread("A");
      await flush();
    });
    vi.mocked(postJson).mockImplementation(async (_path, body) => {
      const id = String((body as { clientMessageId: string }).clientMessageId);
      return {
        id: `server-${id}`,
        conversationId: "A",
        clientMessageId: id,
        author: "account",
        authorId: "user-1",
        content: { type: "text", text: `typed ${id}` },
        agentMessage: {
          id: `reply-${id}`,
          conversationId: "A",
          clientMessageId: `reply-${id}`,
          author: "agent",
          authorId: "agent",
          content: { type: "text", text: `reply to ${id}` }
        }
      } as never;
    });
    await act(async () => {
      await inbox!.retryQueuedMessages();
      await flush();
    });
    expect(messages.map((message) => message.body)).toEqual([
      "first in A",
      "typed q1",
      "reply to q1",
      "typed q2",
      "reply to q2"
    ]);
  });

  it("leaves a conversation URL this account cannot open, so the chat is not stuck opening", async () => {
    window.history.replaceState(null, "", "/workspace/conversations/someone-elses");
    vi.mocked(getJson).mockResolvedValue({ conversations: [] });
    await act(async () => {
      await inbox!.loadMessagingInbox("someone-elses");
      await flush();
    });
    expect(window.location.pathname).not.toContain("someone-elses");
  });

  it("does not mark read while this tab's own send is running, and does once it is done", async () => {
    const unread = {
      ...view("A"),
      participants: [{ role: "account", accountId: "account-1", lastReadAt: null }],
      messages: [
        {
          ...view("A").messages[0],
          author: "agent",
          authorId: "agent",
          readAt: null,
          deletedAt: null
        }
      ]
    };
    vi.mocked(getJson).mockResolvedValue(unread);
    vi.mocked(patchJson).mockClear();
    sendInFlight = true;
    await act(async () => {
      await inbox!.loadConversationThread("A");
      await flush();
    });
    expect(patchJson).not.toHaveBeenCalled();
    sendInFlight = false;
    await act(async () => {
      await inbox!.loadConversationThread("A");
      await flush();
    });
    expect(patchJson).toHaveBeenCalledWith("/v1/conversations/A", { read: true });
  });
});
