// @vitest-environment jsdom
import { act } from "react";
import { useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuyFeedSummary, BuyResultSummary } from "@grogoni/shared-types";

import { MessageDeliveryMeta, WaitingMessagesButton } from "../apps/web/src/MessageDeliveryMeta";
import {
  clearDeviceOnlyMessages,
  deviceOnlyAnchor,
  deviceOnlyMaxAgeMs,
  holdDeviceOnlyInMemory,
  outboxPlaceholders,
  forgetDeliveredDeviceOnlyMessages,
  inferenceHistory,
  keepDeviceOnlyMessages,
  readDeviceOnlyMessages,
  saveDeviceOnlyMessages,
  updateDeviceOnlyMessage
} from "../apps/web/src/chat-device-only-messages";
import { describeMarketplaceSearch } from "../apps/web/src/marketplace-search-reply";
import { messageDeliveryLabel } from "../apps/web/src/message-delivery-label";
import {
  messagingOutboxChangeEvent,
  queueMessagingOutbox,
  removeMessagingOutboxEntry
} from "../apps/web/src/messaging/outbox";
import { useMessagingOutboxCount } from "../apps/web/src/hooks/useMessagingOutboxCount";
import { hasUnreadForMe } from "../apps/web/src/hooks/useChatInboxState";
import { useSwipeNavigation } from "../apps/web/src/hooks/useSwipeNavigation";
import {
  chatSwipeEnabled,
  classifySwipe,
  swipeEdgeGutter,
  swipeMaxDuration,
  swipeMinDistance,
  swipeStartsOnInteractiveElement
} from "../apps/web/src/swipe-navigation";

const feed = (results: Partial<BuyResultSummary>[]): BuyFeedSummary => ({
  query: "sugar",
  results: results as BuyResultSummary[],
  marketplaceConnectorAvailable: true
});

