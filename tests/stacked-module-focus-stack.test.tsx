// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StackedModule } from "../apps/web/src/StackedModule";

// Regression coverage for a bug found while testing audit A27's MerchantWorkspaceDashboard
// (docs/audits/grogoni-home-2026-09-17/audit.md): resizing below the compact-viewport breakpoint
// while the Workspace StackedModule stays open also turns the conversation inbox into its own
// StackedModule (ChatSurface.tsx's isCompactViewport branch), so two instances end up open at
// once. Each one used to install its own document-level Tab/Escape listener, so both acted on the
// same keypress and whichever mounted last won - Tab from the first module's last control jumped
// into the second module instead of wrapping, and Escape could close the wrong one. Only the most
// recently opened module should react.
function TwoModules({
  onCloseFirst,
  onCloseSecond
}: {
  onCloseFirst: () => void;
  onCloseSecond: () => void;
}) {
  return (
    <>
      <StackedModule moduleId="module-a" open title="Module A" onClose={onCloseFirst}>
        <button type="button">A first</button>
        <button type="button">A last</button>
      </StackedModule>
      <StackedModule moduleId="module-b" open title="Module B" onClose={onCloseSecond}>
        <button type="button">B first</button>
        <button type="button">B last</button>
      </StackedModule>
    </>
  );
}

// Each StackedModule instance schedules its own initial-focus rAF, and with two mounted in the
// same render their frames don't reliably settle within a fixed number of awaited rAF ticks -
// polling for the real settled state (module B's panel takes initial focus last, since it mounts
// after module A) is the deterministic way to know both have actually finished, instead of
// guessing a frame count and racing a still-pending rAF against the test's own interactions.
async function waitForInitialFocus(panelTitleId: string): Promise<void> {
  await vi.waitFor(() => {
    expect((document.activeElement as HTMLElement | null)?.getAttribute("aria-labelledby")).toBe(
      panelTitleId
    );
  });
}

describe("StackedModule with two instances open at once", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("does not touch the older module's controls when Tab doesn't need to wrap in the topmost one", async () => {
    // A non-topmost module's "focus escaped my panel" catch-all is true for literally anything
    // outside its own panel - including every element of the topmost module. Without the topmost
    // guard, pressing Tab from the middle of the topmost module's own content (no wrap needed)
    // still makes the older module fire, call preventDefault, and yank focus into itself; the
    // topmost module's own handler then "corrects" it back, so the *final* activeElement converges
    // to the same place either way and can't tell the two implementations apart - only whether the
    // older module's controls were ever focused in between actually distinguishes them.
    await act(async () => {
      root = createRoot(host);
      root.render(<TwoModules onCloseFirst={vi.fn()} onCloseSecond={vi.fn()} />);
    });
    await waitForInitialFocus("module-b-title");

    const aClose = document.body.querySelector<HTMLButtonElement>('[aria-label="Close Module A"]')!;
    const bFirst = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "B first"
    )!;
    const aCloseFocusSpy = vi.spyOn(aClose, "focus");

    bFirst.focus();
    expect(document.activeElement).toBe(bFirst);

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
      );
    });

    expect(aCloseFocusSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(bFirst);
  });

  it("wraps Tab to the topmost module's own first control when focus is at its last one", async () => {
    await act(async () => {
      root = createRoot(host);
      root.render(<TwoModules onCloseFirst={vi.fn()} onCloseSecond={vi.fn()} />);
    });
    await waitForInitialFocus("module-b-title");

    const bLast = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "B last"
    )!;
    bLast.focus();
    expect(document.activeElement).toBe(bLast);

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
      );
    });

    const bClose = document.body.querySelector<HTMLButtonElement>('[aria-label="Close Module B"]')!;
    expect(document.activeElement).toBe(bClose);
  });

  it("Escape closes only the most recently opened module", async () => {
    const onCloseFirst = vi.fn();
    const onCloseSecond = vi.fn();
    await act(async () => {
      root = createRoot(host);
      root.render(<TwoModules onCloseFirst={onCloseFirst} onCloseSecond={onCloseSecond} />);
    });
    await waitForInitialFocus("module-b-title");

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(onCloseSecond).toHaveBeenCalledTimes(1);
    expect(onCloseFirst).not.toHaveBeenCalled();
  });

  it("hands control back to the remaining module once the topmost one closes", async () => {
    let secondOpen = true;
    function Wrapper() {
      return (
        <>
          <StackedModule moduleId="module-a" open title="Module A" onClose={vi.fn()}>
            <button type="button">A first</button>
            <button type="button">A last</button>
          </StackedModule>
          <StackedModule moduleId="module-b" open={secondOpen} title="Module B" onClose={vi.fn()}>
            <button type="button">B first</button>
          </StackedModule>
        </>
      );
    }

    await act(async () => {
      root = createRoot(host);
      root.render(<Wrapper />);
    });
    await waitForInitialFocus("module-b-title");

    secondOpen = false;
    await act(async () => {
      root.render(<Wrapper />);
    });
    expect(document.body.querySelector('[aria-label="Close Module B"]')).toBeNull();

    const aLast = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "A last"
    )!;
    aLast.focus();

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
      );
    });

    const aClose = document.body.querySelector<HTMLButtonElement>('[aria-label="Close Module A"]')!;
    expect(document.activeElement).toBe(aClose);
  });
});
