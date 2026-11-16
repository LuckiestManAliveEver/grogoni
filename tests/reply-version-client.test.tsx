// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { ConversationMessageSummary } from "../packages/shared-types/src";

const api = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; body: Record<string, unknown>; signal?: AbortSignal }>,
  next: (async () => ({})) as (call: { signal?: AbortSignal }) => Promise<unknown>
}));
vi.mock("../apps/web/src/api-helpers", () => ({
  postJson: (
    path: string,
    body: Record<string, unknown>,
    options: { signal?: AbortSignal } = {}
  ) => {
    const call = { path, body, signal: options.signal };
    api.calls.push(call);
    return api.next(call);
  },
  putJson: async (path: string, body: Record<string, unknown>) => {
    api.calls.push({ path, body });
    return {};
  }
}));

import type { ChatMessage } from "../apps/web/src/app-shell";
import { ApiRequestError } from "../apps/web/src/lib/api";
import { useReplyVersions } from "../apps/web/src/features/reply-versions/useReplyVersions";
import { mapConversationMessage } from "../apps/web/src/chat-message-plumbing";
import {
  RegenerateMenuItem,
  ReplyVersionRow,
  ReplyVersionSwitcher
} from "../apps/web/src/features/reply-versions/ReplyVersionSwitcher";
import {
  canOfferRegenerate,
  createReplyVersionRequests,
  forgetReplyVersionRequests,
  regenerationRefusalMessage,
  replyVersionStorageKey,
  sharedReplyVersionRequests,
  type ReplyVersionControls
} from "../apps/web/src/features/reply-versions/reply-version-requests";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The web side of reply versions (docs/architecture/conversation-reply-versions.md). */

function render(props: Parameters<typeof ReplyVersionSwitcher>[0]) {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(createElement(ReplyVersionSwitcher, props)));
  return { container, root, unmount: () => act(() => root.unmount()) };
}

