import { describe, expect, it } from "vitest";
import {
  createCloudRequestQueue,
  isSnapshotRequest
} from "../apps/web/src/lib/cloud-request-queue";

describe("snapshot request coordination", () => {
  it("runs one snapshot request at a time and prioritizes user mutations over waiting reads", async () => {
    const queue = createCloudRequestQueue();
    const started: string[] = [];
    let release: () => void = () => undefined;
    const first = queue(async () => {
      started.push("first read");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await Promise.resolve();
    const read = queue(async () => {
      started.push("background read");
    });
    const turn = queue(async () => {
      started.push("chat turn");
    }, true);
    const confirm = queue(async () => {
      started.push("confirm");
    }, true);
    expect(started).toEqual(["first read"]);
    release();
    await Promise.all([first, read, turn, confirm]);
    expect(started).toEqual(["first read", "chat turn", "confirm", "background read"]);
  });
  it("continues after failure and does not execute an aborted queued request", async () => {
    const queue = createCloudRequestQueue();
    let release: () => void = () => undefined;
    const first = queue(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw new Error("unavailable");
    });
    const failed = expect(first).rejects.toThrow("unavailable");
    await Promise.resolve();
    const controller = new AbortController();
    let ran = false;
    const cancelled = queue(
      async () => {
        ran = true;
      },
      false,
      controller.signal
    );
    const rejected = expect(cancelled).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    const next = queue(async () => "ready");
    release();
    await failed;
    await rejected;
    expect(await next).toBe("ready");
    expect(ran).toBe(false);
  });
  it("keeps leases, authentication, health and live previews independent of snapshot loading", () => {
    for (const path of [
      "/auth/bootstrap",
      "/health",
      "/v1/daemon/claims",
      "/v1/ai/turn-stream/123"
    ])
      expect(isSnapshotRequest(`https://grogoni.com/api${path}`)).toBe(false);
    for (const path of ["/businesses/shop/runtime/turns", "/v1/conversations", "/v1/messages"])
      expect(isSnapshotRequest(`https://grogoni.com/api${path}`)).toBe(true);
  });
});
