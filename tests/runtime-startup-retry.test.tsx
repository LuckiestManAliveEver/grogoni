// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useRuntimeHistoryState } from "../apps/web/src/hooks/useRuntimeHistoryState";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("retries a transient runtime creation failure with the same idempotency key", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  const keys: string[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    keys.push(JSON.parse(String(init.body)).idempotencyKey);
    return new Response(
      JSON.stringify(
        keys.length === 1
          ? { code: "api_unavailable", message: "Unavailable" }
          : { id: "runtime-1" }
      ),
      { status: keys.length === 1 ? 503 : 200, headers: { "content-type": "application/json" } }
    );
  });
  const root = createRoot(document.createElement("div"));
  let runtime: ReturnType<typeof useRuntimeHistoryState>;
  function Harness() {
    runtime = useRuntimeHistoryState({
      business: { id: "shop" },
      session: { account: { id: "seller" } },
      setStatusMessage: () => undefined,
      registerReset: () => undefined,
      registerRefresh: () => undefined
    });
    return null;
  }
  try {
    await act(async () => root.render(<Harness />));
    let creating: Promise<string>;
    await act(async () => {
      creating = runtime!.createManagedRuntimeSession();
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
      expect(await creating!).toBe("runtime-1");
    });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  } finally {
    await act(async () => root.unmount());
  }
});
