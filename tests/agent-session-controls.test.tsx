// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentSessionHeaderControls,
  AgentSessionHistory,
  agentSessionsFor,
  isAgentSessionConversation
} from "../apps/web/src/AgentSessionControls";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const conversation = (
  id: string,
  overrides: Record<string, unknown> = {}
): Parameters<typeof agentSessionsFor>[0][number] =>
  ({
    id,
    kind: "personal",
    hasHumanRecipient: false,
    helpTopic: null,
    activeShopId: "shop-1",
    runtimeBindingId: "agent-shopkeeper",
    createdAt: "2026-11-20T08:00:00.000Z",
    lastMessage: null,
    title: null,
    ...overrides
  }) as never;

let host: HTMLDivElement | null = null;
afterEach(() => {
  host?.remove();
  host = null;
});
async function render(element: React.ReactElement) {
  host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  return host;
}

describe("agent sessions", () => {
  it("lists only the selected agent's sessions in the same shop", () => {
    const selected = conversation("s1");
    const all = [
      selected,
      conversation("s2"),
      conversation("other-agent", { runtimeBindingId: "agent-luna" }),
      conversation("other-shop", { activeShopId: "shop-2" }),
      conversation("person", { hasHumanRecipient: true }),
      conversation("help", { helpTopic: "billing" }),
      conversation("storefront", { kind: "storefront" })
    ];
    expect(agentSessionsFor(all, selected).map((item) => item.id)).toEqual(["s1", "s2"]);
    // A second agent has its own, independent list.
    expect(agentSessionsFor(all, all[2]).map((item) => item.id)).toEqual(["other-agent"]);
    // People and help topics have no sessions.
    expect(isAgentSessionConversation(all[4])).toBe(false);
    expect(agentSessionsFor(all, all[4])).toEqual([]);
    expect(agentSessionsFor(all, undefined)).toEqual([]);
  });

  it("toggles session history and starts a new session from the header", async () => {
    const onToggleHistory = vi.fn();
    const onNewSession = vi.fn();
    const view = await render(
      <AgentSessionHeaderControls
        historyOpen={false}
        onToggleHistory={onToggleHistory}
        onNewSession={onNewSession}
      />
    );
    const [history, newSession] = [...view.querySelectorAll("button")];
    expect(history!.textContent).toBe("Session history");
    expect(history!.getAttribute("aria-expanded")).toBe("false");
    await act(async () => history!.click());
    expect(onToggleHistory).toHaveBeenCalledOnce();
    expect(newSession!.textContent).toBe("+ New Session");
    await act(async () => newSession!.click());
    expect(onNewSession).toHaveBeenCalledOnce();
  });

  it("shows each session's title or 'New session' and its last message, and reopens it", async () => {
    const onOpen = vi.fn();
    const view = await render(
      <AgentSessionHistory
        sessions={[
          conversation("titled", {
            title: "Restock sugar",
            lastMessage: {
              id: "m1",
              content: { type: "text", text: "Order 20 bags" },
              author: "user"
            }
          }),
          conversation("untitled")
        ]}
        onOpen={onOpen}
      />
    );
    const items = [...view.querySelectorAll("section[aria-label='Session history'] button")];
    expect(items).toHaveLength(2);
    expect(items[0]!.querySelector("strong")!.textContent).toBe("Restock sugar");
    expect(items[0]!.textContent).toContain("Order 20 bags");
    expect(items[1]!.querySelector("strong")!.textContent).toBe("New session");
    expect(items[1]!.querySelector("time")!.getAttribute("dateTime")).toBe(
      "2026-11-20T08:00:00.000Z"
    );
    await act(async () => (items[0] as HTMLButtonElement).click());
    expect(onOpen).toHaveBeenCalledWith("titled");
  });
});