describe("ReplyVersionSwitcher", () => {
  it("renders nothing for a reply with one version", () => {
    const view = render({ selected: 0, count: 1, busy: false, onSelect: vi.fn() });
    expect(view.container.innerHTML).toBe("");
    view.unmount();
  });

  it("names its controls, announces the position, and stops at both ends", () => {
    const onSelect = vi.fn();
    const view = render({ selected: 0, count: 3, busy: false, onSelect });
    const group = view.container.querySelector('[role="group"]')!;
    expect(group.getAttribute("aria-label")).toBe("Reply versions");
    expect(group.querySelector('[aria-live="polite"]')!.textContent).toBe("Version 1 of 3");
    const previous = group.querySelector<HTMLButtonElement>('[aria-label="Previous version"]')!;
    const next = group.querySelector<HTMLButtonElement>('[aria-label="Next version"]')!;
    expect(previous.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    act(() => next.click());
    expect(onSelect.mock.calls).toEqual([[1]]);
    view.unmount();

    const last = render({ selected: 2, count: 3, busy: false, onSelect });
    expect(
      last.container.querySelector<HTMLButtonElement>('[aria-label="Next version"]')!.disabled
    ).toBe(true);
    last.unmount();
  });

  it("locks both controls while a version is being written", () => {
    const view = render({ selected: 1, count: 3, busy: true, onSelect: vi.fn() });
    for (const button of view.container.querySelectorAll("button"))
      expect(button.disabled).toBe(true);
    view.unmount();
  });
});

describe("regenerate retry keys", () => {
  it("reuses the id of a request that never settled and issues a new one after it settles", () => {
    let next = 0;
    const requests = createReplyVersionRequests(() => `version-id-${(next += 1)}`);
    expect(requests.idFor("reply-a")).toBe("version-id-1");
    expect(requests.idFor("reply-a")).toBe("version-id-1");
    expect(requests.idFor("reply-b")).toBe("version-id-2");
    requests.settle("reply-a");
    expect(requests.idFor("reply-a")).toBe("version-id-3");
    expect(requests.idFor("reply-b")).toBe("version-id-2");
  });

  it("explains every refusal the server can repeat, and leaves other errors to the caller", () => {
    for (const code of [
      "regeneration_would_act",
      "reply_version_limit",
      "reply_not_regenerable",
      "reply_regeneration_forbidden"
    ])
      expect(regenerationRefusalMessage(code)).toMatch(/\.$/u);
    expect(regenerationRefusalMessage("MODEL_UNAVAILABLE")).toBeNull();
    expect(regenerationRefusalMessage(null)).toBeNull();
  });
});

describe("mapping a server reply to the chat thread", () => {
  const session = { account: { id: "account-1" }, user: { id: "user-1" } } as Parameters<
    typeof mapConversationMessage
  >[2];
  const reply: ConversationMessageSummary = {
    id: "reply-1",
    conversationId: "conversation-1",
    clientMessageId: "agent-reply-question-1",
    idempotencyKey: "grogoni-agent-reply:question-1",
    author: "agent",
    authorId: "account-account-1-agent",
    content: { type: "text", text: "Second answer." },
    replyToMessageId: "question-1",
    agentTurnEffect: "none",
    clientTimestamp: null,
    createdAt: "2026-11-13T08:00:00.000Z"
  };

  it("offers Regenerate only for an eligible reply and shows the selected version", () => {
    expect(mapConversationMessage(reply, [], session)).toMatchObject({ regenerable: true });
    expect(mapConversationMessage(reply, [], session).replyVersions).toBeUndefined();

    const versioned = mapConversationMessage(
      {
        ...reply,
        replyVersions: {
          selected: 1,
          versions: [
            { id: "original", text: "First answer.", createdAt: reply.createdAt },
            { id: "version-0002", text: "Second answer.", createdAt: reply.createdAt }
          ]
        }
      },
      [],
      session
    );
    expect(versioned).toMatchObject({
      body: "Second answer.",
      regenerable: true,
      replyVersions: { selected: 1, count: 2 }
    });

    for (const ineligible of [
      { ...reply, agentTurnEffect: "action" as const },
      { ...reply, agentTurnEffect: undefined },
      { ...reply, author: "user" as const },
      { ...reply, deletedAt: "2026-11-13T09:00:00.000Z" },
      {
        ...reply,
        content: { type: "confirmation" as const, confirmationToken: "token", prompt: "Sell?" }
      }
    ])
      expect(mapConversationMessage(ineligible, [], session).regenerable).toBeUndefined();
  });
});

const question: ChatMessage = { id: "question-1", author: "merchant", body: "Any ideas?" };
const answerMessage: ChatMessage = {
  id: "reply-1",
  author: "grogoniclaw",
  body: "Second answer.",
  replyToMessageId: "question-1",
  regenerable: true,
  replyVersions: { selected: 1, count: 2 }
};
const controlsFor = (overrides: Partial<ReplyVersionControls> = {}): ReplyVersionControls => ({
  available: true,
  regeneratingMessageId: null,
  onRegenerate: vi.fn(),
  onCancel: vi.fn(),
  onSelect: vi.fn(),
  ...overrides
});
function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(element));
  return { container, root, unmount: () => act(() => root.unmount()) };
}

