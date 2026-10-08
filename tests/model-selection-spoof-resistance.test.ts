import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeModelProvider } from "../packages/shared-types/src";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("model selection spoof resistance", () => {
  it("uses an explicitly selected hosted adapter without a local prerequisite and ignores per-turn model spoofing", async () => {
    const { createCp2Store } = await import("../services/api/src/cp2/store");
    const resolvedModelIds: string[] = [];
    // smollm2-360m is the platform-included source: "hosted" catalog model (format: "remote", no
    // downloadable artifact) - it can only run through a server-reachable target, never a
    // per-device install, which is exactly the property this test exercises.
    const hostedProvider: RuntimeModelProvider = {
      name: "llama.cpp",
      async complete() {
        return {
          provider: "llama.cpp",
          status: "available",
          outputText: JSON.stringify({
            type: "response",
            message: "Local inference handled the request."
          }),
          durationMs: 1,
          errorCode: null,
          metadata: {}
        };
      }
    };
    const store = createCp2Store({
      runtimeModelProviderResolver(modelId) {
        resolvedModelIds.push(modelId);
        return modelId === "smollm2-360m" ? hostedProvider : undefined;
      }
    });
    const auth = store.signupWithPhonePin({ destination: "+254700799991", pin: "2468" });
    const created = store.createBusiness({
      sessionId: auth.session.id,
      name: "Cross Device Shop",
      language: "en"
    });
    store.activateAiModel({
      sessionId: auth.session.id,
      businessId: created.business.id,
      modelId: "smollm2-360m"
    });
    expect(
      store.updateAgentProfile({
        sessionId: auth.session.id,
        businessId: created.business.id,
        profile: {
          name: "Cross Device Agent",
          description: "Local-first shop agent",
          modelId: "smollm2-360m",
          role: "Business assistant",
          language: "en",
          personality: "Careful",
          instructions: "Use the downloaded model first when it is available.",
          knowledge: "Use saved shop records.",
          tools: [],
          integrations: [],
          contextScripts: [],
          status: "active"
        }
      }).modelId
    ).toBe("smollm2-360m");

    expect(
      store.getActiveAiModel({
        sessionId: auth.session.id,
        businessId: created.business.id
      }).modelId
    ).toBe("smollm2-360m");

    const turn = await store.createRuntimeTurn({
      sessionId: auth.session.id,
      businessId: created.business.id,
      message: "Summarize my shop.",
      agentProfile: {
        behavior: "Concise",
        contextScripts: [],
        integrations: [],
        knowledge: "Use saved shop records.",
        model: "smollm2-360m",
        role: "Business assistant",
        instructions: "Help with shop operations.",
        tools: []
      }
    });
    expect(resolvedModelIds).toContain("smollm2-360m");
    expect(turn.turn).toMatchObject({
      model: { provider: "llama.cpp", status: "available" },
      response: "Local inference handled the request."
    });

    resolvedModelIds.length = 0;
    const spoofedLocalSelection = await store.createRuntimeTurn({
      sessionId: auth.session.id,
      businessId: created.business.id,
      message: "Keep this request on Grogoni.",
      agentProfile: {
        behavior: "Concise",
        contextScripts: [],
        integrations: [],
        knowledge: "Use saved shop records.",
        model: "grogoniclaw-local",
        role: "Business assistant",
        instructions: "Help with shop operations.",
        tools: []
      }
    });
    expect(resolvedModelIds).toEqual(["smollm2-360m"]);
    expect(spoofedLocalSelection.turn.model).toMatchObject({
      provider: "llama.cpp",
      status: "available"
    });
  }, 15_000);
});
