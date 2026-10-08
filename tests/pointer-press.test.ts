// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as PointerPressModule from "../apps/web/src/pointer-press";

// pointer-press keeps module state (installed listeners, the active press), so each test gets a
// fresh copy of the module and a fresh document listener set via resetModules.
type PointerPress = typeof PointerPressModule;
let press: PointerPress;

function fire(type: string, target: EventTarget = document.body) {
  target.dispatchEvent(new Event(type, { bubbles: true }));
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  press = await import("../apps/web/src/pointer-press");
  press.installPointerPressTracking();
});

afterEach(() => {
  // Close any press a test left open so the next module copy starts clean.
  fire("click");
  vi.runAllTimers();
  vi.useRealTimers();
});

describe("runAfterPointerPress", () => {
  it("runs immediately when no press is in progress (keyboard Tab blur)", () => {
    const callback = vi.fn();
    press.runAfterPointerPress(callback);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("waits for a mouse press's click, then runs after the click handler", () => {
    const order: string[] = [];
    document.body.addEventListener("click", () => order.push("click handler"));

    fire("pointerdown");
    press.runAfterPointerPress(() => order.push("blur work"));
    fire("pointerup");
    expect(order).toEqual([]);
    fire("click");
    expect(order).toEqual(["click handler"]);
    vi.runOnlyPendingTimers();
    expect(order).toEqual(["click handler", "blur work"]);
  });

  it("covers a touch tap, whose blur arrives after pointerup", () => {
    const callback = vi.fn();
    fire("pointerdown");
    fire("pointerup");
    // Touch: the compatibility mousedown blurs the input only now, after pointerup.
    press.runAfterPointerPress(callback);
    expect(callback).not.toHaveBeenCalled();
    fire("click");
    vi.runOnlyPendingTimers();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("still runs within the grace period when a press never produces a click (drag)", () => {
    const callback = vi.fn();
    fire("pointerdown");
    press.runAfterPointerPress(callback);
    fire("pointerup");
    vi.advanceTimersByTime(499);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    vi.runOnlyPendingTimers();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("flushes when the window loses focus mid-press", () => {
    const callback = vi.fn();
    fire("pointerdown");
    press.runAfterPointerPress(callback);
    fire("blur", window);
    vi.runOnlyPendingTimers();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("runs every callback queued during one press exactly once", () => {
    const first = vi.fn();
    const second = vi.fn();
    fire("pointerdown");
    press.runAfterPointerPress(first);
    press.runAfterPointerPress(second);
    fire("click");
    fire("click");
    vi.runAllTimers();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("keeps running queued callbacks when one throws, and still surfaces the error", () => {
    const surfaced: Array<() => void> = [];
    const microtask = vi
      .spyOn(globalThis, "queueMicrotask")
      .mockImplementation((task) => surfaced.push(task));
    const after = vi.fn();

    fire("pointerdown");
    press.runAfterPointerPress(() => {
      throw new Error("blur check failed");
    });
    press.runAfterPointerPress(after);
    fire("click");
    vi.runOnlyPendingTimers();
    microtask.mockRestore();

    expect(after).toHaveBeenCalledTimes(1);
    expect(surfaced).toHaveLength(1);
    expect(() => surfaced[0]!()).toThrow("blur check failed");
  });
});
