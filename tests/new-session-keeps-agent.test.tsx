// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ApiHelpers from "../apps/web/src/api-helpers";
import type { ChatMessage } from "../apps/web/src/app-shell";

vi.mock("../apps/web/src/api-helpers", async () => {
  const actual = await vi.importActual<typeof ApiHelpers>("../apps/web/src/api-helpers");
  const getJson = vi.fn();
  return {
    ...actual,
    getJson,
    fetchFreshJson: vi.fn((path: string) => getJson(path)),
    postJson: vi.fn(),
    patchJson: vi.fn(async () => ({}))
  };
});

const { getJson, postJson } = await import("../apps/web/src/api-helpers");
const { useChatInboxState } = await import("../apps/web/src/hooks/useChatInboxState");

/**
 * Since #83 a new session is started from the Chats list, from the agent of the thread that is
 * open. Two agents of one account (the shop's agent and the Grogoni agent): a session started
 * from one must belong to that agent (its shop and runtime binding), never to the other.
 */
describe("New session keeps the open thread's agent", () => {
  let host: HTMLDivElement;
  let root: Root;
  let inbox: ReturnType<typeof useChatInboxState> | null = null;
  const session = { account: { id: "account-1" }, user: { id: "user-1" } } as never;
  const agents = {
    "shop-session": { activeShopId: "shop-1", runtimeBindingId: "binding-shop" },
    "grogoni-session": { activeShopId: null, runtimeBindingId: "binding-grogoni" }
  } as const;
  const summary = (id: keyof typeof agents | string) => ({
    id,
    title: id,
    kind: "personal",
    conversationType: "DAEMON",
    hasHumanRecipient: false,
    isPermanentDaemon: false,
    helpTopic: null,
    lastMessage: null,
    unreadCount: 0,
    updatedAt: "2026-11-22T00:00:00Z",
    participant: { id: `p-${id}`, role: "account", accountId: "account-1" },
    ...(agents[id as keyof typeof agents] ?? { activeShopId: null, runtimeBindingId: null })
  });
  const view = (id: string) => ({
    conversation: summary(id),
    participants: [{ role: "account", accountId: "account-1" }],
    messages: [],
    typing: []
  });

  function Harness() {
    const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
    const [chatDraft, setChatDraft] = useState("");
    inbox = useChatInboxState({
      business: { id: "shop-1", name: "Bravo Bakery", role: "owner" } as never,
      session,
      e2eeIdentity: null,
      mode: "seller",
      setStatusMessage: () => undefined,
      setView: () => undefined,
      applySessionContextForConversation: async () => null,
      requireMessagingSignIn: () => undefined,
      chatMessages,
      chatDraft,
      isSendInFlight: () => false,
      setChatMessages,
      setChatDraft,
      setReplyToMessageId: () => undefined,
      registerReset: () => undefined
    });
    return null;
  }

  beforeEach(async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false
    })) as never;
    let created = 0;
    vi.mocked(getJson).mockImplementation(async (path: string) => {
      if (path === "/v1/conversations")
        return { conversations: [summary("shop-session"), summary("grogoni-session")] };
      return view(String(path).split("?")[0]!.split("/").at(-1)!);
    });
    vi.mocked(postJson).mockImplementation(async (path: string, body: Record<string, unknown>) => {
      if (path !== "/v1/conversations") return {};
      created += 1;
      return {
        ...view(`new-session-${created}`),
        conversation: { ...summary(`new-session-${created}`), ...body }
      };
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<Harness />));
    await act(async () => {
      await inbox!.loadMessagingInbox(null);
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.mocked(postJson).mockReset();
  });

  const startSessionFrom = async (conversationId: string) => {
    await act(async () => {
      await inbox!.selectConversation(conversationId);
    });
    vi.mocked(postJson).mockClear();
    await act(async () => {
      await inbox!.createAgentSession();
    });
    return vi
      .mocked(postJson)
      .mock.calls.filter(([path]) => path === "/v1/conversations")
      .map(([, body]) => body);
  };

  it("binds a session started from the shop agent's thread to the shop agent", async () => {
    expect(await startSessionFrom("shop-session")).toEqual([
      { kind: "personal", activeShopId: "shop-1", runtimeBindingId: "binding-shop" }
    ]);
  });

  it("binds a session started from the Grogoni agent's thread to the Grogoni agent", async () => {
    expect(await startSessionFrom("grogoni-session")).toEqual([
      { kind: "personal", activeShopId: null, runtimeBindingId: "binding-grogoni" }
    ]);
  });
});
