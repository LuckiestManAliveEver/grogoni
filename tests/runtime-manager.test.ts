import { describe, expect, it, vi } from "vitest";
import { isExpiredRuntimeSessionError, RuntimeManager } from "../apps/web/src/runtime-manager";

describe("application runtime manager", () => {
  it("deduplicates concurrent initialization and reuses the session", async () => {
    const manager = new RuntimeManager();
    const create = vi.fn(async () => "runtime-1");

    const [first, second] = await Promise.all([
      manager.ensureSession("account:business", create),
      manager.ensureSession("account:business", create)
    ]);
    const third = await manager.ensureSession("account:business", create);

    expect([first, second, third]).toEqual(["runtime-1", "runtime-1", "runtime-1"]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(manager.getState()).toBe("ready");
  });

  it("recreates one expired session and retries the affected action once", async () => {
    const manager = new RuntimeManager();
    const create = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("runtime-expired")
      .mockResolvedValueOnce("runtime-fresh");
    const action = vi.fn(async (runtimeSessionId: string) => {
      if (runtimeSessionId === "runtime-expired") {
        throw Object.assign(new Error("Runtime session not found."), { status: 404 });
      }
      return "activated";
    });

    await expect(manager.runWithSession("account:business", create, action)).resolves.toBe(
      "activated"
    );
    expect(create).toHaveBeenCalledTimes(2);
    expect(action).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    "renews an exhausted session before repeating an unexecuted turn (message envelope: %s)",
    async (envelope) => {
      const manager = new RuntimeManager();
      const create = vi.fn().mockResolvedValueOnce("exhausted").mockResolvedValueOnce("fresh");
      const rejected = {
        turn: {
          status: "rate_limited",
          plan: { executedAt: null, validationErrors: ["Runtime session turn limit reached."] }
        }
      };
      const action = vi
        .fn()
        .mockResolvedValueOnce(envelope ? { runtime: rejected } : rejected)
        .mockResolvedValueOnce("completed");
      await expect(manager.runWithSession("shop", create, action)).resolves.toBe("completed");
      expect(action.mock.calls).toEqual([["exhausted"], ["fresh"]]);
    }
  );

  it("rotates after the final successful turn without repeating its message", async () => {
    const manager = new RuntimeManager();
    const create = vi.fn().mockResolvedValueOnce("old").mockResolvedValueOnce("new");
    const action = vi.fn(async (id: string) => ({
      runtime: { session: { id, turnCount: id === "old" ? 20 : 1 }, turn: { status: "completed" } }
    }));
    await manager.runWithSession("shop", create, action);
    manager.adoptSession("shop", "old");
    await manager.runWithSession("shop", create, action);
    expect(action.mock.calls).toEqual([["old"], ["new"]]);
  });

  it("renews after a confirmation exhausts the adopted session", async () => {
    const manager = new RuntimeManager();
    manager.adoptSession("shop", "confirmed", 20);
    const create = vi.fn(async () => "fresh");
    await expect(manager.ensureSession("shop", create)).resolves.toBe("fresh");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not repeat a completed action or another rate limit", async () => {
    const manager = new RuntimeManager();
    const create = vi.fn(async () => "runtime");
    for (const result of [
      { turn: { status: "completed", plan: { executedAt: "now", validationErrors: [] } } },
      {
        turn: {
          status: "rate_limited",
          plan: { executedAt: null, validationErrors: ["Too many requests"] }
        }
      }
    ]) {
      const action = vi.fn(async () => result);
      await expect(manager.runWithSession("shop", create, action)).resolves.toBe(result);
      expect(action).toHaveBeenCalledTimes(1);
    }
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not classify unrelated request failures as expired sessions", () => {
    expect(
      isExpiredRuntimeSessionError(Object.assign(new Error("Product not found"), { status: 404 }))
    ).toBe(false);
    expect(isExpiredRuntimeSessionError(Object.assign(new Error("Offline"), { status: 503 }))).toBe(
      false
    );
  });
});
