import { describe, expect, it, vi } from "vitest";
import { validateRuntimeToolInput, runtimeToolRegistry } from "../packages/tool-core/src/index";
import { executeRuntimeCapability } from "../services/api/src/cp2/domains/agent-runtime/capabilities";
import type { AgentRuntimeDomainDeps } from "../services/api/src/cp2/domains/agent-runtime/store";

describe("agent market catalogue", () => {
  it("requires review for bulk imports and validates source selections", () => {
    expect(runtimeToolRegistry["catalogue.marketplace.import"].requiresConfirmation).toBe(true);
    for (const productIds of [[], [""], [1], Array(51).fill("product")]) {
      expect(
        validateRuntimeToolInput("catalogue.marketplace.import", {
          sourceBusinessId: "source",
          productIds
        }).ok
      ).toBe(false);
    }
    expect(validateRuntimeToolInput("catalogue.marketplace.products", {}).ok).toBe(false);
    expect(
      validateRuntimeToolInput("catalogue.marketplace.import", {
        sourceBusinessId: "source",
        productIds: ["product"]
      }).ok
    ).toBe(true);
  });

  it("preserves the authenticated destination and exact source selection at dispatch", async () => {
    const marketCatalogue = vi.fn().mockReturnValue([{ id: "created", quantity: 0 }]);
    const input = {
      sessionId: "owner-session",
      businessId: "destination",
      now: new Date(),
      action: {
        toolName: "catalogue.marketplace.import" as const,
        input: { sourceBusinessId: "source", productIds: ["product"] }
      }
    };
    const result = await executeRuntimeCapability(
      { marketCatalogue } as unknown as AgentRuntimeDomainDeps,
      input as Parameters<typeof executeRuntimeCapability>[1]
    );
    expect(marketCatalogue).toHaveBeenCalledWith(input);
    expect(result).toEqual([{ id: "created", quantity: 0 }]);
  });
});
