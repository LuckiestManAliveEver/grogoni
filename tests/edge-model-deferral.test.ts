import { describe, expect, it, vi } from "vitest";
import {
  ModelCallDeferredError,
  ModelCallLedger,
  maxLiveModelCalls,
  modelCallFingerprint,
  suppressAfterDeferral
} from "../services/api/src/edge-model-deferral";
import {
  ModelRuntimeError,
  type ModelRuntimeAdapter
} from "../services/api/src/inference/model-runtime";
import { createOpenRouterModelAdapter } from "../services/api/src/inference/openrouter-model-runtime";
import { isEdgeFastPathWrite, mayRetryRequest } from "../services/api/src/edge-domain-routes";

const resolverInput = {
  modelId: "gpt-6-luna",
  executionTarget: "backend" as const,
  agentId: "agent-1",
  shopId: "shop-1"
};
const context = { agentId: "agent-1", shopId: "shop-1", modelId: "gpt-6-luna" };
const prompt = (message: string) =>
  ({ message, conversationHistory: [] }) as unknown as Parameters<
    ModelRuntimeAdapter["generate"]
  >[0]["prompt"];

function fakeAdapter(generate: ModelRuntimeAdapter["generate"]): ModelRuntimeAdapter {
  return {
    provider: "fake",
    executionTarget: "backend",
    canRun: async () => ({ available: true, errorCode: null, message: null }),
    healthCheck: async () => ({
      available: true,
      errorCode: null,
      message: null,
      modelId: "gpt-6-luna",
      provider: "fake",
      executionTarget: "backend",
      latencyMs: 1,
      responsePreview: null,
      retryable: false
    }),
    generate
  };
}

const answer = (text: string) => ({
  text,
  modelId: "gpt-6-luna",
  provider: "fake",
  executionTarget: "backend" as const,
  latencyMs: 1
});

