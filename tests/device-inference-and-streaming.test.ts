import { describe, expect, it } from "vitest";

import { createRuntimeReplyTextStream } from "../packages/tool-core/src";
import { DeviceInferenceBroker } from "../services/api/src/inference/device-inference-broker";
import { InferenceError } from "../services/api/src/inference/providers/errors";
import {
  createMemoryRequestRateLimiter,
  createRedisRequestRateLimiter,
  type RateLimitRedis
} from "../services/api/src/inference/providers/usage-policy";
import { TurnStreamHub } from "../services/api/src/inference/turn-stream";

function dispatch(
  broker: DeviceInferenceBroker,
  overrides: Partial<Parameters<DeviceInferenceBroker["dispatch"]>[0]> = {}
) {
  return broker.dispatch({
    accountId: "account-a",
    turnId: "turn-aaaaaaaa",
    modelId: "qwen-device",
    providerModelId: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC",
    executionTarget: "browser-local",
    messages: [{ role: "user", content: "hello" }],
    generation: { maxOutputTokens: 64, temperature: 0.2, jsonOutput: true },
    ...overrides
  });
}

const claimAs = (
  broker: DeviceInferenceBroker,
  extra: Partial<Parameters<DeviceInferenceBroker["claim"]>[0]> = {}
) =>
  broker.claim({
    accountId: "account-a",
    runtime: "browser-local",
    availableModelIds: new Set(["Qwen2.5-0.5B-Instruct-q4f16_1-MLC"]),
    waitMs: 20,
    ...extra
  });

describe("device inference broker", () => {
  it("hands a job only to the right account, model, runtime and turn", async () => {
    const broker = new DeviceInferenceBroker({ claimTimeoutMs: 2_000 });
    const pending = dispatch(broker, { executionTarget: "installed-app" });
    expect(await claimAs(broker, { accountId: "account-b" })).toBeNull();
    expect(await claimAs(broker, { availableModelIds: new Set(["other"]) })).toBeNull();
    expect(await claimAs(broker, { turnId: "turn-bbbbbbbb" })).toBeNull();
    // An installed-app model is not handed to a plain browser tab.
    expect(await claimAs(broker)).toBeNull();
    const job = await claimAs(broker, { runtime: "installed-app", turnId: "turn-aaaaaaaa" });
    expect(job).toMatchObject({ modelId: "qwen-device", turnId: "turn-aaaaaaaa" });
    // A claimed job is never handed out twice.
    expect(await claimAs(broker, { runtime: "installed-app" })).toBeNull();
    broker.complete("account-a", job!.id, {
      token: job!.token,
      text: "hi",
      usage: { inputTokens: 3, outputTokens: 1 }
    });
    await expect(pending).resolves.toEqual({
      text: "hi",
      usage: { inputTokens: 3, outputTokens: 1 }
    });
    expect(broker.openJobCount()).toBe(0);
  });

  it("wakes a waiting device as soon as a job is dispatched", async () => {
    const broker = new DeviceInferenceBroker();
    const waiting = claimAs(broker, { waitMs: 5_000 });
    const pending = dispatch(broker);
    const job = await waiting;
    expect(job).not.toBeNull();
    broker.complete("account-a", job!.id, { token: job!.token, text: "done" });
    await expect(pending).resolves.toMatchObject({ text: "done" });
  });

  it("rejects forged tokens, other accounts, oversized output and replays identically", async () => {
    const broker = new DeviceInferenceBroker();
    const pending = dispatch(broker);
    const job = (await claimAs(broker))!;
    for (const attempt of [
      () => broker.complete("account-b", job.id, { token: job.token, text: "x" }),
      () => broker.complete("account-a", job.id, { token: "AAAA", text: "x" }),
      () => broker.complete("account-a", "missing", { token: job.token, text: "x" })
    ]) {
      expect(attempt).toThrow(expect.objectContaining({ statusCode: 404 }));
    }
    expect(() =>
      broker.complete("account-a", job.id, { token: job.token, text: "x".repeat(70_000) })
    ).toThrow(expect.objectContaining({ statusCode: 400 }));
    broker.complete("account-a", job.id, { token: job.token, text: "ok" });
    await pending;
    expect(() => broker.complete("account-a", job.id, { token: job.token, text: "again" })).toThrow(
      expect.objectContaining({ statusCode: 404 })
    );
  });

  it("fails clearly when no device claims, when the device fails, and when cancelled", async () => {
    const broker = new DeviceInferenceBroker({ claimTimeoutMs: 15, completionTimeoutMs: 15 });
    await expect(dispatch(broker)).rejects.toMatchObject({ code: "LOCAL_DEVICE_UNAVAILABLE" });

    const failed = dispatch(broker);
    const job = (await claimAs(broker))!;
    broker.fail("account-a", job.id, job.token);
    await expect(failed).rejects.toMatchObject({ code: "INFERENCE_FAILED" });

    const stalled = dispatch(broker);
    await claimAs(broker);
    await expect(stalled).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });

    const controller = new AbortController();
    const cancelled = dispatch(broker, { signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(InferenceError);
    expect(broker.openJobCount()).toBe(0);
  });
});

