// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChatInboxState } from "../apps/web/src/hooks/useChatInboxState";
import { queueMessagingOutbox, readMessagingOutbox } from "../apps/web/src/messaging/outbox";
import type { SessionResponse } from "../apps/web/src/grogoni-application-shared";

/**
 * A send that failed with a 503 waits in the outbox. Before, it was resent only on the browser's
 * `online` event, so an online user's message waited forever. The 4-second refresh now resends
 * it on a per-message backoff that stops after three tries (each resend of an agent message is a
 * paid model turn), never in two overlapping passes or two tabs at once (it would post twice).
 */
describe("automatic outbox resend", () => {
  let host: HTMLDivElement;
  let root: Root;
  let inbox: ReturnType<typeof useChatInboxState> | null = null;
  const session = {
    account: { id: "account-1" },
    user: { id: "user-1" }
  } as unknown as SessionResponse;
  let postResolvers: Array<() => void> = [];
  let posts = 0;

  function Harness() {
    inbox = useChatInboxState({
      business: null,
      session,
      e2eeIdentity: null,
      mode: "seller",
      setStatusMessage: () => undefined,
      setView: () => undefined,
      applySessionContextForConversation: async () => null,
      requireMessagingSignIn: () => undefined,
      chatMessages: [],
      setChatMessages: () => undefined,
      setChatDraft: () => undefined,
      setReplyToMessageId: () => undefined,
      registerReset: () => undefined
    });
    return null;
  }

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    window.matchMedia = ((query: string) => ({ matches: false, media: query })) as never;
    posts = 0;
    postResolvers = [];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T10:00:00Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (!String(input).includes("/v1/messages")) return new Response("{}", { status: 200 });
        posts++;
        await new Promise<void>((resolve) => postResolvers.push(resolve));
        return new Response(JSON.stringify({ code: "service_unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" }
        });
      })
    );
    queueMessagingOutbox({
      accountId: "account-1",
      clientMessageId: "client-message-1",
      payload: { conversationId: "c1", clientMessageId: "client-message-1" },
      attempts: 0,
      nextAttemptAt: Date.parse("2026-10-16T10:00:15Z")
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<Harness />));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function settle() {
    for (let round = 0; round < 5; round++) {
      for (const resolve of postResolvers.splice(0)) resolve();
      for (let tick = 0; tick < 20; tick++) await Promise.resolve();
    }
  }

  async function automaticAt(iso: string) {
    vi.setSystemTime(new Date(iso));
    await act(async () => {
      const pass = inbox!.retryQueuedMessages({ automatic: true });
      await settle();
      await pass;
    });
  }

  it("resends on its own with backoff (15 s, 1 min, 4 min), then stops and waits for a tap", async () => {
    await automaticAt("2026-10-16T10:00:04Z"); // queued at 10:00:00: first resend due at :15
    expect(posts).toBe(0);
    await automaticAt("2026-10-16T10:00:16Z");
    expect(posts).toBe(1);
    await automaticAt("2026-10-16T10:00:40Z"); // next due one minute after that failure
    expect(posts).toBe(1);
    await automaticAt("2026-10-16T10:01:17Z");
    expect(posts).toBe(2);
    await automaticAt("2026-10-16T10:05:18Z");
    expect(posts).toBe(3);
    // Three automatic resends used: an agent message reruns a paid turn each time, so it stops.
    await automaticAt("2026-10-16T12:00:00Z");
    expect(posts).toBe(3);
    expect(readMessagingOutbox("account-1")[0]).toMatchObject({ attempts: 3 });
    // The resend control still sends on a tap.
    await act(async () => {
      const manual = inbox!.retryQueuedMessages();
      await settle();
      await manual;
    });
    expect(posts).toBe(4);
  });

  it("never runs two passes at once, even a manual tap during an automatic one", async () => {
    vi.setSystemTime(new Date("2026-10-16T10:00:16Z"));
    const automatic = inbox!.retryQueuedMessages({ automatic: true });
    await Promise.resolve();
    await act(async () => inbox!.retryQueuedMessages());
    expect(posts).toBe(1);
    await act(async () => {
      await settle();
      await automatic;
    });
  });

  it("leaves the queue to the tab that holds the cross-tab lock", async () => {
    vi.setSystemTime(new Date("2026-10-16T10:00:16Z"));
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: async (_name: string, _options: unknown, callback: (lock: null) => unknown) =>
          callback(null)
      }
    });
    try {
      await act(async () => inbox!.retryQueuedMessages({ automatic: true }));
      expect(posts).toBe(0);
    } finally {
      Reflect.deleteProperty(navigator, "locks");
    }
  });

  it("stops resending a message the server refuses for good", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        posts++;
        return new Response(JSON.stringify({ code: "validation_failed", message: "Too long" }), {
          status: 400,
          headers: { "content-type": "application/json" }
        });
      })
    );
    await automaticAt("2026-10-16T10:00:16Z");
    expect(posts).toBe(1);
    expect(readMessagingOutbox("account-1")).toEqual([]);
    await automaticAt("2026-10-16T11:00:00Z");
    expect(posts).toBe(1);
  });
});
