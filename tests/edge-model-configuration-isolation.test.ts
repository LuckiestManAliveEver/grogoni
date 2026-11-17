import { expect, it } from "vitest";
import { createEdgeModelRuntime } from "../services/api/src/edge-store-dependencies";
import { createCp2Store } from "../services/api/src/cp2/store";

it("keeps account inboxes available when hosted provider configuration is invalid", async () => {
  const runtime = createEdgeModelRuntime({ OPENROUTER_MODELS: "invalid JSON" });
  const store = createCp2Store({
    configuredModels: runtime.catalog(),
    modelRuntimeAdapterResolver: runtime.resolve
  });
  const account = store.continueWithChannelPin({
    channel: "phone",
    destination: "+442079460551",
    pin: "3927"
  });
  expect(
    store
      .listConversations({ sessionId: account.session.id })
      .some((conversation) => conversation.isPermanentDaemon)
  ).toBe(true);
  const context = { modelId: "gpt-6-luna", shopId: "shop", agentId: "agent" };
  const adapter = runtime.resolve({ modelId: context.modelId, executionTarget: "backend" })!;
  expect(await adapter.canRun(context)).toMatchObject({
    available: false,
    errorCode: "MODEL_CONFIGURATION_INVALID"
  });
  await expect(
    adapter.generate({
      context,
      prompt: { message: "hello", allowedTools: [], schemaVersion: "cp11-runtime-model-v1" }
    })
  ).rejects.toMatchObject({ code: "MODEL_CONFIGURATION_INVALID" });
});

it("logs an invalid speed setting loudly and disables only inference", async () => {
  const logged: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => void logged.push(String(line));
  try {
    const runtime = createEdgeModelRuntime({
      OPENROUTER_API_KEY: "k",
      OPENROUTER_PROVIDER_SORT: "fastest"
    });
    const adapter = runtime.resolve({ modelId: "gpt-6-luna", executionTarget: "backend" })!;
    expect(
      await adapter.canRun({ modelId: "gpt-6-luna", shopId: "shop", agentId: "agent" })
    ).toMatchObject({ available: false, errorCode: "MODEL_CONFIGURATION_INVALID" });
  } finally {
    console.error = original;
  }
  expect(logged.some((line) => line.includes("openrouter_configuration_invalid"))).toBe(true);
  expect(logged.some((line) => line.includes("OPENROUTER_PROVIDER_SORT"))).toBe(true);
  expect(logged.join("\n")).not.toContain('"k"');
});