describe("who is offered Regenerate", () => {
  it("offers it to the person who asked, for an eligible reply, in their own shop", () => {
    expect(canOfferRegenerate(answerMessage, [question, answerMessage], controlsFor())).toBe(true);
  });

  it("offers nothing where the server would refuse", () => {
    const refused: Array<[string, ChatMessage, ChatMessage[], ReplyVersionControls]> = [
      ["not eligible", { ...answerMessage, regenerable: undefined }, [question], controlsFor()],
      ["asked by someone else", answerMessage, [{ ...question, author: "contact" }], controlsFor()],
      ["question not in thread", answerMessage, [], controlsFor()],
      [
        "question deleted",
        answerMessage,
        [{ ...question, deletedAt: "2026-11-13" }],
        controlsFor()
      ],
      [
        "question has files",
        answerMessage,
        [
          {
            ...question,
            attachments: [{ id: "a", name: "a.pdf", type: "", size: 1, category: "document" }]
          }
        ],
        controlsFor()
      ],
      [
        "question is a command",
        answerMessage,
        [{ ...question, body: "\u200B /skills" }],
        controlsFor()
      ],
      ["not this viewer's shop", answerMessage, [question], controlsFor({ available: false })]
    ];
    for (const [label, reply, thread, controls] of refused)
      expect(canOfferRegenerate(reply, thread, controls), label).toBe(false);
  });

  it("renders no menu entry for someone who did not ask, and a locked one while writing", () => {
    const stranger = mount(
      createElement(RegenerateMenuItem, {
        controls: controlsFor(),
        message: answerMessage,
        thread: [{ ...question, author: "contact" }],
        onChosen: vi.fn()
      })
    );
    expect(stranger.container.innerHTML).toBe("");
    stranger.unmount();

    const order: string[] = [];
    const asker = mount(
      createElement(RegenerateMenuItem, {
        controls: controlsFor({ onRegenerate: (id) => order.push(`regenerate:${id}`) }),
        message: answerMessage,
        thread: [question],
        onChosen: () => order.push("menu-closed")
      })
    );
    act(() => asker.container.querySelector("button")!.click());
    expect(order).toEqual(["menu-closed", "regenerate:reply-1"]);
    asker.unmount();

    const locked = mount(
      createElement(RegenerateMenuItem, {
        controls: controlsFor({ regeneratingMessageId: "reply-2" }),
        message: answerMessage,
        thread: [question],
        onChosen: vi.fn()
      })
    );
    expect(locked.container.querySelector("button")!.disabled).toBe(true);
    locked.unmount();
  });

  it("shows other participants the version position with the controls locked", () => {
    const row = (thread: ChatMessage[]) =>
      mount(
        createElement(ReplyVersionRow, { message: answerMessage, thread, controls: controlsFor() })
      );
    const stranger = row([{ ...question, author: "contact" }]);
    expect(stranger.container.textContent).toContain("Version 2 of 2");
    for (const button of stranger.container.querySelectorAll("button"))
      expect(button.disabled).toBe(true);
    stranger.unmount();
    const asker = row([question]);
    expect(
      asker.container.querySelector<HTMLButtonElement>('[aria-label="Previous version"]')!.disabled
    ).toBe(false);
    asker.unmount();
  });

  it("shows progress with Stop as a status region, only on the reply being written", () => {
    const controls = controlsFor({ regeneratingMessageId: "reply-1" });
    const writing = mount(
      createElement(ReplyVersionRow, { message: answerMessage, thread: [question], controls })
    );
    const status = writing.container.querySelector('[role="status"]')!;
    expect(status.textContent).toContain("Writing another version");
    act(() => status.querySelector("button")!.click());
    expect(controls.onCancel).toHaveBeenCalledTimes(1);
    writing.unmount();
    const other = mount(
      createElement(ReplyVersionRow, {
        message: { id: "reply-9", author: "grogoniclaw", body: "Hi" },
        thread: [question],
        controls
      })
    );
    expect(other.container.innerHTML).toBe("");
    other.unmount();
  });
});