describe("marketplace search reply", () => {
  it("never tells the buyer to open a result when there are none", () => {
    const { reply, status } = describeMarketplaceSearch("hello", feed([]));
    expect(reply).not.toMatch(/open a result/iu);
    expect(reply).toContain('"hello"');
    expect(status).toBe("No marketplace results.");
  });

  it("counts items and distinct shops", () => {
    expect(describeMarketplaceSearch("sugar", feed([{ sourceLabel: "A" }])).reply).toContain(
      "1 item from 1 shop"
    );
    expect(
      describeMarketplaceSearch(
        "sugar",
        feed([{ sourceLabel: "A" }, { sourceLabel: "A" }, { sourceLabel: "B" }])
      ).reply
    ).toContain("3 items from 2 shops");
  });

  it("says the search failed rather than pretending it ran", () => {
    expect(describeMarketplaceSearch("sugar", null).reply).toMatch(/couldn't search/iu);
    expect(describeMarketplaceSearch("sugar", undefined).status).toBe("Marketplace search failed.");
  });
});

describe("message delivery label", () => {
  it("says whether anything will send a failed message", () => {
    expect(messageDeliveryLabel("failed", "retrying")).toEqual({
      text: "Not sent yet · retrying",
      failed: true
    });
    expect(messageDeliveryLabel("failed", "stopped")).toEqual({
      text: "Not sent · tap Send waiting at the top to retry",
      failed: true
    });
    expect(messageDeliveryLabel("failed", "rejected")).toEqual({ text: "Not sent", failed: true });
    expect(messageDeliveryLabel("failed")).toEqual({ text: "Not sent", failed: true });
  });

  it("uses plain words for every other status", () => {
    expect(messageDeliveryLabel("pending")).toEqual({ text: "Sending…", failed: false });
    expect(messageDeliveryLabel("queued", "retrying")).toEqual({
      text: "Waiting to send",
      failed: false
    });
    expect(messageDeliveryLabel("queued")).toEqual({ text: "Sending…", failed: false });
    expect(messageDeliveryLabel("delivered").text).toBe("Delivered");
    expect(messageDeliveryLabel("read").text).toBe("Read");
  });
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("waiting-message count", () => {
  function Count({ accountId }: { accountId: string | null }) {
    return <output>{useMessagingOutboxCount(accountId)}</output>;
  }

  it("follows the outbox as messages are queued and sent", () => {
    act(() => root.render(<Count accountId="acct-1" />));
    expect(host.textContent).toBe("0");
    act(() =>
      queueMessagingOutbox({ accountId: "acct-1", clientMessageId: "m1", payload: { a: 1 } })
    );
    expect(host.textContent).toBe("1");
    act(() =>
      queueMessagingOutbox({ accountId: "acct-2", clientMessageId: "m2", payload: { a: 1 } })
    );
    expect(host.textContent).toBe("1");
    act(() => removeMessagingOutboxEntry("acct-1", "m1"));
    expect(host.textContent).toBe("0");
  });

  it("is zero when signed out", () => {
    queueMessagingOutbox({ accountId: "acct-1", clientMessageId: "m1", payload: { a: 1 } });
    act(() => root.render(<Count accountId={null} />));
    expect(host.textContent).toBe("0");
  });

  it("announces every outbox write", () => {
    const listener = vi.fn();
    window.addEventListener(messagingOutboxChangeEvent, listener);
    queueMessagingOutbox({ accountId: "a", clientMessageId: "m", payload: {} });
    removeMessagingOutboxEntry("a", "m");
    window.removeEventListener(messagingOutboxChangeEvent, listener);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("swipe classification", () => {
  const width = 400;
  const at = (x: number, y = 300, time = 0) => ({ x, y, time });

  it("reads a quick horizontal flick as a swipe in its direction", () => {
    expect(classifySwipe(at(300), at(300 - swipeMinDistance, 300, 200), width)).toBe("left");
    expect(classifySwipe(at(100), at(100 + swipeMinDistance, 300, 200), width)).toBe("right");
  });

  it("ignores short, slow, diagonal, and edge-started gestures", () => {
    expect(classifySwipe(at(300), at(300 - swipeMinDistance + 1, 300, 100), width)).toBeNull();
    expect(classifySwipe(at(300), at(150, 300, swipeMaxDuration + 1), width)).toBeNull();
    expect(classifySwipe(at(300), at(150, 380, 100), width)).toBeNull();
    expect(classifySwipe(at(swipeEdgeGutter - 1), at(200, 300, 100), width)).toBeNull();
    expect(classifySwipe(at(width - swipeEdgeGutter + 1), at(200, 300, 100), width)).toBeNull();
  });

  it("does not start a swipe on a text field or an opted-out control", () => {
    document.body.innerHTML =
      '<div><textarea id="t"></textarea><div data-swipe-ignore><span id="s"></span></div><p id="p"></p></div>';
    expect(swipeStartsOnInteractiveElement(document.getElementById("t"))).toBe(true);
    expect(swipeStartsOnInteractiveElement(document.getElementById("s"))).toBe(true);
    expect(swipeStartsOnInteractiveElement(document.getElementById("p"))).toBe(false);
    document.body.innerHTML = "";
    document.body.append(host);
  });
});

describe("useSwipeNavigation", () => {
  const onSwipeLeft = vi.fn();
  const onSwipeRight = vi.fn();
  function Surface({ enabled }: { enabled: boolean }) {
    const ref = useRef<HTMLDivElement | null>(null);
    useSwipeNavigation(ref, { enabled, onSwipeLeft, onSwipeRight });
    return (
      <div ref={ref} id="surface">
        <p id="text">hi</p>
        <input id="field" />
      </div>
    );
  }
  function touch(target: Element, type: string, x: number, timeStamp: number, fingers = 1) {
    const event = new Event(type, { bubbles: true });
    const point = { clientX: x, clientY: 300 };
    Object.defineProperties(event, {
      touches: { value: type === "touchend" ? [] : Array(fingers).fill(point) },
      changedTouches: { value: [point] },
      timeStamp: { value: timeStamp }
    });
    target.dispatchEvent(event);
  }
  function swipe(target: Element, fromX: number, toX: number) {
    touch(target, "touchstart", fromX, 1000);
    touch(target, "touchend", toX, 1200);
  }

  beforeEach(() => {
    onSwipeLeft.mockReset();
    onSwipeRight.mockReset();
    Object.defineProperty(window, "innerWidth", { value: 400, configurable: true });
  });

  it("swipe left opens the contact book and swipe right opens the shop", () => {
    act(() => root.render(<Surface enabled />));
    const text = document.getElementById("text")!;
    swipe(text, 300, 150);
    expect(onSwipeLeft).toHaveBeenCalledTimes(1);
    swipe(text, 100, 250);
    expect(onSwipeRight).toHaveBeenCalledTimes(1);
  });

  it("does nothing while disabled, in a text field, or with two fingers", () => {
    act(() => root.render(<Surface enabled={false} />));
    swipe(document.getElementById("text")!, 300, 150);
    act(() => root.render(<Surface enabled />));
    swipe(document.getElementById("field")!, 300, 150);
    const text = document.getElementById("text")!;
    touch(text, "touchstart", 300, 1000);
    touch(text, "touchmove", 250, 1050, 2);
    touch(text, "touchend", 150, 1200);
    expect(onSwipeLeft).not.toHaveBeenCalled();
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it("does nothing while text is selected (a selection handle is being dragged)", () => {
    act(() => root.render(<Surface enabled />));
    const text = document.getElementById("text")!;
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    try {
      swipe(text, 300, 150);
      expect(onSwipeLeft).not.toHaveBeenCalled();
    } finally {
      window.getSelection()!.removeAllRanges();
    }
  });

  it("stops listening when unmounted", () => {
    act(() => root.render(<Surface enabled />));
    const text = document.getElementById("text")!;
    act(() => root.render(<></>));
    swipe(text, 300, 150);
    expect(onSwipeLeft).not.toHaveBeenCalled();
  });
});

describe("when the chat accepts swipes", () => {
  const bare = { moduleOpen: false, workspaceOpen: false, inboxCoversChat: false, overlays: [] };

  it("accepts them on the bare chat only", () => {
    expect(chatSwipeEnabled(bare)).toBe(true);
    expect(chatSwipeEnabled({ ...bare, moduleOpen: true })).toBe(false);
    expect(chatSwipeEnabled({ ...bare, workspaceOpen: true })).toBe(false);
    expect(chatSwipeEnabled({ ...bare, inboxCoversChat: true })).toBe(false);
  });

  it("refuses them while any sheet, menu or dialog is over the chat", () => {
    expect(chatSwipeEnabled({ ...bare, overlays: [false, false] })).toBe(true);
    expect(chatSwipeEnabled({ ...bare, overlays: [false, true, false] })).toBe(false);
  });

  it("ignores a touch that starts inside a dialog or menu", () => {
    document.body.innerHTML =
      '<div role="dialog"><p id="in-dialog"></p></div><ul role="menu"><li id="in-menu"></li></ul><dialog open><b id="in-native"></b></dialog>';
    for (const id of ["in-dialog", "in-menu", "in-native"])
      expect(swipeStartsOnInteractiveElement(document.getElementById(id)), id).toBe(true);
    document.body.innerHTML = "";
    document.body.append(host);
  });
});

describe("message delivery UI", () => {
  const attempts = {
    openMessageId: null,
    byMessage: {},
    loadingMessageId: null,
    error: null,
    toggle: vi.fn(async () => undefined)
  };

  it("renders nothing to resend when the outbox is empty, and counts what is waiting", () => {
    const onSend = vi.fn();
    act(() => root.render(<WaitingMessagesButton count={0} onSend={onSend} />));
    expect(host.querySelector("button")).toBeNull();
    act(() => root.render(<WaitingMessagesButton count={2} onSend={onSend} />));
    expect(host.textContent).toBe("Send 2 waiting messages");
    act(() => host.querySelector("button")!.click());
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("marks a failed message so the sender can see it was not sent", () => {
    act(() =>
      root.render(
        <MessageDeliveryMeta
          message={{
            id: "m1",
            author: "merchant",
            body: "hi",
            status: "failed",
            outboxState: "retrying",
            deviceOnlyIn: "c1"
          }}
          attempts={attempts}
        />
      )
    );
    const status = host.querySelector(".message-status-failed");
    expect(status?.textContent).toBe("Not sent yet · retrying");
    // Never sent, so there are no delivery attempts to show.
    expect(host.querySelector("button")).toBeNull();
  });

  it("shows no delivery status on replies from others", () => {
    act(() =>
      root.render(
        <MessageDeliveryMeta
          message={{ id: "m2", author: "grogoniclaw", body: "hi", status: "delivered" }}
          attempts={attempts}
        />
      )
    );
    expect(host.textContent).not.toContain("Delivered");
    expect(host.querySelector("button")).toBeNull();
  });
});

describe("device-only messages across thread refreshes", () => {
  const server = (id: string, at = "2026-10-16T10:00:00Z") => ({
    id,
    author: "merchant" as const,
    body: id,
    createdAt: at
  });
  const local = (id: string, conversation: string | null, after: string | null) => ({
    ...server(id),
    deviceOnlyIn: conversation,
    deviceOnlyAfter: after
  });

  it("puts the exchange right after the message it followed, whatever the clocks say", () => {
    // The phone's clock is an hour ahead of the server's: placement must not depend on it.
    const current = [
      server("s1"),
      { ...local("q", "c1", "s1"), createdAt: "2026-10-16T11:00:00Z" },
      { ...local("a", "c1", "s1"), createdAt: "2026-10-16T11:00:00Z" }
    ];
    const refreshed = [server("s1"), server("s2", "2026-10-16T10:30:00Z")];
    expect(keepDeviceOnlyMessages(current, refreshed, "c1").map((m) => m.id)).toEqual([
      "s1",
      "q",
      "a",
      "s2"
    ]);
  });

  it("brings back stored messages after a thread switch or reload, without duplicates", () => {
    const stored = [local("q", "c1", "s1"), local("other", "c2", null)];
    const refreshed = [server("s1")];
    expect(keepDeviceOnlyMessages([], refreshed, "c1", stored).map((m) => m.id)).toEqual([
      "s1",
      "q"
    ]);
    expect(
      keepDeviceOnlyMessages([local("q", "c1", "s1")], refreshed, "c1", stored).map((m) => m.id)
    ).toEqual(["s1", "q"]);
  });

  it("shows a waiting message at the end, where the server will put it once sent", () => {
    // Typed before s2 reached the server, but it will be stamped when it is finally sent.
    const waiting = { ...local("queued", "c1", "s1"), outboxState: "retrying" as const };
    expect(
      keepDeviceOnlyMessages([waiting], [server("s1"), server("s2")], "c1").map(
        (message) => message.id
      )
    ).toEqual(["s1", "s2", "queued"]);
  });

  it("keeps two queued messages in the order they were typed, wherever their copies come from", () => {
    const earlier = {
      ...local("first", "c1", "s1"),
      createdAt: "2026-10-16T10:00:01Z",
      outboxState: "retrying" as const
    };
    const later = {
      ...local("second", "c1", "s1"),
      createdAt: "2026-10-16T10:00:05Z",
      outboxState: "retrying" as const
    };
    // The newer copy is on screen; the older one only in storage (it was updated there).
    expect(
      keepDeviceOnlyMessages([later], [server("s1")], "c1", [earlier]).map((message) => message.id)
    ).toEqual(["s1", "first", "second"]);
  });

  it("never carries it into another conversation", () => {
    const refreshed = [server("s9")];
    expect(keepDeviceOnlyMessages([local("q", "c1", null)], refreshed, "c2")).toBe(refreshed);
  });

  it("puts a message whose anchor is gone at the end, and one made in an empty thread first", () => {
    expect(
      keepDeviceOnlyMessages([local("q", "c1", "deleted")], [server("s1")], "c1").map((m) => m.id)
    ).toEqual(["s1", "q"]);
    expect(
      keepDeviceOnlyMessages([local("q", "c1", null)], [server("s1")], "c1").map((m) => m.id)
    ).toEqual(["q", "s1"]);
  });

  it("drops a queued message once the server has it under its client id", () => {
    const queued = { ...local("client-1", "c1", null), status: "failed" as const };
    const delivered = { ...server("server-9"), clientMessageId: "client-1" };
    expect(keepDeviceOnlyMessages([queued], [delivered], "c1")).toEqual([delivered]);
  });

  it("shows a placeholder for a waiting message whose text is not on this page", () => {
    const waiting = [
      {
        clientMessageId: "enc-1",
        payload: { conversationId: "c1", content: { type: "encrypted", ciphertext: "x" } }
      },
      { clientMessageId: "known", payload: { conversationId: "c1" } },
      { clientMessageId: "elsewhere", payload: { conversationId: "c2" } }
    ];
    const placeholders = outboxPlaceholders(waiting, "c1", [local("known", "c1", null)]);
    expect(placeholders.map((message) => message.id)).toEqual(["enc-1"]);
    expect(placeholders[0]).toMatchObject({
      outboxState: "retrying",
      deviceOnlyIn: "c1",
      body: "Encrypted message waiting to send"
    });
    // A plain message whose thread copy was lost shows its own text from the outbox.
    expect(
      outboxPlaceholders(
        [
          {
            clientMessageId: "plain-1",
            payload: { conversationId: "c1", content: { type: "text", text: "5 bags of sugar" } }
          }
        ],
        "c1",
        []
      )[0]?.body
    ).toBe("5 bags of sugar");
    // At the end of the thread, after everything the server has.
    expect(
      keepDeviceOnlyMessages([], [server("s1"), server("s2")], "c1", placeholders).map(
        (message) => message.id
      )
    ).toEqual(["s1", "s2", "enc-1"]);
  });

  it("keeps encrypted copies in page memory only, and clears them on sign-out", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key)
    };
    holdDeviceOnlyInMemory("a9", [
      { ...local("secret", "dm", null), body: "private", createdAt: new Date().toISOString() }
    ]);
    expect(readDeviceOnlyMessages("a9", storage).map((message) => message.id)).toEqual(["secret"]);
    saveDeviceOnlyMessages(
      "a9",
      [{ ...local("plain", "c1", null), createdAt: new Date().toISOString() }],
      storage
    );
    expect([...values.values()].join("")).not.toContain("private");
    clearDeviceOnlyMessages("a9", storage);
    expect(readDeviceOnlyMessages("a9", storage)).toEqual([]);
  });

  it("anchors a new message to the last message the server has", () => {
    const stored = (id: string) => ({ ...server(id), clientMessageId: `${id}-client` });
    expect(deviceOnlyAnchor([stored("s1"), local("q", "c1", "s1")])).toBe("s1");
    // Not the welcome placeholder, nor a bubble still being sent: both vanish on refresh.
    expect(
      deviceOnlyAnchor([stored("s1"), { id: "welcome", author: "grogoniclaw", body: "Hi" }])
    ).toBe("s1");
    expect(deviceOnlyAnchor([{ id: "welcome", author: "grogoniclaw", body: "Hi" }])).toBeNull();
    expect(deviceOnlyAnchor([])).toBeNull();
  });

  it("keeps an exchange made in an empty thread before everything said after it", () => {
    // Made when only the welcome placeholder showed: anchored to nothing, so it stays first.
    const exchange = local(
      "q",
      "c1",
      deviceOnlyAnchor([{ id: "welcome", author: "grogoniclaw", body: "Hi" }])
    );
    expect(
      keepDeviceOnlyMessages([], [server("later-1"), server("later-2")], "c1", [exchange]).map(
        (message) => message.id
      )
    ).toEqual(["q", "later-1", "later-2"]);
  });

  it("pushes out old searches, never a waiting message, when storage is full", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value)
    };
    const at = new Date().toISOString();
    saveDeviceOnlyMessages(
      "a1",
      [{ ...local("queued-early", "c1", null), createdAt: at, outboxState: "retrying" }],
      storage
    );
    saveDeviceOnlyMessages(
      "a1",
      Array.from({ length: 120 }, (_, index) => ({
        ...local(`search-${index}`, "c1", null),
        createdAt: at
      })),
      storage
    );
    const kept = readDeviceOnlyMessages("a1", storage).map((message) => message.id);
    expect(kept).toHaveLength(100);
    expect(kept).toContain("queued-early");
    expect(kept).toContain("search-119");
    expect(kept).not.toContain("search-0");
  });

  it("keeps a queued message past a day, and never stores attachment data", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value)
    };
    const old = new Date(Date.now() - 2 * deviceOnlyMaxAgeMs).toISOString();
    saveDeviceOnlyMessages(
      "a1",
      [
        { ...local("queued", "c1", null), createdAt: old, outboxState: "retrying" },
        { ...local("search", "c1", null), createdAt: old },
        {
          ...local("photo", "c1", null),
          createdAt: new Date().toISOString(),
          outboxState: "retrying",
          attachments: [
            {
              id: "att-1",
              name: "receipt.jpg",
              type: "image/jpeg",
              size: 2_000_000,
              category: "image",
              dataUrl: "data:image/jpeg;base64,AAAA",
              previewUrl: "blob:preview"
            }
          ]
        }
      ],
      storage
    );
    const kept = readDeviceOnlyMessages("a1", storage);
    expect(kept.map((message) => message.id)).toEqual(["queued", "photo"]);
    expect(kept[1]!.attachments?.[0]).toMatchObject({ name: "receipt.jpg" });
    expect([...values.values()].join("")).not.toMatch(/base64|blob:preview/u);
  });

  it("stores per account, updates in place, forgets what the server has, and expires", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value)
    };
    const now = Date.now();
    const fresh = { ...local("q", "c1", null), createdAt: new Date(now).toISOString() };
    saveDeviceOnlyMessages("a1", [fresh], storage);
    expect(readDeviceOnlyMessages("a2", storage)).toEqual([]);
    updateDeviceOnlyMessage("a1", "q", { outboxState: "stopped" }, storage);
    expect(readDeviceOnlyMessages("a1", storage)[0]).toMatchObject({ outboxState: "stopped" });
    forgetDeliveredDeviceOnlyMessages(
      "a1",
      [{ id: "server-1", clientMessageId: "q", author: "merchant", body: "" }],
      storage
    );
    expect(readDeviceOnlyMessages("a1", storage)).toEqual([]);
    saveDeviceOnlyMessages("a1", [fresh], storage);
    expect(readDeviceOnlyMessages("a1", storage, now + deviceOnlyMaxAgeMs + 1)).toEqual([]);
  });
});

