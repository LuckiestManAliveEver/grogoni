// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ConversationInboxItem } from "@grogoni/shared-types";
import { HelpConversations } from "../apps/web/src/HelpConversations";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("opens the permanent parent or a separate help topic without destructive actions", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const select = vi.fn();
  try {
    await act(async () =>
      root.render(
        createElement(HelpConversations, {
          root: { id: "help" } as ConversationInboxItem,
          topics: [
            { id: "buy", title: "Buying" },
            { id: "tools", title: "Tools" }
          ] as ConversationInboxItem[],
          activeId: "tools",
          onSelect: select
        })
      )
    );
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual([
      "HelpAsk your agent for assistance",
      "Buying",
      "Tools"
    ]);
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe("Tools");
    await act(async () => buttons[2]!.click());
    expect(select).toHaveBeenCalledWith("tools");
    await act(async () => buttons[0]!.click());
    expect(select).toHaveBeenCalledWith("help");
    expect(container.textContent).not.toMatch(/Delete|Archive|Rename/);
  } finally {
    await act(async () => root.unmount());
  }
});