describe("retry keys survive what the request might survive", () => {
  it("restores unsettled ids from storage, and tolerates storage that is broken", () => {
    const saved = new Map<string, string>();
    const store = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => void saved.set(key, value),
      removeItem: (key: string) => void saved.delete(key)
    };
    let next = 0;
    const newId = () => `version-id-${(next += 1)}`;
    expect(createReplyVersionRequests(newId, store).idFor("reply-a")).toBe("version-id-1");
    const reloaded = createReplyVersionRequests(newId, store);
    expect(reloaded.idFor("reply-a")).toBe("version-id-1");
    reloaded.settle("reply-a");
    expect(createReplyVersionRequests(newId, store).idFor("reply-a")).toBe("version-id-2");

    const broken = {
      getItem: () => "{not json",
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => undefined
    };
    const inMemory = createReplyVersionRequests(newId, broken);
    expect(inMemory.idFor("reply-b")).toBe(inMemory.idFor("reply-b"));
  });

  function mountHook(businessId: string | null = "shop-1", accountId: string | null = "account-1") {
    let controls!: ReplyVersionControls;
    const status: string[] = [];
    const deps = {
      accountId,
      conversationId: "conversation-1",
      businessId,
      setStatusMessage: (message: string) => void status.push(message),
      applyServerMessage: vi.fn()
    };
    const Harness = () => {
      controls = useReplyVersions(deps);
      return null;
    };
    const mounted = mount(createElement(Harness));
    return {
      controls: () => controls,
      status,
      applied: deps.applyServerMessage,
      changeConversation: (id: string) => {
        deps.conversationId = id;
        act(() => mounted.root.render(createElement(Harness)));
      },
      changeAccount: (id: string | null) => {
        deps.accountId = id;
        act(() => mounted.root.render(createElement(Harness)));
      },
      unmount: mounted.unmount
    };
  }
  const settle = () =>
    act(async () => void (await new Promise((resolve) => setTimeout(resolve, 5))));
  const hang = (call: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) =>
      call.signal?.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError"))
      )
    );
  const refuse = (status: number, code: string) => async () => {
    throw new ApiRequestError(status, code, { code });
  };
  const sentIds = () => api.calls.map((call) => call.body.versionId);

  it("keeps the id across Stop, a turn still running, a 5xx and a remount; releases it on a refusal", async () => {
    api.calls.length = 0;
    const first = mountHook();
    api.next = hang;
    act(() => first.controls().onRegenerate("reply-keep"));
    await settle();
    act(() => first.controls().onCancel());
    await settle();
    expect(first.status.at(-1)).toBe("Stopped waiting for the new version.");
    for (const [status, code] of [
      [409, "HANDOFF_IN_PROGRESS"],
      [503, "AGENT_MODEL_UNAVAILABLE"]
    ] as const) {
      api.next = refuse(status, code);
      act(() => first.controls().onRegenerate("reply-keep"));
      await settle();
    }
    first.unmount();

    const second = mountHook();
    api.next = refuse(409, "regeneration_would_act");
    act(() => second.controls().onRegenerate("reply-keep"));
    await settle();
    expect(new Set(sentIds()).size).toBe(1);
    expect(sentIds()).toHaveLength(4);
    expect(second.status.at(-1)).toMatch(/would change business records/u);

    api.next = async () => ({
      id: "reply-keep",
      replyVersions: { selected: 1, versions: [{}, {}] }
    });
    act(() => second.controls().onRegenerate("reply-keep"));
    await settle();
    expect(sentIds().at(-1)).not.toBe(sentIds()[0]);
    second.unmount();
  });

  it("ignores the old response after switching conversations and keeps the new request busy", async () => {
    api.calls.length = 0;
    const pending: Array<(value: unknown) => void> = [];
    api.next = () => new Promise((resolve) => pending.push(resolve));
    const hook = mountHook();
    act(() => hook.controls().onRegenerate("reply-old"));
    await settle();
    hook.changeConversation("conversation-2");
    expect(api.calls[0].signal?.aborted).toBe(true);
    act(() => hook.controls().onRegenerate("reply-new"));
    await settle();
    await act(async () => pending[0]({ id: "reply-old" }));
    expect(hook.applied).not.toHaveBeenCalled();
    expect(hook.controls().regeneratingMessageId).toBe("reply-new");
    await act(async () => pending[1]({ id: "reply-new" }));
    expect(hook.applied).toHaveBeenCalledWith("conversation-2", { id: "reply-new" });
    hook.unmount();
  });

  it("aborts on unmount and ignores a late server response without losing its retry key", async () => {
    api.calls.length = 0;
    let resolve!: (value: unknown) => void;
    api.next = () =>
      new Promise((done) => {
        resolve = done;
      });
    const first = mountHook();
    act(() => first.controls().onRegenerate("reply-unmounted"));
    await settle();
    const firstId = sentIds()[0];
    first.unmount();
    expect(api.calls[0].signal?.aborted).toBe(true);
    await act(async () => resolve({ id: "reply-unmounted" }));
    expect(first.status).toEqual([]);

    const second = mountHook();
    api.next = refuse(503, "AGENT_MODEL_UNAVAILABLE");
    act(() => second.controls().onRegenerate("reply-unmounted"));
    await settle();
    expect(sentIds()[1]).toBe(firstId);
    second.unmount();
  });

  it("is unavailable, and sends nothing, when signed out", async () => {
    api.calls.length = 0;
    const hook = mountHook("shop-1", null);
    expect(hook.controls().available).toBe(false);
    act(() => hook.controls().onRegenerate("reply-1"));
    act(() => hook.controls().onSelect("reply-1", 0));
    await settle();
    expect(api.calls).toHaveLength(0);
    hook.unmount();
  });

  it("aborts the request in flight when the account changes under a mounted surface", async () => {
    api.calls.length = 0;
    api.next = hang;
    const hook = mountHook("shop-1", "account-m");
    act(() => hook.controls().onRegenerate("reply-1"));
    await settle();
    hook.changeAccount("account-n");
    await settle();
    expect(api.calls[0]!.signal?.aborted).toBe(true);
    expect(hook.controls().regeneratingMessageId).toBeNull();
    expect(hook.status).toEqual([]);
    hook.unmount();
  });

  it("ignores a late answer from another account without clearing the new request", async () => {
    api.calls.length = 0;
    const pending: Array<(value: unknown) => void> = [];
    api.next = () => new Promise((resolve) => pending.push(resolve));
    const hook = mountHook("shop-1", "account-late-a");
    act(() => hook.controls().onRegenerate("reply-same"));
    await settle();
    hook.changeAccount("account-late-b");
    act(() => hook.controls().onRegenerate("reply-same"));
    await settle();
    expect(sentIds()[1]).not.toBe(sentIds()[0]);
    await act(async () => pending[0]({ id: "from-a" }));
    expect(hook.applied).not.toHaveBeenCalled();
    expect(hook.controls().regeneratingMessageId).toBe("reply-same");
    await act(async () => pending[1]({ id: "from-b" }));
    expect(hook.applied).toHaveBeenCalledWith("conversation-1", { id: "from-b" });
    hook.unmount();
  });

  it("sends a different id for the same reply after the account changes", async () => {
    api.calls.length = 0;
    api.next = hang;
    const first = mountHook("shop-1", "account-x");
    act(() => first.controls().onRegenerate("reply-shared"));
    await settle();
    first.unmount();
    const second = mountHook("shop-1", "account-y");
    act(() => second.controls().onRegenerate("reply-shared"));
    await settle();
    second.unmount();
    expect(sentIds()).toHaveLength(2);
    expect(sentIds()[1]).not.toBe(sentIds()[0]);
  });

  it("is unavailable, and sends nothing, without the viewer's own shop", async () => {
    api.calls.length = 0;
    const hook = mountHook(null);
    expect(hook.controls().available).toBe(false);
    act(() => hook.controls().onRegenerate("reply-1"));
    await settle();
    expect(api.calls).toHaveLength(0);
    hook.unmount();
  });
});

