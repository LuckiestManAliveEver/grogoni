// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MenuDrawer, type MenuDrawerProps } from "../apps/web/src/MenuDrawer";

// The customer home's header has no Log in / Sign up buttons (unified-chat spec, see
// grogoni-home-progressive-entry.test.ts), so the menu drawer is a signed-out visitor's always
// reachable way in. These items must show only while signed out and call the matching handler.
function renderDrawer(overrides: Partial<MenuDrawerProps>) {
  const props: MenuDrawerProps = {
    open: true,
    hasBusiness: false,
    signedOut: true,
    onClose: vi.fn(),
    onBrowse: vi.fn(),
    onMessageHistory: vi.fn(),
    onGoToShop: vi.fn(),
    onShopSettings: vi.fn(),
    onAgentSettings: vi.fn(),
    onAccountSettings: vi.fn(),
    onSetUpShop: vi.fn(),
    onLogIn: vi.fn(),
    onSignUp: vi.fn(),
    ...overrides
  };
  act(() => root.render(<MenuDrawer {...props} />));
  return props;
}

function menuItems(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button.menu-item"));
}

function menuItem(label: string): HTMLButtonElement | undefined {
  return menuItems().find((button) => button.textContent?.trim() === label);
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("MenuDrawer sign-in entry", () => {
  it("leads with Log in then Sign up for a signed-out visitor", () => {
    renderDrawer({ signedOut: true });
    const labels = menuItems().map((button) => button.textContent?.trim());
    expect(labels.slice(0, 2)).toEqual(["Log in", "Sign up"]);
  });

  it("calls onLogIn and onSignUp from the matching items", () => {
    const props = renderDrawer({ signedOut: true });
    act(() => menuItem("Log in")?.click());
    expect(props.onLogIn).toHaveBeenCalledTimes(1);
    expect(props.onSignUp).not.toHaveBeenCalled();
    act(() => menuItem("Sign up")?.click());
    expect(props.onSignUp).toHaveBeenCalledTimes(1);
  });

  it("hides both items once signed in, with or without a shop", () => {
    for (const hasBusiness of [false, true]) {
      renderDrawer({ signedOut: false, hasBusiness });
      expect(menuItem("Log in")).toBeUndefined();
      expect(menuItem("Sign up")).toBeUndefined();
      expect(menuItem("Message history")).toBeDefined();
    }
  });

  it("keeps the rest of the menu intact for a signed-out visitor", () => {
    renderDrawer({ signedOut: true, hasBusiness: false });
    expect(menuItem("Message history")).toBeDefined();
    expect(menuItem("Browse marketplace")).toBeDefined();
    expect(menuItem("Set up your shop")).toBeDefined();
  });
});