describe("reply streaming", () => {
  function feed(chunks: string[]) {
    const stream = createRuntimeReplyTextStream();
    return { text: chunks.map((chunk) => stream.push(chunk)).join(""), stream };
  }

  it("streams only the message text of a JSON response, across arbitrary chunk splits", () => {
    const raw = '{"type":"response","message":"Habari! \\"Sugar\\" is 150\\nKES \\u00e9"}';
    for (const size of [1, 2, 3, 7, raw.length]) {
      const chunks = raw.match(new RegExp(`[\\s\\S]{1,${size}}`, "gu")) ?? [];
      expect(feed(chunks).text).toBe('Habari! "Sugar" is 150\nKES é');
    }
    expect(feed(['{"message":"Which product?",', '"type":"clarification"}']).text).toBe(
      "Which product?"
    );
  });

  it("never streams a tool proposal, and passes plain text through", () => {
    const tool = feed([
      '{"type":"tool","toolName":"product.delete",',
      '"input":{},"reason":"Delete it"}'
    ]);
    expect(tool.text).toBe("");
    expect(tool.stream.isToolProposal).toBe(true);
    expect(feed(["  Hello ", "there"]).text).toBe("Hello there");
  });

  it("keeps each account's turn stream private and buffers early events", () => {
    const hub = new TurnStreamHub();
    const publisher = hub.replyPublisher("account-a", "turn-12345678")!;
    publisher.raw('{"type":"response","message":"Hi');
    const seenByA: unknown[] = [];
    const seenByB: unknown[] = [];
    hub.subscribe("account-a", "turn-12345678", (event) => seenByA.push(event));
    hub.subscribe("account-b", "turn-12345678", (event) => seenByB.push(event));
    publisher.raw(' there"}');
    publisher.reset();
    expect(seenByA).toEqual([
      { type: "text", text: "Hi" },
      { type: "text", text: " there" },
      { type: "reset" }
    ]);
    expect(seenByB).toEqual([]);
    expect(hub.replyPublisher(undefined, "turn-12345678")).toBeNull();
  });
});

describe("shared request rate limits", () => {
  it("counts across instances through Redis and falls back when Redis is down", async () => {
    const store = new Map<string, number>();
    const redis: RateLimitRedis = {
      multi() {
        const ops: Array<() => unknown> = [];
        const pipeline = {
          incr(key: string) {
            ops.push(() => {
              store.set(key, (store.get(key) ?? 0) + 1);
              return store.get(key);
            });
            return pipeline;
          },
          pexpire() {
            ops.push(() => 1);
            return pipeline;
          },
          async exec() {
            return ops.map((op) => [null, op()] as [Error | null, unknown]);
          }
        };
        return pipeline;
      }
    };
    const now = () => 1_000_000;
    const instanceA = createRedisRequestRateLimiter(redis, { now });
    const instanceB = createRedisRequestRateLimiter(redis, { now });
    expect((await instanceA.hit("shop|user", 2, 60_000)).allowed).toBe(true);
    expect((await instanceB.hit("shop|user", 2, 60_000)).allowed).toBe(true);
    const third = await instanceA.hit("shop|user", 2, 60_000);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterMs).toBeGreaterThan(0);

    const broken: RateLimitRedis = {
      multi() {
        const pipeline = {
          incr: () => pipeline,
          pexpire: () => pipeline,
          exec: async () => {
            throw new Error("ECONNREFUSED");
          }
        };
        return pipeline;
      }
    };
    const degraded = createRedisRequestRateLimiter(broken, {
      now,
      fallback: createMemoryRequestRateLimiter(now)
    });
    expect((await degraded.hit("k", 1, 60_000)).allowed).toBe(true);
    expect((await degraded.hit("k", 1, 60_000)).allowed).toBe(false);
  });
});
