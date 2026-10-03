import { describe, expect, it, vi } from "vitest";
import { createIntervalRunner } from "./interval-runner.js";

describe("createIntervalRunner", () => {
  it("runs immediately on start by default and reports the result", async () => {
    const onResult = vi.fn();
    const run = vi.fn(async () => "ok");
    const runner = createIntervalRunner({ job: "test", intervalMs: 60_000, run, onResult });
    await runner.runNow();
    expect(run).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith("ok");
    await runner.stop();
  });

  it("does not run on start when runOnStart is false", async () => {
    const run = vi.fn(async () => "ok");
    const runner = createIntervalRunner({
      job: "test",
      intervalMs: 60_000,
      run,
      runOnStart: false
    });
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    await runner.stop();
  });

  it("collapses an overlapping tick into the same in-flight run", async () => {
    let releaseRun!: () => void;
    const run = vi.fn(() => new Promise<string>((resolve) => (releaseRun = () => resolve("ok"))));
    const runner = createIntervalRunner({
      job: "test",
      intervalMs: 60_000,
      run,
      runOnStart: false
    });

    const first = runner.runNow();
    const second = runner.runNow();
    expect(run).toHaveBeenCalledTimes(1);
    releaseRun();
    await expect(first).resolves.toBe("ok");
    await expect(second).resolves.toBe("ok");
    await runner.stop();
  });

  it("reports a failure via onError and resolves runNow to null instead of throwing", async () => {
    const onError = vi.fn();
    const run = vi.fn(async () => {
      throw new Error("boom");
    });
    const runner = createIntervalRunner({ job: "test", intervalMs: 60_000, run, onError });
    const result = await runner.runNow();
    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "boom" }));
    await runner.stop();
  });

  it("routes the run through timeScheduledJob when supplied", async () => {
    const timeScheduledJobMock = vi.fn((_job: string, fn: () => Promise<unknown>) => fn());
    const timeScheduledJob = timeScheduledJobMock as unknown as <R>(
      job: string,
      fn: () => Promise<R>
    ) => Promise<R>;
    const run = vi.fn(async () => "ok");
    const runner = createIntervalRunner({
      job: "grogoniid_cooldown",
      intervalMs: 60_000,
      run,
      timeScheduledJob
    });
    await runner.runNow();
    expect(timeScheduledJobMock).toHaveBeenCalledWith("grogoniid_cooldown", run);
    await runner.stop();
  });

  it("stops accepting new runs after stop() and awaits the in-flight run", async () => {
    let releaseRun!: () => void;
    const run = vi.fn(() => new Promise<string>((resolve) => (releaseRun = () => resolve("ok"))));
    const runner = createIntervalRunner({
      job: "test",
      intervalMs: 60_000,
      run,
      runOnStart: false
    });

    const inFlight = runner.runNow();
    const stopPromise = runner.stop();
    releaseRun();
    await inFlight;
    await stopPromise;

    const result = await runner.runNow();
    expect(result).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
