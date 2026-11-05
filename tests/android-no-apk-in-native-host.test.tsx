// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MenuDrawer } from "../apps/web/src/MenuDrawer";

const noop = vi.fn();
let container: HTMLElement;
let root: Root;

async function renderMenu() {
  await act(async () =>
    root.render(
      <MenuDrawer
        open
        hasBusiness={false}
        signedOut
        onClose={noop}
        onBrowse={noop}
        onMessageHistory={noop}
        onGoToShop={noop}
        onShopSettings={noop}
        onAgentSettings={noop}
        onAccountSettings={noop}
        onSetUpShop={noop}
        onLogIn={noop}
        onSignUp={noop}
      />
    )
  );
  return document.body.querySelector('a[href$=".apk"]');
}

describe("APK download link", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.head.innerHTML = "";
  });

  it("shows in a browser", async () => {
    expect(await renderMenu()).not.toBeNull();
  });

  it("never shows inside the installed app, which Play requires to update through Play", async () => {
    const marker = document.createElement("meta");
    marker.name = "grogoni-native-channel";
    document.head.append(marker);
    expect(await renderMenu()).toBeNull();
  });
});
