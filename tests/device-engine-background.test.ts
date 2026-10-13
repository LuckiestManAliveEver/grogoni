// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The real engine (device-model-engine.ts) over a fake WebLLM whose loads finish only when the
 * test says so. Pins the rule the daemon browser lane relies on: background generation runs only
 * on the model already loaded and idle, and is never offered a model another load is replacing.
 */
const fake = vi.hoisted(() => {
  const live = new Set<string>();
  const created: string[] = [];
  const pending = new Map<string, (() => void)[]>();
  let count = 0;
  return {
    live,
    created,
    pending,
    finishLoad(id: string) {
      const finish = pending.get(id)?.shift();
      if (!finish) throw new Error(`no pending load of ${id}`);
      finish();
    },
    module: {
      prebuiltAppConfig: {
        model_list: ["A", "B"].map((id) => ({
          model_id: id,
          model: `https://huggingface.co/mlc-ai/${id}`,
          model_lib: "x"
        }))
      },
      CreateMLCEngine(id: string) {
        const name = `${id}${++count}`;
        created.push(name);
        live.add(name);
        return new Promise((resolve) => {
          const list = pending.get(id) ?? [];
          list.push(() =>
            resolve({
              unload: async () => {
                live.delete(name);
              },
              interruptGenerate: () => undefined,
              chat: {
                completions: {
                  create: async () =>
                    (async function* () {
                      yield { choices: [{ delta: { content: `from ${name}` } }] };
                    })()
                }
              }
            })
          );
          pending.set(id, list);
        });
      },
      deleteModelAllInfoInCache: async () => undefined
    }
  };
});
vi.mock("@mlc-ai/web-llm", () => fake.module);

import { idleLoadedDeviceModel, writeInstalledDeviceModels } from "../apps/web/src/device-models";
import {
  installDeviceModel,
  resetDeviceModelEngineForTests,
  runDeviceGeneration,
  runLoadedDeviceGeneration
} from "../apps/web/src/device-model-engine";

const job = (id: string) => ({
  providerModelId: id,
  messages: [{ role: "user" as const, content: "hi" }],
  generation: { maxOutputTokens: 10, temperature: 0, jsonOutput: false }
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("on-device engine for background work", () => {
  beforeEach(() => {
    resetDeviceModelEngineForTests();
    fake.live.clear();
    fake.created.length = 0;
    fake.pending.clear();
    Object.defineProperty(navigator, "gpu", { value: {}, configurable: true });
    writeInstalledDeviceModels(["A"]);
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, "gpu");
    resetDeviceModelEngineForTests();
  });

  it("offers the chat's model only once loaded, and runs background work on it without loading", async () => {
    expect(idleLoadedDeviceModel()).toBeNull();
    await expect(runLoadedDeviceGeneration(job("A"), () => undefined)).rejects.toMatchObject({
      code: "MODEL_NOT_LOADED"
    });
    expect(fake.created).toEqual([]);
    const chat = runDeviceGeneration(job("A"), () => undefined);
    await settle();
    expect(idleLoadedDeviceModel()).toBeNull();
    fake.finishLoad("A");
    await chat;
    expect(idleLoadedDeviceModel()).toBe("A");
    const background = await runLoadedDeviceGeneration(job("A"), () => undefined);
    expect(background.text).toBe(`from ${fake.created[0]}`);
    expect(fake.created).toHaveLength(1);
  });

  it("refuses background work while a chat generation is running on the loaded model", async () => {
    const first = runDeviceGeneration(job("A"), () => undefined);
    await settle();
    fake.finishLoad("A");
    await first;
    // A chat turn in progress (the fake's generation is instant, so hold the engine busy).
    let release: () => void = () => {};
    const { whileDeviceGenerating } = await import("../apps/web/src/device-models");
    const chat = whileDeviceGenerating(() => new Promise<void>((resolve) => (release = resolve)));
    await expect(runLoadedDeviceGeneration(job("A"), () => undefined)).rejects.toMatchObject({
      code: "MODEL_NOT_LOADED"
    });
    release();
    await chat;
    await expect(runLoadedDeviceGeneration(job("A"), () => undefined)).resolves.toMatchObject({
      text: expect.stringMatching(/^from A/u)
    });
  });

  it("marks the engine busy for the whole of every generation", async () => {
    const chat = runDeviceGeneration(job("A"), () => undefined);
    await settle();
    // Still loading inside the generation: busy, so nothing is offered.
    expect(idleLoadedDeviceModel()).toBeNull();
    fake.finishLoad("A");
    await chat;
    expect(idleLoadedDeviceModel()).toBe("A");
  });

  it("stops offering a model the moment another starts loading, and never loads a second copy", async () => {
    const chat = runDeviceGeneration(job("A"), () => undefined);
    await settle();
    fake.finishLoad("A");
    await chat;
    // The person installs B: a download that can take minutes.
    const install = installDeviceModel("B", () => undefined);
    await settle();
    expect(idleLoadedDeviceModel()).toBeNull();
    await expect(runLoadedDeviceGeneration(job("A"), () => undefined)).rejects.toMatchObject({
      code: "MODEL_NOT_LOADED"
    });
    fake.finishLoad("B");
    await install;
    await settle();
    // One engine per model ever created, and only B left in memory.
    expect(fake.created.map((name) => name[0])).toEqual(["A", "B"]);
    expect([...fake.live].map((name) => name[0])).toEqual(["B"]);
    expect(idleLoadedDeviceModel()).toBe("B");
  });
});
