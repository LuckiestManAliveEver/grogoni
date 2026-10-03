import { describe, expect, it, vi } from "vitest";
import { startGrogoniIdCooldownRunner } from "../services/api/src/cp2/grogoniid-cooldown-runner";

describe("grogoniId cooldown runner", () => {
  it("runs a release pass on demand and stops cleanly", async () => {
    const releaseExpiredGrogoniIds = vi.fn().mockResolvedValue(2);
    const onResult = vi.fn();
    const runner = startGrogoniIdCooldownRunner({
      store: { releaseExpiredGrogoniIds },
      intervalMs: 60_000,
      runOnStart: false,
      onResult
    });

    await expect(runner.runNow()).resolves.toBe(2);
    expect(releaseExpiredGrogoniIds).toHaveBeenCalledTimes(1);
    expect(releaseExpiredGrogoniIds.mock.calls[0]?.[0]).toMatchObject({
      cooldownMs: expect.any(Number)
    });
    expect(onResult).toHaveBeenCalledWith(2);

    await runner.stop();
    await expect(runner.runNow()).resolves.toBeNull();
  });

  it("contains a failed release pass so later runs can retry", async () => {
    const error = new Error("store unavailable");
    const releaseExpiredGrogoniIds = vi.fn().mockRejectedValue(error);
    const onError = vi.fn();
    const runner = startGrogoniIdCooldownRunner({
      store: { releaseExpiredGrogoniIds },
      intervalMs: 60_000,
      runOnStart: false,
      onError
    });

    await expect(runner.runNow()).resolves.toBeNull();
    expect(onError).toHaveBeenCalledWith(error);
    await runner.stop();
  });

  it("accepts an explicit cooldown duration and passes it through unchanged", async () => {
    const releaseExpiredGrogoniIds = vi.fn().mockResolvedValue(0);
    const runner = startGrogoniIdCooldownRunner({
      store: { releaseExpiredGrogoniIds },
      intervalMs: 60_000,
      cooldownMs: 1_000,
      runOnStart: false
    });

    await runner.runNow();
    expect(releaseExpiredGrogoniIds).toHaveBeenCalledWith({ cooldownMs: 1_000 });
    await runner.stop();
  });
});
