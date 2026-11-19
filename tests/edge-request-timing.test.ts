import { describe, expect, it } from "vitest";
import {
  currentRequestTiming,
  recordStage,
  runWithRequestTiming,
  serverTimingHeader,
  timeStage
} from "../services/api/src/edge-request-timing";

describe("Edge request stage timing", () => {
  it("records stages per request and formats a Server-Timing header ending in total", async () => {
    const header = await runWithRequestTiming(async () => {
      recordStage("txOpen", 12.34);
      await timeStage("load", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      // A retried attempt adds to the same stage instead of replacing it.
      recordStage("txOpen", 1);
      return serverTimingHeader(currentRequestTiming()!);
    });
    const entries = header.split(", ");
    expect(entries[0]).toBe("txOpen;dur=13.3");
    expect(entries[1]).toMatch(/^load;dur=\d+\.\d$/u);
    expect(Number(entries[1]!.split("=")[1])).toBeGreaterThanOrEqual(4);
    expect(entries.at(-1)).toMatch(/^total;dur=\d+\.\d$/u);
  });

  it("keeps concurrent requests apart", async () => {
    const [a, b] = await Promise.all([
      runWithRequestTiming(async () => {
        recordStage("load", 1);
        await new Promise((resolve) => setTimeout(resolve, 2));
        return [...currentRequestTiming()!.stages.keys()];
      }),
      runWithRequestTiming(async () => {
        recordStage("persist", 1);
        await new Promise((resolve) => setTimeout(resolve, 1));
        return [...currentRequestTiming()!.stages.keys()];
      })
    ]);
    expect(a).toEqual(["load"]);
    expect(b).toEqual(["persist"]);
  });

  it("ignores stages outside a request and rejects names that are not plain tokens", async () => {
    recordStage("load", 5);
    expect(currentRequestTiming()).toBeUndefined();
    await expect(timeStage("load", () => 7)).resolves.toBe(7);
    const keys = await runWithRequestTiming(async () => {
      recordStage("load, evil=1", 1);
      recordStage("bad name", 1);
      recordStage("nan", Number.NaN);
      return [...currentRequestTiming()!.stages.keys()];
    });
    expect(keys).toEqual([]);
  });

  it("still records a stage whose work throws", async () => {
    const keys = await runWithRequestTiming(async () => {
      await expect(timeStage("handler", () => Promise.reject(new Error("failed")))).rejects.toThrow(
        "failed"
      );
      return [...currentRequestTiming()!.stages.keys()];
    });
    expect(keys).toEqual(["handler"]);
  });
});