describe("model history", () => {
  it("leaves out messages that never reached the conversation", () => {
    const history = inferenceHistory([
      { id: "1", author: "merchant", body: "real question" },
      { id: "2", author: "grogoniclaw", body: "real answer" },
      { id: "3", author: "merchant", body: "I want to buy sugar", deviceOnlyIn: null },
      { id: "4", author: "grogoniclaw", body: "No shop lists sugar", deviceOnlyIn: null },
      { id: "5", author: "merchant", body: "still queued", deviceOnlyIn: "c1", status: "failed" },
      { id: "6", author: "contact", body: "from a person" }
    ]);
    expect(history).toEqual([
      { role: "user", content: "real question" },
      { role: "assistant", content: "real answer" }
    ]);
  });

  it("keeps only the most recent turns", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      id: String(index),
      author: "merchant" as const,
      body: `m${index}`
    }));
    expect(inferenceHistory(many).map((turn) => turn.content)).toEqual(
      many.slice(-12).map((message) => message.body)
    );
  });
});

describe("whether to mark the open conversation read", () => {
  const session = { account: { id: "me-account" }, user: { id: "me-user" } } as never;
  const view = (lastReadAt: string | null, messages: object[]) =>
    ({
      conversation: { id: "c1" },
      participants: [{ role: "account", accountId: "me-account", lastReadAt }],
      messages
    }) as never;
  const other = (createdAt: string, readAt: string | null) => ({
    authorId: "someone-else",
    createdAt,
    readAt,
    deletedAt: null
  });

  it("asks only when something from someone else is new to this account", () => {
    expect(hasUnreadForMe(view("2026-10-16T10:00:00Z", []), session)).toBe(false);
    expect(
      hasUnreadForMe(view("2026-10-16T10:00:00Z", [other("2026-10-16T09:00:00Z", "x")]), session)
    ).toBe(false);
    expect(
      hasUnreadForMe(view("2026-10-16T10:00:00Z", [other("2026-10-16T09:00:00Z", null)]), session)
    ).toBe(true);
    // Another participant already marked it read; this account still has not read it.
    expect(
      hasUnreadForMe(view("2026-10-16T10:00:00Z", [other("2026-10-16T11:00:00Z", "x")]), session)
    ).toBe(true);
    expect(
      hasUnreadForMe(
        view("2026-10-16T10:00:00Z", [
          { authorId: "me-user", createdAt: "2026-10-16T11:00:00Z", readAt: null, deletedAt: null }
        ]),
        session
      )
    ).toBe(false);
  });
});
