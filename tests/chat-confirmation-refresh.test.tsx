// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("../apps/web/src/api-helpers", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  postJson: mocks.post
}));
import { useChatRuntimeState } from "../apps/web/src/hooks/useChatRuntimeState";

describe("chat confirmation completion", () => {
  it("finishes a saved action even while customer and history refreshes remain pending", async () => {
    const refresh = vi.fn(() => new Promise<void>(() => {}));
    const setStatusMessage = vi.fn();
    const setChatMessages = vi.fn();
    mocks.post.mockResolvedValue({
      session: { id: "runtime", turnCount: 2 },
      turn: {
        status: "completed",
        response: "Customer saved",
        plan: { toolName: "customer.create" }
      }
    });
    let hook: ReturnType<typeof useChatRuntimeState>;
    function Harness() {
      hook = useChatRuntimeState({
        business: { id: "shop" },
        session: null,
        mode: "seller",
        activeConversationId: null,
        chatMessages: [],
        runtimeSessionId: "runtime",
        setRuntimeSessionId: vi.fn(),
        setChatMessages,
        setStatusMessage,
        loadCustomers: refresh,
        loadRuntimeSessions: refresh,
        registerReset: vi.fn()
      } as unknown as Parameters<typeof useChatRuntimeState>[0]);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(createElement(Harness)));
      await act(async () => {
        await hook.confirmRuntimeAction("approval");
      });
    } finally {
      await act(async () => root.unmount());
    }
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(setStatusMessage).toHaveBeenCalledWith("Runtime completed");
    expect(setChatMessages).toHaveBeenCalled();
  });
});
