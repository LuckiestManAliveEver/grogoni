import { describe, expect, it, vi } from "vitest";
import type { RuntimePlannedAction } from "../packages/shared-types/src";
import { executeRuntimeCapability } from "../services/api/src/cp2/domains/agent-runtime/capabilities";
import type { AgentRuntimeDomainDeps } from "../services/api/src/cp2/domains/agent-runtime/store";
import { validateRuntimeToolInput } from "../packages/tool-core/src/validation/runtime";

const action = (input: Record<string, unknown>) =>
  ({
    id: "open-retailer",
    toolName: "commerce.website.open",
    input
  }) as RuntimePlannedAction;

describe("on-demand retailer browser access", () => {
  it("creates an isolated session and navigates using the existing browser capability", async () => {
    const executeComputerCapability = vi.fn(async ({ action: next }) =>
      next.toolName === "computer.session.create"
        ? { id: "isolated-retailer" }
        : { url: next.input.url }
    );
    const result = await executeRuntimeCapability(
      { executeComputerCapability } as unknown as AgentRuntimeDomainDeps,
      {
        sessionId: "buyer-session",
        businessId: "buyer-business",
        conversationId: "chat",
        action: action({ url: "https://retailer.example/shoes" }),
        now: new Date()
      }
    );
    expect(executeComputerCapability).toHaveBeenCalledTimes(2);
    expect(executeComputerCapability.mock.calls[1]?.[0].action).toMatchObject({
      toolName: "computer.navigate",
      input: { sessionId: "isolated-retailer", url: "https://retailer.example/shoes" }
    });
    expect(result).toMatchObject({ sessionId: "isolated-retailer", paymentProcessed: false });
  });

  it("reuses the customer's browser session", async () => {
    const executeComputerCapability = vi.fn(async () => ({}));
    await executeRuntimeCapability(
      { executeComputerCapability } as unknown as AgentRuntimeDomainDeps,
      {
        sessionId: "buyer-session",
        businessId: "buyer-business",
        action: action({ url: "https://retailer.example/cart", sessionId: "existing" }),
        now: new Date()
      }
    );
    expect(executeComputerCapability).toHaveBeenCalledTimes(1);
    expect(executeComputerCapability.mock.calls[0]?.[0]).toMatchObject({
      action: { toolName: "computer.navigate", input: { sessionId: "existing" } }
    });
  });

  it("reports an unavailable browser without claiming a connection", async () => {
    await expect(
      executeRuntimeCapability({} as AgentRuntimeDomainDeps, {
        sessionId: "buyer-session",
        businessId: "buyer-business",
        action: action({ url: "https://retailer.example" }),
        now: new Date()
      })
    ).rejects.toMatchObject({ code: "computer_runtime_provider_unconfigured" });
  });

  it.each([
    "javascript:alert(1)",
    "http://retailer.example",
    "https://user:secret@retailer.example"
  ])("rejects unsafe URL %s", (url) => {
    expect(validateRuntimeToolInput("commerce.website.open", { url })).toMatchObject({
      ok: false
    });
  });
});
