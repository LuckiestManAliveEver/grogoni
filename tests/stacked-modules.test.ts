// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { shouldCloseStackedModuleFromSwipe } from "../apps/web/src/stacked-module-behavior";
import { readOwnerRoute } from "../apps/web/src/routes";

const application = readFileSync("apps/web/src/GrogoniApplication.tsx", "utf8");
const chatSurface = readFileSync("apps/web/src/ChatSurface.tsx", "utf8");
const navigationState = readFileSync("apps/web/src/hooks/useNavigationState.ts", "utf8");
const modulePrimitive = readFileSync("apps/web/src/StackedModule.tsx", "utf8");
const moduleSwipe = readFileSync("apps/web/src/hooks/useStackedModuleSwipe.ts", "utf8");

describe("stacked secondary modules", () => {
  it("closes from its control, scrim, Escape, and downward swipe threshold", () => {
    expect(modulePrimitive).toContain("if (event.target === event.currentTarget) onClose();");
    expect(modulePrimitive).toContain('if (event.key === "Escape")');
    expect(modulePrimitive).toContain("onClick={onClose}");
    expect(moduleSwipe).toContain(
      'event.target.closest("button, a[href], input, select, textarea")'
    );
    expect(moduleSwipe).toContain("shouldCloseStackedModuleFromSwipe(startY, event.clientY)");
    expect(shouldCloseStackedModuleFromSwipe(20, 91)).toBe(false);
    expect(shouldCloseStackedModuleFromSwipe(20, 92)).toBe(true);
  });

  it("keeps the conversation tree mounted behind every secondary surface", () => {
    expect(chatSurface).toContain("const showMessageThread = true;");
    expect(chatSurface).toContain('moduleId="owner-management"');
    expect(chatSurface).toContain('moduleId="marketplace"');
    expect(chatSurface).toContain('moduleId="workspace"');
    expect(chatSurface.indexOf('<div className="message-list"')).toBeLessThan(
      chatSurface.indexOf('moduleId="owner-management"')
    );
    expect(application).toMatch(/<ChatSurface[\s\S]*<AgentProfileSurface/u);
    expect(modulePrimitive).toContain("createPortal(");
    expect(modulePrimitive).toContain('appRoot?.setAttribute("inert", "")');
  });

  it("opens secondary surfaces without adding history or changing conversation scroll", () => {
    const navigateBlock = sourceFunction(navigationState, "navigateToView");
    const secondaryBranch = navigateBlock.slice(
      navigateBlock.indexOf('if (nextView !== "chat"'),
      navigateBlock.indexOf("const nextRoute")
    );
    const openProductBlock = sourceFunction(navigationState, "openProduct");
    const openAgentBlock = sourceFunction(navigationState, "openAgentProfile");

    expect(secondaryBranch).toContain("return;");
    expect(secondaryBranch).not.toContain("navigateToOwnerRoute");
    expect(secondaryBranch).not.toContain("restoreScreenScroll");
    expect(openProductBlock).not.toContain("navigateToOwnerRoute");
    expect(openAgentBlock).not.toContain("navigateToOwnerRoute");
  });

  it("drops the conversation list into the shared StackedModule drawer below the desktop breakpoint", () => {
    const compactViewportHook = readFileSync("apps/web/src/hooks/useCompactViewport.ts", "utf8");

    expect(chatSurface).toContain("const isCompactViewport = useCompactViewport();");
    expect(chatSurface).toContain("isCompactViewport ? (");
    expect(chatSurface).toContain('moduleId="messenger-inbox"');
    expect(chatSurface).toContain(
      "<ConversationListPanel showHeading={false} {...conversationListPanelProps} />"
    );
    expect(chatSurface).toContain('aria-label="Conversations"');
    expect(chatSurface).toContain(
      "<ConversationListPanel showHeading={true} {...conversationListPanelProps} />"
    );
    // Compact navigation is embedded so the thread composer remains interactive.
    expect(chatSurface).toContain("embedded={isCompactViewport}");
    expect(chatSurface.indexOf("isCompactViewport ? (")).toBeLessThan(
      chatSurface.indexOf('aria-label="Conversations"')
    );
    expect(compactViewportHook).toContain('"(max-width: 759px)"');
  });

  it("retains legacy links as module-preopened bootstrap payloads", () => {
    expect(readOwnerRoute("/marketplace")).toEqual({ mode: "marketplace", view: "chat" });
    expect(readOwnerRoute("/settings")).toEqual({ mode: "seller", view: "agent" });
    expect(readOwnerRoute("/products/product%201")).toEqual({
      mode: "seller",
      view: "products",
      productId: "product 1"
    });
    expect(application).toContain("initialMarketplaceShortcutOpen:");
    expect(application).toContain("initialRoutedProductId: initialOwnerRoute?.productId ?? null");
  });
});

function sourceFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf("\n  function ", start + 1);
  return source.slice(start, end);
}
