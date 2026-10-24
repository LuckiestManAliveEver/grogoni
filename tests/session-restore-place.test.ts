import { describe, expect, it } from "vitest";
import { readDeepLinkedPlace, resolveRestoredPlace } from "../apps/web/src/session-restore-place";

const last = { mode: "seller", view: "chat", conversationId: "last-conversation" } as const;

describe("readDeepLinkedPlace", () => {
  it("names no place for the bare root, the old /chat alias, and non-owner pages", () => {
    expect(readDeepLinkedPlace("/")).toBeNull();
    expect(readDeepLinkedPlace("/chat")).toBeNull();
    expect(readDeepLinkedPlace("/chat/")).toBeNull();
    expect(readDeepLinkedPlace("/login")).toBeNull();
    expect(readDeepLinkedPlace("/agent/some-public-agent")).toBeNull();
  });

  it("reads the Shop Hub, conversations, modes and modules, ignoring a trailing slash", () => {
    expect(readDeepLinkedPlace("/sell/shop/")).toEqual({
      path: "/sell/shop",
      route: { mode: "seller", view: "chat", panel: "shop-hub" }
    });
    expect(readDeepLinkedPlace("/marketplace/conversations/c1")?.route).toEqual({
      mode: "marketplace",
      view: "chat",
      conversationId: "c1"
    });
    expect(readDeepLinkedPlace("/marketplace")?.route.mode).toBe("marketplace");
    expect(readDeepLinkedPlace("/invoices")?.route.view).toBe("invoices");
  });
});

describe("resolveRestoredPlace", () => {
  it("restores and navigates to the last place without a deep link", () => {
    expect(resolveRestoredPlace({ deepLink: null, currentPath: "/", hasShop: true, last })).toEqual(
      {
        ...last,
        navigateTo: { mode: "seller", view: "chat", conversationId: "last-conversation" }
      }
    );
  });

  it("keeps the URL for a deep link the user is still on", () => {
    const deepLink = readDeepLinkedPlace("/marketplace");
    expect(
      resolveRestoredPlace({ deepLink, currentPath: "/marketplace/", hasShop: true, last })
    ).toEqual({ mode: "marketplace", view: "chat", conversationId: undefined, navigateTo: null });
  });

  it("opens the Shop Hub's setup for a seller link without a shop", () => {
    const deepLink = readDeepLinkedPlace("/invoices");
    expect(
      resolveRestoredPlace({ deepLink, currentPath: "/invoices", hasShop: false, last })
    ).toMatchObject({ mode: "seller", navigateTo: { panel: "shop-hub" } });
  });

  it("keeps a marketplace link without a shop", () => {
    const deepLink = readDeepLinkedPlace("/marketplace/conversations/c1");
    expect(
      resolveRestoredPlace({
        deepLink,
        currentPath: "/marketplace/conversations/c1",
        hasShop: false,
        last: { ...last, mode: "marketplace" }
      })
    ).toEqual({ mode: "marketplace", view: "chat", conversationId: "c1", navigateTo: null });
  });
});
