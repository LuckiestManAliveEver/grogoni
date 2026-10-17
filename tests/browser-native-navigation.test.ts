// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canNavigateBackWithinApp,
  initializeOwnerHistory,
  navigateToBrowserUrl,
  navigateToOwnerRoute,
  readGrogoniHistoryState
} from "../apps/web/src/browser-navigation";
import {
  readOwnerNavigationSession,
  scheduleOwnerNavigationSessionWrite,
  writeOwnerNavigationSession
} from "../apps/web/src/owner-navigation-session";

describe("browser-native navigation", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/marketplace");
    window.sessionStorage.clear();
    vi.stubGlobal("scrollTo", vi.fn());
  });

  it("creates typed history entries and avoids duplicates", () => {
    initializeOwnerHistory({ mode: "marketplace", view: "chat" });
    const initialLength = window.history.length;

    expect(navigateToOwnerRoute({ mode: "seller", view: "products" })).toBe(true);
    expect(window.location.pathname).toBe("/catalogue");
    expect(window.history.length).toBe(initialLength + 1);
    expect(readGrogoniHistoryState(window.history.state)).toMatchObject({
      depth: 1,
      mode: "seller",
      view: "products"
    });
    expect(canNavigateBackWithinApp()).toBe(true);

    expect(navigateToOwnerRoute({ mode: "seller", view: "products" })).toBe(false);
    expect(window.history.length).toBe(initialLength + 1);
  });

  it("uses canonical URLs for conversations, products, profiles, and storefront products", () => {
    initializeOwnerHistory({ mode: "marketplace", view: "chat" });

    navigateToOwnerRoute({
      mode: "marketplace",
      view: "chat",
      conversationId: "conversation / 1"
    });
    expect(window.location.pathname).toBe("/marketplace/conversations/conversation%20%2F%201");

    navigateToOwnerRoute({
      mode: "seller",
      view: "products",
      productId: "product / 1"
    });
    expect(window.location.pathname).toBe("/products/product%20%2F%201");

    navigateToOwnerRoute({
      mode: "seller",
      view: "agent",
      agentId: "agent@example.com"
    });
    expect(window.location.pathname).toBe("/agents/agent%40example.com");

    navigateToBrowserUrl("/agent/shop-1/products/product-1");
    expect(window.location.pathname).toBe("/agent/shop-1/products/product-1");
  });

  it("restores bounded chat and agent-session state across refresh without attachment bodies", () => {
    writeOwnerNavigationSession("account-1", {
      activeConversationId: "conversation-1",
      runtimeSessionId: "runtime-1",
      chatDraft: "Unsaved reply",
      chatMessages: [
        {
          id: "message-1",
          author: "merchant",
          body: "Hello",
          attachments: [
            {
              id: "attachment-1",
              name: "receipt.jpg",
              type: "image/jpeg",
              size: 10,
              category: "image",
              dataUrl: "data:image/jpeg;base64,private"
            }
          ]
        }
      ]
    });

    expect(readOwnerNavigationSession("account-1")).toEqual({
      activeConversationId: "conversation-1",
      runtimeSessionId: "runtime-1",
      chatDraft: "Unsaved reply",
      chatMessages: [
        {
          id: "message-1",
          author: "merchant",
          body: "Hello",
          attachments: [
            {
              id: "attachment-1",
              name: "receipt.jpg",
              type: "image/jpeg",
              size: 10,
              category: "image"
            }
          ]
        }
      ]
    });
    expect(readOwnerNavigationSession("account-2")).toBeNull();
  });

  it("a synchronous reload snapshot supersedes an older debounced write", () => {
    vi.useFakeTimers();
    try {
      const value = (body: string) => ({
        activeConversationId: null,
        runtimeSessionId: null,
        chatDraft: "",
        chatMessages: [{ id: "reminder", author: "grogoniclaw" as const, body }]
      });
      scheduleOwnerNavigationSessionWrite("reload-reminder", value("pending"));
      writeOwnerNavigationSession("reload-reminder", value("Reminder scheduled"));
      vi.runAllTimers();
      expect(readOwnerNavigationSession("reload-reminder")?.chatMessages[0]?.body).toBe(
        "Reminder scheduled"
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces rapid draft persistence so typing does not serialize the conversation per key", () => {
    vi.useFakeTimers();
    const storage = {
      getItem: vi.fn(() => null),
      removeItem: vi.fn(),
      setItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(() => null),
      length: 0
    } satisfies Storage;
    const value = (chatDraft: string) => ({
      activeConversationId: "conversation-1",
      runtimeSessionId: "runtime-1",
      chatDraft,
      chatMessages: []
    });

    scheduleOwnerNavigationSessionWrite("account-fast", value("a"), storage);
    scheduleOwnerNavigationSessionWrite("account-fast", value("ab"), storage);
    scheduleOwnerNavigationSessionWrite("account-fast", value("abc"), storage);
    expect(storage.setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem.mock.calls[0]?.[1]).toContain('"chatDraft":"abc"');
    vi.useRealTimers();
  });

  it("keeps all application pushes behind the central adapter", () => {
    const application = readFileSync("apps/web/src/GrogoniApplication.tsx", "utf8");
    const chatInboxState = readFileSync("apps/web/src/hooks/useChatInboxState.ts", "utf8");
    const router = readFileSync("apps/web/src/AppRouter.tsx", "utf8");
    const worker = readFileSync("apps/web/public/sw.js", "utf8");

    expect(application).not.toContain("window.history.pushState");
    expect(chatInboxState).toContain(
      'navigateToOwnerRoute({ mode: restoredMode ?? mode, view: "chat", conversationId });'
    );
    expect(application).toContain("scheduleOwnerNavigationSessionWrite");
    expect(router).toContain("installBrowserLinkInterceptor");
    expect(worker).toContain("/marketplace/conversations/");
  });
});
