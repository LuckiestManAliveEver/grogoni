// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBusinessViewRefresh } from "../apps/web/src/hooks/useViewRefresh";

const state = vi.hoisted(() => ({
  listeners: new Set<(path: string) => void>(),
  prefetch: vi.fn(() => vi.fn())
}));
vi.mock("../apps/web/src/api-request-cache", () => ({
  subscribeToApiMutations(listener: (path: string) => void) {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  }
}));
vi.mock("../apps/web/src/prefetch", () => ({
  likelyNextOwnerViews: () => ["products"],
  scheduleIdleOwnerPrefetch: state.prefetch
}));

describe("business view refresh subscriptions", () => {
  let root: Root;
  let element: HTMLDivElement;
  const refresh = vi.fn().mockResolvedValue(undefined);
  function Harness({ enabled = true }: { enabled?: boolean }) {
    useBusinessViewRefresh("shop-1", enabled, "chat", () => [refresh]);
    return null;
  }
  beforeEach(() => {
    vi.useFakeTimers();
    refresh.mockClear();
    state.prefetch.mockClear();
    state.listeners.clear();
    element = document.createElement("div");
    root = createRoot(element);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
  });
  function emit(path: string) {
    for (const listener of state.listeners) listener(path);
  }
  it("debounces owned business changes and excludes foreign shops and runtime writes", async () => {
    await act(async () => root.render(<Harness />));
    emit("/businesses/other/products");
    emit("/businesses/shop-1/runtime/turns");
    await vi.advanceTimersByTimeAsync(50);
    expect(refresh).not.toHaveBeenCalled();
    emit("/businesses/shop-1/products");
    emit("/businesses/shop-1/customers");
    await vi.advanceTimersByTimeAsync(50);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith("shop-1");
    expect(state.prefetch).toHaveBeenCalledWith(["products"], "shop-1");
  });
  it("does not subscribe when disabled and cancels pending refresh work on unmount", async () => {
    await act(async () => root.render(<Harness enabled={false} />));
    expect(state.listeners.size).toBe(0);
    await act(async () => root.render(<Harness />));
    emit("/network");
    await act(async () => root.unmount());
    expect(state.listeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(refresh).not.toHaveBeenCalled();
    root = createRoot(element);
  });
});