describe("retry keys belong to one account", () => {
  it("keeps each account's ids apart, in memory and in session storage", () => {
    forgetReplyVersionRequests();
    const first = sharedReplyVersionRequests("account-a").idFor("reply-1");
    const second = sharedReplyVersionRequests("account-b").idFor("reply-1");
    expect(second).not.toBe(first);
    expect(sharedReplyVersionRequests("account-a").idFor("reply-1")).toBe(first);
    expect(JSON.parse(sessionStorage.getItem(replyVersionStorageKey("account-a"))!)).toEqual({
      "reply-1": first
    });
    expect(JSON.parse(sessionStorage.getItem(replyVersionStorageKey("account-b"))!)).toEqual({
      "reply-1": second
    });
  });

  it("forgets every account's ids on sign-out, including ones only in storage", () => {
    forgetReplyVersionRequests();
    const before = sharedReplyVersionRequests("account-a").idFor("reply-1");
    sessionStorage.setItem(replyVersionStorageKey("account-old"), '{"reply-9":"left-behind-id"}');
    sessionStorage.setItem("grogoni:unrelated", "kept");
    forgetReplyVersionRequests();
    expect(sessionStorage.getItem(replyVersionStorageKey("account-a"))).toBeNull();
    expect(sessionStorage.getItem(replyVersionStorageKey("account-old"))).toBeNull();
    expect(sessionStorage.getItem("grogoni:unrelated")).toBe("kept");
    expect(sharedReplyVersionRequests("account-a").idFor("reply-1")).not.toBe(before);
    sessionStorage.removeItem("grogoni:unrelated");
  });

  it("does not write an account's ids back when an answer arrives after sign-out", () => {
    forgetReplyVersionRequests();
    const held = sharedReplyVersionRequests("account-late");
    held.idFor("reply-earlier");
    held.idFor("reply-in-flight");
    forgetReplyVersionRequests();
    held.settle("reply-in-flight");
    held.idFor("reply-after");
    expect(sessionStorage.getItem(replyVersionStorageKey("account-late"))).toBeNull();
  });

  it("removes the single key an earlier build used, and survives storage that throws", () => {
    sessionStorage.setItem("grogoni:reply-version-requests", '{"reply-1":"old-build-id"}');
    forgetReplyVersionRequests();
    expect(sessionStorage.getItem("grogoni:reply-version-requests")).toBeNull();
    const throwing = {
      length: 1,
      key: () => {
        throw new Error("SecurityError");
      },
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => {
        throw new Error("SecurityError");
      }
    };
    sharedReplyVersionRequests("account-a").idFor("reply-1");
    expect(() => forgetReplyVersionRequests(throwing)).not.toThrow();
    expect(sharedReplyVersionRequests("account-a").idFor("reply-1")).toBeTruthy();
    forgetReplyVersionRequests();
  });

  it("removes known keys when enumeration throws and keeps held maps disposed", () => {
    forgetReplyVersionRequests();
    const held = sharedReplyVersionRequests("account-enumeration");
    held.idFor("in-flight");
    sessionStorage.setItem("grogoni:reply-version-requests", "legacy");
    const store = {
      get length(): number {
        throw new Error("Enumeration blocked");
      },
      key: () => null,
      getItem: (key: string) => sessionStorage.getItem(key),
      setItem: (key: string, value: string) => sessionStorage.setItem(key, value),
      removeItem: (key: string) => sessionStorage.removeItem(key)
    };
    forgetReplyVersionRequests(store);
    held.idFor("late");
    held.settle("in-flight");
    expect(sessionStorage.getItem(replyVersionStorageKey("account-enumeration"))).toBeNull();
    expect(sessionStorage.getItem("grogoni:reply-version-requests")).toBeNull();
  });

  it("still removes other account entries when one removal throws", () => {
    forgetReplyVersionRequests();
    sharedReplyVersionRequests("account-remove-a").idFor("reply");
    sharedReplyVersionRequests("account-remove-b").idFor("reply");
    const store = {
      getItem: (key: string) => sessionStorage.getItem(key),
      setItem: (key: string, value: string) => sessionStorage.setItem(key, value),
      removeItem: (key: string) => {
        if (key === "grogoni:reply-version-requests") throw new Error("Blocked key");
        sessionStorage.removeItem(key);
      }
    };
    expect(() => forgetReplyVersionRequests(store)).not.toThrow();
    expect(sessionStorage.getItem(replyVersionStorageKey("account-remove-a"))).toBeNull();
    expect(sessionStorage.getItem(replyVersionStorageKey("account-remove-b"))).toBeNull();
  });

  it("runs the cleanup from the chat inbox reset that sign-out triggers", () => {
    const inbox = readFileSync("apps/web/src/hooks/useChatInboxState.ts", "utf8");
    const reset = inbox.indexOf('deps.registerReset("chat-inbox"');
    expect(reset).toBeGreaterThan(-1);
    expect(inbox.slice(reset, reset + 120)).toContain("forgetReplyVersionRequests();");
    expect(inbox).toContain("accountId: session?.account.id ?? null");
  });
});

