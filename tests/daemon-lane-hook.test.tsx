// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserDaemonLaneLoop } from "../apps/web/src/daemon-lane";
import {
  daemonLaneWakeEvent,
  stopDaemonLane,
  useDaemonLane
} from "../apps/web/src/hooks/useDaemonLane";

interface Lane {
  loop: BrowserDaemonLaneLoop;
  stopCalls: number;
  stopped: boolean;
}
const state = vi.hoisted(() => ({
  lanes: [] as Lane[],
  stopDelayMs: 0,
  fetches: [] as string[],
  idleModel: "Qwen-MLC" as string | null
}));
vi.mock("../apps/web/src/daemon-lane", () => ({
  startBrowserDaemonLane(loop: BrowserDaemonLaneLoop) {
    const lane: Lane = { loop, stopCalls: 0, stopped: false };
    state.lanes.push(lane);
    return async () => {
      lane.stopCalls++;
      await new Promise((resolve) => setTimeout(resolve, state.stopDelayMs));
      lane.stopped = true;
    };
  }
}));
vi.mock("../apps/web/src/lib/api", () => ({
  apiCloudFetch: async (path: string) => {
    state.fetches.push(path);
    return { claim: null, nextDueInMs: null };
  }
}));
vi.mock("../apps/web/src/offline-runtime", () => ({ isExplicitOfflineMode: () => false }));
vi.mock("../apps/web/src/device-models", () => ({
  idleLoadedDeviceModel: () => state.idleModel
}));

describe("useDaemonLane", () => {
  let root: Root;
  function Harness({ accountId }: { accountId: string | null }) {
    useDaemonLane(accountId);
    return null;
  }
  beforeEach(() => {
    state.lanes.length = 0;
    state.stopDelayMs = 0;
    state.idleModel = "Qwen-MLC";
    state.fetches.length = 0;
    root = createRoot(document.createElement("div"));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
  });

  it("runs only while signed in, and restarts for another account", async () => {
    await act(async () => root.render(<Harness accountId={null} />));
    expect(state.lanes).toHaveLength(0);
    await act(async () => root.render(<Harness accountId="a" />));
    expect(state.lanes).toHaveLength(1);
    await act(async () => root.render(<Harness accountId="a" />));
    expect(state.lanes).toHaveLength(1);
    await act(async () => root.render(<Harness accountId="b" />));
    expect(state.lanes.map((lane) => lane.stopCalls)).toEqual([1, 0]);
    await act(async () => root.render(<Harness accountId={null} />));
    expect(state.lanes.map((lane) => lane.stopCalls)).toEqual([1, 1]);
  });

  it("lets sign-out wait for the lane to release its task, but never more than 3s", async () => {
    await act(async () => root.render(<Harness accountId="a" />));
    state.stopDelayMs = 50;
    await stopDaemonLane();
    expect(state.lanes[0]).toMatchObject({ stopCalls: 1, stopped: true });
    // Already stopped: nothing left to wait for.
    await stopDaemonLane();
    expect(state.lanes[0]!.stopCalls).toBe(1);
    await act(async () => root.render(<Harness accountId="b" />));
    state.stopDelayMs = 60_000;
    vi.useFakeTimers();
    try {
      const waiting = stopDaemonLane();
      await vi.advanceTimersByTimeAsync(3_000);
      await waiting;
      // Sign-out went ahead after 3s although the lane is still finishing a server run.
      expect(state.lanes[1]).toMatchObject({ stopCalls: 1, stopped: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("talks to the cloud API, picks the installed device model, and wakes on its event", async () => {
    await act(async () => root.render(<Harness accountId="a" />));
    const loop = state.lanes[0]!.loop;
    await loop.request("/v1/daemon/claims", { method: "POST", body: {} });
    expect(state.fetches).toEqual(["/v1/daemon/claims"]);
    expect(loop.device()?.modelId).toBe("Qwen-MLC");
    // Busy, or nothing loaded: the server runs it; the lane never loads or swaps a model.
    state.idleModel = null;
    expect(loop.device()).toBeNull();
    const listener = vi.fn();
    const unsubscribe = loop.onWake(listener);
    window.dispatchEvent(new Event(daemonLaneWakeEvent));
    window.dispatchEvent(new Event("online"));
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    window.dispatchEvent(new Event(daemonLaneWakeEvent));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("is active only while visible and online", async () => {
    await act(async () => root.render(<Harness accountId="a" />));
    const loop = state.lanes[0]!.loop;
    const visibility = vi.spyOn(document, "visibilityState", "get");
    const online = vi.spyOn(navigator, "onLine", "get");
    visibility.mockReturnValue("visible");
    online.mockReturnValue(true);
    expect(loop.isActive()).toBe(true);
    visibility.mockReturnValue("hidden");
    expect(loop.isActive()).toBe(false);
    visibility.mockReturnValue("visible");
    online.mockReturnValue(false);
    expect(loop.isActive()).toBe(false);
    visibility.mockRestore();
    online.mockRestore();
  });

  it("lets one tab at a time work the lane through a Web Lock", async () => {
    await act(async () => root.render(<Harness accountId="a" />));
    const loop = state.lanes[0]!.loop;
    let held = false;
    const locks = {
      request: async (
        name: string,
        options: { ifAvailable: boolean },
        callback: (lock: object | null) => Promise<unknown>
      ) => {
        expect(name).toBe("grogoni-daemon-lane");
        expect(options.ifAvailable).toBe(true);
        if (held) return callback(null);
        held = true;
        try {
          return await callback({});
        } finally {
          held = false;
        }
      }
    };
    Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
    try {
      let release: () => void = () => {};
      const first = loop.exclusive(
        () => new Promise<string>((resolve) => (release = () => resolve("ran")))
      );
      expect(await loop.exclusive(async () => "second tab")).toBeNull();
      release();
      expect(await first).toBe("ran");
    } finally {
      Reflect.deleteProperty(navigator, "locks");
    }
  });
});
