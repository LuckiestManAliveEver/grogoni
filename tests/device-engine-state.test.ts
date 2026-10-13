import { describe, expect, it } from "vitest";
import {
  idleLoadedDeviceModel,
  noteDeviceModelReady,
  whileDeviceGenerating
} from "../apps/web/src/device-models";

describe("on-device engine state for background work", () => {
  it("offers only a loaded model, and only while nothing is generating on it", async () => {
    noteDeviceModelReady(null);
    expect(idleLoadedDeviceModel()).toBeNull();
    noteDeviceModelReady("Qwen-MLC");
    expect(idleLoadedDeviceModel()).toBe("Qwen-MLC");
    let finish: () => void = () => {};
    const chat = whileDeviceGenerating(() => new Promise<void>((resolve) => (finish = resolve)));
    expect(idleLoadedDeviceModel()).toBeNull();
    finish();
    await chat;
    expect(idleLoadedDeviceModel()).toBe("Qwen-MLC");
    await expect(
      whileDeviceGenerating(async () => {
        throw new Error("generation failed");
      })
    ).rejects.toThrow("generation failed");
    expect(idleLoadedDeviceModel()).toBe("Qwen-MLC");
    noteDeviceModelReady(null);
  });
});