describe("Edge model call deferral", () => {
  it("never calls the provider inside an attempt; the call runs between attempts and is replayed", async () => {
    const generate = vi.fn(async () => answer("hi"));
    const ledger = new ModelCallLedger(() => fakeAdapter(generate));
    ledger.beginAttempt();
    const adapter = ledger.resolver()(resolverInput)!;
    await expect(adapter.generate({ context, prompt: prompt("hello") })).rejects.toBeInstanceOf(
      ModelCallDeferredError
    );
    expect(generate).not.toHaveBeenCalled();
    expect(ledger.pending?.kind).toBe("generate");
    // A deferred attempt answers nothing more, even a call it could replay.
    await expect(adapter.generate({ context, prompt: prompt("hello") })).rejects.toBeInstanceOf(
      ModelCallDeferredError
    );
    await ledger.callLive();
    expect(generate).toHaveBeenCalledTimes(1);
    ledger.beginAttempt();
    const replay = ledger.resolver()(resolverInput)!;
    await expect(replay.generate({ context, prompt: prompt("hello") })).resolves.toMatchObject({
      text: "hi"
    });
    expect(ledger.pending).toBeNull();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(ledger.replayed).toBe(1);
  });

  it("drops a recording whose input changed between attempts and asks again", async () => {
    const generate = vi.fn(async (input: { prompt: { message: string } }) =>
      answer(`re: ${input.prompt.message}`)
    );
    const ledger = new ModelCallLedger(() => fakeAdapter(generate as never));
    ledger.beginAttempt();
    await ledger
      .resolver()(resolverInput)!
      .generate({ context, prompt: prompt("stock is 5") })
      .catch(() => {});
    await ledger.callLive();
    ledger.beginAttempt();
    await expect(
      ledger
        .resolver()(resolverInput)!
        .generate({ context, prompt: prompt("stock is 4") })
    ).rejects.toBeInstanceOf(ModelCallDeferredError);
    expect(ledger.mismatched).toBe(1);
    await ledger.callLive();
    ledger.beginAttempt();
    await expect(
      ledger
        .resolver()(resolverInput)!
        .generate({ context, prompt: prompt("stock is 4") })
    ).resolves.toMatchObject({ text: "re: stock is 4" });
  });

  it("masks only per-attempt IDs and clocks in the fingerprint", () => {
    const a = modelCallFingerprint("generate", resolverInput, {
      prompt: "turn 1b4e28ba-2fa1-11d2-883f-0016d3cca427 at 2026-10-17T10:00:00.000Z"
    });
    const b = modelCallFingerprint("generate", resolverInput, {
      prompt: "turn 6f1e2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b at 2026-10-17T10:00:05.123Z"
    });
    const c = modelCallFingerprint("generate", resolverInput, {
      prompt: "turn 6f1e2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b at 2026-10-17T10:00:05.123Z, 3 items"
    });
    expect(a).toBe(b);
    expect(c).not.toBe(b);
  });

  it("replays a provider error as the same error, and stops after its live-call budget", async () => {
    const generate = vi.fn(async () => {
      throw new ModelRuntimeError("PROVIDER_UNAVAILABLE", "down", true);
    });
    const ledger = new ModelCallLedger(() => fakeAdapter(generate));
    ledger.beginAttempt();
    await ledger
      .resolver()(resolverInput)!
      .generate({ context, prompt: prompt("x") })
      .catch(() => {});
    await ledger.callLive();
    ledger.beginAttempt();
    await expect(
      ledger
        .resolver()(resolverInput)!
        .generate({ context, prompt: prompt("x") })
    ).rejects.toMatchObject({
      name: "ModelRuntimeError",
      code: "PROVIDER_UNAVAILABLE",
      retryable: true
    });

    const changing = new ModelCallLedger(() => fakeAdapter(async () => answer("ok")));
    for (let call = 0; call < maxLiveModelCalls; call += 1) {
      changing.beginAttempt();
      await changing
        .resolver()(resolverInput)!
        .generate({ context, prompt: prompt(`data ${call}`) })
        .catch(() => {});
      await changing.callLive();
    }
    changing.beginAttempt();
    await changing
      .resolver()(resolverInput)!
      .generate({ context, prompt: prompt("data again") })
      .catch(() => {});
    await expect(changing.callLive()).rejects.toMatchObject({ code: "AGENT_TURN_UNSTABLE" });
  });

  it("gives up on a provider that ignores its signal once the call's limit passes", async () => {
    const ledger = new ModelCallLedger(() => fakeAdapter(() => new Promise(() => {})), {
      timeoutMs: 50
    });
    ledger.beginAttempt();
    await ledger
      .resolver()(resolverInput)!
      .generate({ context, prompt: prompt("x") })
      .catch(() => {});
    await ledger.callLive();
    ledger.beginAttempt();
    await expect(
      ledger
        .resolver()(resolverInput)!
        .generate({ context, prompt: prompt("x") })
    ).rejects.toMatchObject({ code: "INFERENCE_TIMEOUT", retryable: true });
  });

  it("stops outbound senders for the rest of an attempt once it is waiting for a model", async () => {
    const ledger = { pending: null as unknown };
    const send = vi.fn(async () => "sent");
    const gateway = { send: vi.fn(async () => "sent") };
    const guardedSend = suppressAfterDeferral(send, ledger);
    const guardedGateway = suppressAfterDeferral(gateway, ledger);
    await guardedSend();
    await guardedGateway.send();
    ledger.pending = {};
    expect(() => guardedSend()).toThrow(ModelCallDeferredError);
    expect(() => guardedGateway.send()).toThrow(ModelCallDeferredError);
    expect(send).toHaveBeenCalledTimes(1);
    expect(gateway.send).toHaveBeenCalledTimes(1);
  });

  it("relies on an Edge adapter's canRun making no request", async () => {
    const request = vi.fn(async () => {
      throw new Error("canRun must not reach the network");
    });
    const adapter = createOpenRouterModelAdapter({
      modelId: "gpt-6-luna",
      providerModelId: "openai/gpt-6-luna",
      apiKey: "test-key",
      request: request as unknown as typeof fetch
    });
    await expect(adapter.canRun(context)).resolves.toMatchObject({ available: true });
    expect(request).not.toHaveBeenCalled();
  });
});

describe("Edge fast-path writes", () => {
  it("covers read markers, settings and typing, and nothing else", () => {
    expect(isEdgeFastPathWrite("PATCH", "/v1/conversations/c1")).toBe(true);
    expect(isEdgeFastPathWrite("POST", "/v1/conversations/c1/typing")).toBe(true);
    for (const [method, path] of [
      ["POST", "/v1/messages"],
      ["DELETE", "/v1/conversations/c1"],
      ["PATCH", "/v1/conversations/c1/messages/m1"],
      ["POST", "/v1/conversations/c1/restore"],
      ["GET", "/v1/conversations/c1"]
    ])
      expect(isEdgeFastPathWrite(method!, path!), `${method} ${path}`).toBe(false);
  });

  it("reruns a fast path that lost a save race, and no other write", () => {
    const race = Object.assign(new Error("Concurrent snapshot update"), { code: "40001" });
    const clean = { independentWork: false };
    expect(mayRetryRequest("PATCH", "/v1/conversations/c1", clean, race)).toBe(true);
    expect(mayRetryRequest("POST", "/v1/conversations/c1/typing", clean, race)).toBe(true);
    expect(mayRetryRequest("POST", "/v1/messages", clean, race)).toBe(false);
  });
});