describe("a version says which revision of the question it answered", () => {
  const versioned = (questionRevision?: string | null): ChatMessage => ({
    ...answerMessage,
    replyVersions: {
      selected: 0,
      count: 2,
      ...(questionRevision === undefined ? {} : { questionRevision })
    }
  });
  const edited: ChatMessage = { ...question, editedAt: "2026-11-13T09:00:00.000Z" };
  const noteIn = (message: ChatMessage, thread: ChatMessage[]) => {
    const view = mount(
      createElement(ReplyVersionRow, { message, thread, controls: controlsFor() })
    );
    const note = view.container.querySelector(".reply-version-note")?.textContent ?? null;
    view.unmount();
    return note;
  };

  it("notes an answer written before the last edit, and stays silent otherwise", () => {
    const note = "Answered before the message was last edited.";
    expect(noteIn(versioned(null), [edited])).toBe(note);
    expect(noteIn(versioned("2026-11-13T08:30:00.000Z"), [edited])).toBe(note);
    expect(noteIn(versioned(null), [question])).toBeNull();
    expect(noteIn(versioned("2026-11-13T09:00:00.000Z"), [edited])).toBeNull();
    // Unknown revision, question not loaded, question deleted: nothing is claimed.
    expect(noteIn(versioned(), [edited])).toBeNull();
    expect(noteIn(versioned(null), [])).toBeNull();
    expect(noteIn(versioned(null), [{ ...edited, deletedAt: "2026-11-13" }])).toBeNull();
  });

  it("maps the selected version's recorded revision, and nothing when it is unknown", () => {
    const session = { account: { id: "account-1" }, user: { id: "user-1" } } as Parameters<
      typeof mapConversationMessage
    >[2];
    const reply: ConversationMessageSummary = {
      id: "reply-1",
      conversationId: "conversation-1",
      clientMessageId: "agent-reply-question-1",
      idempotencyKey: "grogoni-agent-reply:question-1",
      author: "agent",
      authorId: "account-account-1-agent",
      content: { type: "text", text: "First answer." },
      replyToMessageId: "question-1",
      agentTurnEffect: "none",
      clientTimestamp: null,
      createdAt: "2026-11-13T08:00:00.000Z",
      replyVersions: {
        selected: 0,
        versions: [
          { id: "original", text: "First answer.", createdAt: "x", questionRevision: null },
          {
            id: "version-0002",
            text: "Second answer.",
            createdAt: "x",
            questionRevision: "2026-11-13T09:00:00.000Z"
          }
        ]
      }
    };
    expect(mapConversationMessage(reply, [], session).replyVersions).toEqual({
      selected: 0,
      count: 2,
      questionRevision: null
    });
    const unknown = structuredClone(reply);
    delete unknown.replyVersions!.versions[0]!.questionRevision;
    expect(mapConversationMessage(unknown, [], session).replyVersions).toEqual({
      selected: 0,
      count: 2
    });
  });
});

describe("chat surface wiring", () => {
  const chatSurface = readFileSync("apps/web/src/ChatSurface.tsx", "utf8");

  it("keeps Regenerate inside the More menu and gives it the thread to decide who is offered it", () => {
    const menuStart = chatSurface.indexOf('<div className="message-action-menu" role="menu">');
    const item = chatSurface.indexOf("<RegenerateMenuItem");
    expect(item).toBeGreaterThan(menuStart);
    const props = chatSurface.slice(item, item + 260);
    expect(props).toContain("thread={messages}");
    expect(props).toContain("setActiveMessageMenuId(null)");
    expect(chatSurface).toContain(
      "<ReplyVersionRow message={message} thread={messages} controls={replyVersions} />"
    );
  });
});
